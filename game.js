/* Two-player game: one player shoots while the other films, then they swap.
 *
 * Rules
 *  - A turn is N hits on the paper. Missed the paper, or no beep? Shoot again.
 *  - The shooter scores the rings, exactly as in Live mode.
 *  - Each hit also pays whoever is filming up to CAM_PER_HIT points: half for how steady the
 *    picture was in the 1.5 s before the impact, half for framing at the impact (target centred
 *    and filling 55–95% of the width). So camera points come only with the shooter's hits,
 *    and ending a turn early can't earn the filmer anything.
 *  - A hard jolt hides any hit at that moment, so each jolt costs the filmer JOLT_COST.
 *  - A false hit can be struck out by tapping its chip; ending early needs a second tap and
 *    can be undone from the results card.
 * Loaded after app.js and uses its globals (live, board, addShot, startLive, sound, ...). */
'use strict';

const game = (() => {
  const CAM_PER_HIT = 20;    // 10 steadiness + 10 framing
  const JOLT_COST = 5;
  // Picture speed (px/s at 1x zoom) at which a frame counts half steady. Calibrated on the two
  // hand-held slo-mo clips (median 46 and 78 px/s). Steadiness points then stretch the honest
  // range: 40% steady or worse pays nothing, 95% or better pays full.
  const STEADY_V = 150;
  const steadyPts = (s) => 10 * Math.min(1, Math.max(0, (s - 0.4) / 0.55));
  const HIT_CHOICES = [3, 5, 6, 8, 10, 12, 15, 20];
  const ROUND_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
  const LOCATE_MS = 250;     // framing check rate
  const ICON = {
    shoot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>',
    film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z" fill="currentColor"/></svg>',
  };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x == null || !Number.isFinite(x) ? '–' : Math.round(100 * x) + '%');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = 'game-v2';
  const PHASES = ['setup', 'ready', 'countdown', 'playing', 'results', 'over'];

  // Saved in localStorage after every change, so a reload or a killed Home Screen app keeps the
  // game, including a turn in progress (it resumes after a new countdown).
  // phase: setup -> ready -> countdown -> playing -> results -> ready ... -> over
  // g.turn: the turn being played {hits: [{score, zone, steady, framing, cam, void}], jolts}
  // g.history: finished turns {k, shooter, filmer, hits, jolts, early}
  let g = load();
  let endTimer = 0, confirmUntil = 0, confirmWhat = '', stripAt = 0, countdownId = 0, busy = false;
  let liveSteady = null, lastVetoed = 0, aim = null, locateAt = 0, locating = false;
  let shownPhase = '', phaseAt = 0, endedAt = 0;

  function fresh(prev) {
    return {
      names: prev ? prev.names : [store.get('p1') || 'Player 1', store.get('p2') || 'Player 2'],
      hits: prev ? prev.hits : 10, rounds: prev ? prev.rounds : 3,
      k: 0, history: [], turn: null, phase: 'setup',
    };
  }
  function load() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* none saved */ }
    const ok = v && Array.isArray(v.names) && v.names.length === 2 && Array.isArray(v.history) && v.hits > 0
      && v.rounds > 0 && Number.isInteger(v.k) && v.k >= 0 && v.k <= 2 * v.rounds && PHASES.includes(v.phase);
    if (!ok) return fresh();
    if (v.phase === 'countdown' || v.phase === 'playing') v.phase = 'ready'; // resume after a countdown
    return v;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(g)); } catch (e) { /* private mode */ } }

  const turns = () => 2 * g.rounds;
  const shooter = () => g.k % 2; // player 1 shoots first in every round
  const filmer = () => 1 - shooter();
  const round = () => Math.min(Math.floor(g.k / 2) + 1, g.rounds);
  const counted = (t) => (t ? t.hits.filter((h) => !h.void) : []);
  /** Points of one turn record (finished or in progress). */
  function tally(t) {
    const hits = counted(t);
    return {
      n: hits.length,
      shoot: sum(hits.map((h) => h.score)),
      cam: Math.max(0, sum(hits.map((h) => h.cam)) - JOLT_COST * (t.jolts || 0)),
      best: hits.length ? Math.max(...hits.map((h) => h.score)) : 0,
      onRings: hits.filter((h) => h.score > 0).length,
      steady: mean(hits.map((h) => h.steady).filter(Number.isFinite)),
      framing: mean(hits.map((h) => h.framing).filter(Number.isFinite)),
    };
  }
  function totals() {
    const t = [0, 1].map(() => ({ shoot: 0, cam: 0, total: 0 }));
    const add = (rec, s, f) => { const x = tally(rec); t[s].shoot += x.shoot; t[f].cam += x.cam; };
    for (const h of g.history) add(h, h.shooter, h.filmer);
    if (g.turn) add(g.turn, shooter(), filmer());
    for (const x of t) x.total = x.shoot + x.cam;
    return t;
  }
  const leader = (t) => (t[0].total === t[1].total ? -1 : t[0].total > t[1].total ? 0 : 1);

  // ---------------------------------------------------------- measuring
  /** 0..1: target centred (full marks within 8% of the picture width, none past 50%)
   * and 55–95% as wide as the picture. Also returns the parts, for coaching. */
  function framing(cx, cy, R) {
    const S = Math.min(live.w, live.h);
    const off = Math.hypot(cx - live.w / 2, cy - live.h / 2) / S, fill = (2 * R) / S;
    const centred = Math.min(1, Math.max(0, 1 - (off - 0.08) / 0.42));
    const size = fill < 0.55 ? fill / 0.55 : fill <= 0.95 ? 1 : Math.max(0, 1 - (fill - 0.95) / 0.35);
    return { f: centred * size, off, fill };
  }
  /** Steadiness 0..1 from per-frame picture speeds (px/s; -1 = too fast to measure). */
  function steadiness(speeds) {
    if (!speeds || !speeds.length) return null;
    const z = Math.max(viewZoom(), 0.25); // judge the hands, not the zoom: compare at 1x
    let s = 0;
    for (const v of speeds) s += v < 0 ? 0.02 : 1 / (1 + (v / z / STEADY_V) ** 2);
    return s / speeds.length;
  }

  /** Every processed frame: the live steadiness readout, and jolts. */
  function onFrame(m) {
    if (g.phase !== 'playing' || !g.turn) return;
    if (!Number.isFinite(m.speed)) return;
    const s = steadiness([m.speed]), now = performance.now();
    const a = 1 - Math.exp(-(now - (onFrame.at || now - 16)) / 1000); // ~1 s memory, whatever the frame rate
    onFrame.at = now;
    liveSteady = liveSteady == null ? s : liveSteady + a * (s - liveSteady);
    if (Number.isFinite(m.vetoed)) {
      if (m.vetoed < lastVetoed) lastVetoed = 0; // scorer was reset
      if (m.vetoed > lastVetoed) { g.turn.jolts = (g.turn.jolts || 0) + (m.vetoed - lastVetoed); jolt(); save(); }
      lastVetoed = m.vetoed;
    }
    if (now - stripAt > 200) { stripAt = now; paintStrip(); paintHud(); }
  }

  /** A few times a second while lining up or playing: where is the target? (live framing readout) */
  function wantsLocate() {
    if (locating || !['ready', 'countdown', 'playing'].includes(g.phase)) return false;
    const now = performance.now();
    if (now - locateAt < LOCATE_MS) return false;
    locateAt = now; locating = true;
    return true;
  }
  function onLocated(m) {
    locating = false;
    if (m.width !== live.w || m.height !== live.h) return;
    aim = m.target ? framing(m.target[0], m.target[1], m.target[2]) : { f: 0, off: null, fill: null, lost: true };
    aim.at = performance.now();
    paintStrip();
  }

  function onShot(shot, thumb) {
    // a hit still being measured when the turn was ended belongs to that turn (within 2 s)
    const late = g.phase === 'results' && last()?.epoch === shot.epoch && performance.now() - endedAt < 2000;
    const t = g.phase === 'playing' ? g.turn : late ? last() : null;
    if (!t || counted(t).length >= g.hits) return;
    shot.player = g.names[late ? t.shooter : shooter()];
    const fr = shot.center && shot.R ? framing(shot.center[0], shot.center[1], shot.R).f : 0;
    const st = steadiness(shot.pre) ?? liveSteady ?? 0;
    const rec = { score: shot.score, zone: shot.zone, steady: st, framing: fr, cam: Math.round(steadyPts(st) + 10 * fr), void: false };
    shot.rec = rec;
    t.hits.push(rec);
    if (late && counted(t).length >= g.hits) t.early = false;
    save();
    addShot(shot, thumb);
    camPop(rec.cam);
    if (late) { paint(); return; }
    paintBoard(); paintStrip(); paintHud();
    checkFull();
  }
  /** Strike out / restore a hit (from the chip row): this turn, or the turn just finished. */
  function toggleVoid(shot) {
    const editable = (g.phase === 'playing' && g.turn) || (g.phase === 'results' && g.history.length);
    if (!editable || !shot.rec) return false;
    const rec = (g.phase === 'playing' ? g.turn : g.history[g.history.length - 1]).hits.find((h) => h === shot.rec);
    if (!rec) return false;
    shot.void = rec.void = !rec.void;
    save();
    paint();
    if (g.phase === 'playing') checkFull();
    return true;
  }
  function checkFull() {
    clearTimeout(endTimer);
    if (g.phase === 'playing' && counted(g.turn).length >= g.hits) endTimer = setTimeout(() => endTurn(true), 1600);
  }

  // --------------------------------------------------------------- flow
  function onPrimary() {
    sound.unlock(); sensors.request(); // both need a tap
    // a tap meant for the previous screen (e.g. End turn just as the turn ended itself) is ignored
    if (busy || performance.now() - phaseAt < 600) return;
    const next = () => (g.k >= turns() ? toOver() : toReady());
    ({ setup: startGame, ready: startTurn, countdown: cancelCountdown, playing: () => endTurn(false), results: next, over: playAgain })[g.phase]();
  }
  function onAlt() {
    if (g.phase === 'over') return newGame();
    if (g.phase === 'results' && last()?.early) return resume();
    if (armed('quit')) return newGame();
  }
  /** Two-tap confirmation: the first tap arms it for 3 s and says "Sure?". */
  function armed(what) {
    if (confirmWhat === what && performance.now() < confirmUntil) { confirmWhat = ''; return true; }
    confirmWhat = what; confirmUntil = performance.now() + 3000;
    paintButtons();
    setTimeout(paintButtons, 3050);
    return false;
  }
  const last = () => g.history[g.history.length - 1];

  function startGame() {
    const name = (id, d) => Array.from($(id).value.trim() || d).slice(0, 12).join(''); // whole characters
    g = fresh();
    g.names = [name('g-p1', 'Player 1'), name('g-p2', 'Player 2')];
    g.hits = +$('g-hits').value; g.rounds = +$('g-rounds').value;
    store.set('p1', g.names[0]); store.set('p2', g.names[1]);
    resetBoard();
    toReady();
  }
  function playAgain() { g = fresh(g); resetBoard(); toReady(); }
  function newGame() {
    countdownId++; clearTimeout(endTimer); confirmWhat = '';
    if (live.running) stopLive();
    g = fresh(g); save();
    resetBoard();
    paint();
  }
  /** Next turn: open the camera so whoever films can line up the target. */
  async function toReady() {
    g.phase = 'ready'; aim = null; save();
    resetBoard(true);
    restoreChips(g.turn);
    paint();
    if (!live.running) {
      busy = true;
      try { await startLive(); } finally { busy = false; }
      paint();
    }
  }
  async function startTurn() {
    if (!live.running) { // show the picture first; Start turn again begins
      busy = true;
      try { await startLive(); } finally { busy = false; }
      restoreChips(g.turn);
      paint();
      return;
    }
    const id = ++countdownId;
    g.phase = 'countdown'; paint();
    for (const n of ['3', '2', '1']) {
      flash(n); sound.notes([660], 0, 0.1, 0.12);
      await sleep(800);
      if (id !== countdownId || g.phase !== 'countdown') return;
    }
    flash('Shoot!', 'go'); sound.notes([880, 1320], 0, 0.1, 0.22);
    restartScoring(); // fresh session: nothing from the countdown or earlier counts
    lastVetoed = 0; liveSteady = null;
    if (!g.turn) g.turn = { hits: [], jolts: 0 };
    g.turn.epoch = live.epoch;
    g.phase = 'playing'; save();
    paint();
    checkFull(); // a resumed turn may already be complete
  }
  function cancelCountdown() { countdownId++; g.phase = 'ready'; paint(); }
  function endTurn(auto) {
    if (g.phase !== 'playing' || !g.turn) return;
    const early = counted(g.turn).length < g.hits;
    if (early && !auto && !armed('end')) return; // ending with hits still to shoot: tap twice
    clearTimeout(endTimer); confirmWhat = '';
    g.history.push({ k: g.k, shooter: shooter(), filmer: filmer(), hits: g.turn.hits, jolts: g.turn.jolts || 0, early, epoch: g.turn.epoch });
    g.turn = null; g.k++; endedAt = performance.now();
    g.phase = 'results'; // every turn shows its results first (an early end can still be undone)
    save();
    paint();
    sound.notes([784, 988, 1175], 0, 0.1, 0.18);
  }
  function toOver() {
    g.phase = 'over'; save();
    stopLive();
    paint();
    finale();
  }
  /** Undo an early end: back to that turn with its hits so far. */
  function resume() {
    const h = g.history.pop();
    g.k = h.k; g.turn = { hits: h.hits, jolts: h.jolts };
    toReady();
  }
  /** Rebuild the chip row for a turn record (after a reload, or when resuming). */
  function restoreChips(t) {
    if (!t || board.shots.length) return;
    t.hits.forEach((rec, i) => board.shots.push({ n: i + 1, score: rec.score, zone: rec.zone, void: rec.void, rec }));
    renderBoard(true);
  }

  // ------------------------------------------------------------ effects
  function flash(text, cls) {
    const el = document.createElement('div');
    el.className = 'count' + (cls ? ' ' + cls : '');
    el.textContent = text;
    $('pops').append(el);
    setTimeout(() => el.remove(), cls ? 1150 : 850);
  }
  function stripPoint() {
    const s = $('g-strip').getBoundingClientRect(), v = $('viewer').getBoundingClientRect();
    return s.width ? [s.left - v.left + s.width / 2, s.top - v.top] : [v.width / 2, v.height * 0.8];
  }
  function camPop(pts) {
    const [x, y] = stripPoint();
    pop(`+${pts} cam`, 'var(--z5)', x, y, $('pops'), 'cam');
  }
  function jolt() {
    const [x, y] = stripPoint();
    pop(`Jolt −${JOLT_COST}`, 'var(--z2)', x, y, $('pops'), 'cam');
    sound.notes([196, 147], 0, 0.08, 0.14);
  }
  function finale() {
    const v = $('viewer').getBoundingClientRect();
    confetti($('fx'), v.width / 2, v.height / 3);
    sound.notes([523, 659, 784, 1047, 784, 1047], 0, 0.13, 0.2);
  }

  // ------------------------------------------------------------ drawing
  function paint() {
    if (g.phase !== shownPhase) { shownPhase = g.phase; phaseAt = performance.now(); confirmWhat = ''; }
    document.body.dataset.gphase = g.phase;
    document.body.classList.toggle('g-card', ['setup', 'results', 'over'].includes(g.phase));
    const running = g.phase === 'countdown' || g.phase === 'playing';
    $('tab-live').disabled = $('tab-clip').disabled = running; // no leaving mid-turn by accident
    paintBoard(); paintCard(); paintStrip(); paintButtons(); paintHud();
    fitViewer();
  }

  function paintBoard() {
    const t = totals(), lead = g.history.length || g.turn ? leader(t) : -1;
    for (const i of [0, 1]) {
      const li = $('gp-' + i);
      const role = g.phase === 'setup' || g.phase === 'over' || g.k >= turns() ? '' : i === shooter() ? 'shoot' : 'film';
      li.className = 'player' + (role ? ' ' + role : '') + (i === lead ? ' lead' : '');
      li.querySelector('.role').innerHTML = role ? ICON[role] : String(i + 1);
      li.querySelector('.pname').textContent = g.names[i];
      li.querySelector('.ptotal').textContent = t[i].total;
      const tag = role === 'shoot' ? '<b>Shooting</b>' : role === 'film' ? '<b>Filming</b>' : '';
      li.querySelector('.psplit').innerHTML = `${tag}${ICON.shoot}${t[i].shoot}<i></i>${ICON.film}${t[i].cam}`;
    }
    $('g-round').textContent = g.phase === 'setup' ? 'New game' : g.phase === 'over' ? 'Final score'
      : g.k >= turns() ? 'Last turn done' : `Round ${round()}/${g.rounds} · turn ${g.k + 1}/${turns()}`;
    $('g-ball').textContent = g.phase === 'setup' ? '' : g.turn ? `${counted(g.turn).length}/${g.hits} hits` : `${g.hits} hits a turn`;
  }

  function paintCard() {
    const card = $('game-card');
    if (g.phase === 'setup') {
      if (card.dataset.phase !== 'setup') card.innerHTML = `<div class="g-inner">${setupHtml()}</div>`; // keep what was typed
    } else if (g.phase === 'results' || g.phase === 'over') {
      card.innerHTML = `<div class="g-inner">${g.phase === 'results' ? resultsHtml() : overHtml()}</div>`;
    }
    card.dataset.phase = g.phase;
    card.hidden = !['setup', 'results', 'over'].includes(g.phase);
  }

  const options = (list, v) => list.map((n) => `<option value="${n}"${n === v ? ' selected' : ''}>${n}</option>`).join('');
  function setupHtml() {
    return `<div class="g-kicker">Two players</div>
      <h2>Shooter vs. camera</h2>
      <p>Take turns: one shoots, the other films, then swap. A turn is a set number of hits on the
        paper; missed it, or no beep? Shoot again. Each hit pays the shooter its ring and whoever
        films up to ${CAM_PER_HIT} for a steady, well-framed shot. Agree a shooting line first.</p>
      <div class="g-form">
        <label>Player 1<input id="g-p1" maxlength="12" autocomplete="off" enterkeyhint="next" value="${esc(g.names[0])}"></label>
        <label>Player 2<input id="g-p2" maxlength="12" autocomplete="off" enterkeyhint="done" value="${esc(g.names[1])}"></label>
        <label>Hits a turn<select id="g-hits">${options(HIT_CHOICES, g.hits)}</select></label>
        <label>Rounds<select id="g-rounds">${options(ROUND_CHOICES, g.rounds)}</select></label>
      </div>`;
  }
  function resultsHtml() {
    const h = last(), x = tally(h);
    const jolts = h.jolts ? ` · ${h.jolts} jolt${h.jolts > 1 ? 's' : ''} −${JOLT_COST * h.jolts}` : '';
    return `<div class="g-kicker">Turn ${h.k + 1} of ${turns()} done</div>
      ${h.early ? `<p class="g-early">Ended early: ${x.n} of ${g.hits} hits. Wrong? Tap Resume.</p>` : ''}
      <div class="g-line shoot"><span class="badge">${ICON.shoot}</span>
        <div><b>${esc(g.names[h.shooter])}</b> shot<small>${x.onRings} of ${x.n} on the rings${x.best ? ` · best ${x.best}` : ''}</small></div>
        <span class="g-pts">${x.shoot}</span></div>
      <div class="g-line film"><span class="badge">${ICON.film}</span>
        <div><b>${esc(g.names[h.filmer])}</b> filmed<small>Steady ${pct(x.steady)} · framing ${pct(x.framing)}${jolts}</small></div>
        <span class="g-pts">+${x.cam}</span></div>
      ${x.n ? '<p class="g-tip">A false hit? Tap its chip above to strike it out.</p>' : ''}
      ${g.k >= turns() ? '<p class="g-next">That was the last turn.</p>'
        : `<p class="g-next">Swap! <b>${esc(g.names[shooter()])}</b> shoots, <b>${esc(g.names[filmer()])}</b> films.</p>`}`;
  }
  function overHtml() {
    const t = totals(), win = leader(t), order = win === 1 ? [1, 0] : [0, 1];
    const row = (i) => `<tr${i === win ? ' class="win"' : ''}><th>${esc(g.names[i])}</th><td>${t[i].shoot}</td><td>${t[i].cam}</td><td>${t[i].total}</td></tr>`;
    // little awards: best shooting turn, steadiest hands, best framing
    const recs = g.history.map((h) => ({ h, x: tally(h) }));
    const avg = (i, key) => mean(recs.filter((r) => r.h.filmer === i && r.x[key] != null).map((r) => r.x[key]));
    const best = recs.reduce((a, r) => (!a || r.x.shoot > a.x.shoot ? r : a), null);
    const award = (label, key) => {
      const v = [avg(0, key), avg(1, key)];
      if (v[0] == null && v[1] == null) return '';
      if (v[0] != null && v[1] != null && Math.round(100 * v[0]) === Math.round(100 * v[1])) return `<li>${label}: <b>both</b> ${pct(v[0])}</li>`;
      const i = (v[1] ?? -1) > (v[0] ?? -1) ? 1 : 0;
      return `<li>${label}: <b>${esc(g.names[i])}</b> ${pct(v[i])}</li>`;
    };
    return `<div class="g-kicker">Game over</div>
      <h2 class="g-winner">${win < 0 ? 'It’s a tie!' : `${esc(g.names[win])} wins!`}</h2>
      <table class="g-final"><thead><tr><th></th><th>Shooting</th><th>Camera</th><th>Total</th></tr></thead>
        <tbody>${order.map(row).join('')}</tbody></table>
      <ul class="g-awards">
        ${best && best.x.shoot ? `<li>Best turn: <b>${esc(g.names[best.h.shooter])}</b> ${best.x.shoot}</li>` : ''}
        ${award('Steadiest hands', 'steady')}${award('Best framing', 'framing')}
      </ul>`;
  }

  /** What the framing check says to do, while lining up. */
  function coach() {
    if (!live.running) return [`Hand the phone to ${esc(g.names[filmer()])}, then tap Camera on.`, null];
    if (!aim || performance.now() - aim.at > 2000) return ['Point the camera at the target.', null];
    if (aim.lost) return ['Can’t see the target: point the camera at it.', 0];
    if (aim.fill < 0.55) return ['Zoom in or step closer: fill most of the width.', aim.f];
    if (aim.fill > 0.95) return ['Too tight: zoom out a little.', aim.f];
    if (aim.off > 0.08) return ['Centre the target.', aim.f];
    return ['Looks great. Tap Start turn.', aim.f];
  }
  function paintStrip() {
    const el = $('g-strip'), S = esc(g.names[shooter()]), F = esc(g.names[filmer()]);
    // (who shoots and who films is on the scoreboard; the strip coaches and keeps score)
    el.className = 'g-strip game-only';
    const rest = sensors.resting() ? '<span class="g-warn">Hand-held only!</span>' : '';
    if (g.phase === 'ready') {
      const [tip, f] = coach();
      const head = g.turn ? `Resuming at ${counted(g.turn).length}/${g.hits} hits` : `${F} films`;
      if (f != null) el.classList.add(f > 0.8 ? 'good' : f > 0.5 ? 'ok' : 'bad');
      el.innerHTML = `${ICON.film}<div class="g-say"><b>${head}</b><small>${tip}</small>${rest}</div>
        ${f != null ? `<span class="m">Framing<b>${pct(f)}</b></span>` : ''}`;
    } else if (g.phase === 'countdown' || g.phase === 'playing') {
      const fresh = aim && performance.now() - aim.at < 2000 ? aim.f : null;
      const now = liveSteady != null && fresh != null ? (liveSteady + fresh) / 2 : liveSteady ?? fresh;
      if (now != null) el.classList.add(now > 0.8 ? 'good' : now > 0.5 ? 'ok' : 'bad');
      el.innerHTML = `${ICON.film}<span class="m">Steady<b>${pct(liveSteady)}</b></span><span class="m">Framing<b>${pct(fresh)}</b></span>
        <span class="m who">${S}<b>${g.turn ? `${counted(g.turn).length}/${g.hits}` : 'Ready'}</b></span>${rest}`;
    }
    el.hidden = !['ready', 'countdown', 'playing'].includes(g.phase);
  }

  function paintButtons() {
    const sure = (what) => confirmWhat === what && performance.now() < confirmUntil;
    const early = g.phase === 'playing' && g.turn && counted(g.turn).length < g.hits;
    const labels = {
      setup: ['Start game', ''],
      ready: [!live.running ? 'Camera on' : g.turn ? 'Resume turn' : 'Start turn', 'Quit'],
      countdown: ['Cancel', 'Quit'],
      playing: [sure('end') ? 'Sure? End' : early ? 'End turn' : 'End turn', 'Quit'],
      results: [g.k >= turns() ? 'Final score' : 'Next turn', last()?.early ? 'Resume' : 'Quit'],
      over: ['Play again', 'New game'],
    }[g.phase];
    $('btn-game').textContent = labels[0];
    // the ring reader (OpenCV) must be loaded before a turn can score
    $('btn-game').disabled = !frameReady || (g.phase === 'ready' && live.running && !measureReady);
    const alt = $('btn-game-alt');
    alt.hidden = !labels[1];
    alt.textContent = sure('quit') ? 'Sure?' : labels[1];
  }

  /** One line under the big score in overlay mode. */
  function paintHud() {
    const S = g.names[shooter()], F = g.names[filmer()];
    $('hud-game').textContent = g.phase === 'playing' || g.phase === 'countdown'
      ? `${S} shooting ${g.turn ? counted(g.turn).length : 0}/${g.hits} · ${F} filming · steady ${pct(liveSteady)}`
      : g.phase === 'ready' ? `Next: ${S} shoots, ${F} films` : '';
  }

  // ------------------------------------------------------------- wiring
  $('btn-game').onclick = onPrimary;
  $('btn-game-alt').onclick = onAlt;

  /** The app went to the background: a turn in progress pauses (resume after a countdown). */
  function onHidden() {
    if (g.phase !== 'countdown' && g.phase !== 'playing') return;
    countdownId++; clearTimeout(endTimer);
    g.phase = 'ready'; save();
    stopLive();
    paint();
  }

  return {
    onFrame, onShot, onLocated, wantsLocate, toggleVoid, onHidden, paint,
    enter() { restoreChips(g.phase === 'results' ? last() : g.turn); paint(); },
    /** Leaving the Game tab (only possible between turns): stop timers, keep everything else. */
    leave() {
      countdownId++; clearTimeout(endTimer); confirmWhat = '';
      if (g.phase === 'countdown' || g.phase === 'playing') g.phase = 'ready';
      save();
      document.body.classList.remove('g-card');
      $('tab-live').disabled = $('tab-clip').disabled = false;
    },
  };
})();

if (store.get('mode') === 'game') setMode('game');
