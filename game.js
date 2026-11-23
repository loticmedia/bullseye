/* Two-player game: one player shoots while the other films, then they swap.
 * The shooter scores the rings exactly as in Live mode. Whoever films scores up to
 * CAM_PER_BALL points a ball: half for keeping the picture steady (every frame of the
 * turn, from the motion sensors and the picture's own shake), half for framing (target
 * centred and filling the view, checked at every hit).
 * Loaded after app.js and uses its globals (live, board, addShot, startLive, sound, ...). */
'use strict';

const game = (() => {
  const CAM_PER_BALL = 20;   // 10 steadiness + 10 framing
  // Picture speed (working px per second) at which a frame counts half steady. Calibrated on the
  // two hand-held slo-mo clips (median 46 and 78 px/s): ordinary hand-held filming scores ~70-85%.
  const STEADY_V = 150;
  const BALL_CHOICES = [3, 5, 6, 8, 10, 12, 15, 20];
  const ROUND_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
  const ICON = {
    shoot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>',
    film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z" fill="currentColor"/></svg>',
  };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x == null ? '–' : Math.round(100 * x) + '%');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Saved in localStorage so a reload or a killed Home Screen app keeps the game.
  // phase: setup -> ready -> countdown -> playing -> results -> ready ... -> over
  let g = load();
  let turn = null;            // the turn being played: {shots, steadySum, steadyN, recent, framing[]}
  let endTimer = 0, quitUntil = 0, stripAt = 0, countdownId = 0;

  function fresh(prev) {
    return {
      names: prev ? prev.names : [store.get('p1') || 'Player 1', store.get('p2') || 'Player 2'],
      balls: prev ? prev.balls : 10, rounds: prev ? prev.rounds : 3,
      k: 0, history: [], phase: 'setup',
    };
  }
  function load() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem('game')); } catch (e) { /* none saved */ }
    if (!v || !Array.isArray(v.names) || !Array.isArray(v.history)) return fresh();
    if (v.phase === 'countdown' || v.phase === 'playing') v.phase = 'ready'; // an unfinished turn is replayed
    return v;
  }
  function save() { try { localStorage.setItem('game', JSON.stringify(g)); } catch (e) { /* private mode */ } }

  const turns = () => 2 * g.rounds;
  const shooter = () => g.k % 2; // player 1 shoots first in every round
  const filmer = () => 1 - shooter();
  const round = () => Math.min(Math.floor(g.k / 2) + 1, g.rounds);

  function totals() {
    const t = [0, 1].map(() => ({ shoot: 0, cam: 0, total: 0 }));
    for (const h of g.history) { t[h.shooter].shoot += h.shootPts; t[h.filmer].cam += h.camPts; }
    if (turn) t[shooter()].shoot += sum(turn.shots.map((s) => s.score));
    for (const x of t) x.total = x.shoot + x.cam;
    return t;
  }
  const leader = (t) => (t[0].total === t[1].total ? -1 : t[0].total > t[1].total ? 0 : 1);

  // ---------------------------------------------------------- measuring
  /** 0..1: target centred (full marks within 8% of the picture width, none past 50%)
   * and 55–95% as wide as the picture. */
  function framingOf(shot) {
    if (!shot.center || !shot.R || !live.w) return null;
    const S = Math.min(live.w, live.h);
    const off = Math.hypot(shot.center[0] - live.w / 2, shot.center[1] - live.h / 2) / S;
    const centred = Math.min(1, Math.max(0, 1 - (off - 0.08) / 0.42));
    const fill = (2 * shot.R) / S;
    const size = fill < 0.55 ? fill / 0.55 : fill <= 0.95 ? 1 : Math.max(0, 1 - (fill - 0.95) / 0.35);
    return centred * size;
  }

  /** Every processed frame: how fast the picture slid (motion sensors or image shake, whichever is
   * worse). Both arrive as px per capture frame; times the capture rate gives real-world px/s. */
  function onFrame(m) {
    if (g.phase !== 'playing' || !turn) return;
    const px = Math.max(Number.isFinite(m.motionPx) ? m.motionPx : 0, m.shake ?? 0);
    const s = m.shake === null ? 0.05 // too big to measure
      : 1 / (1 + ((px * live.captureFps) / STEADY_V) ** 2);
    turn.steadySum += s; turn.steadyN++;
    turn.recent = 0.85 * turn.recent + 0.15 * s;
    const now = performance.now();
    if (now - stripAt > 200) { stripAt = now; paintStrip(); paintHud(); }
  }

  function onShot(shot, thumb) {
    if (g.phase !== 'playing' || !turn || turn.shots.length >= g.balls) return;
    shot.player = g.names[shooter()];
    const f = framingOf(shot);
    if (f != null) turn.framing.push(f);
    turn.shots.push(shot);
    addShot(shot, thumb);
    paintBoard(); paintStrip(); paintHud();
    if (turn.shots.length >= g.balls) { clearTimeout(endTimer); endTimer = setTimeout(endTurn, 1600); }
  }

  // --------------------------------------------------------------- flow
  function onPrimary() {
    sound.unlock(); sensors.request(); // both need a tap
    ({ setup: startGame, ready: startTurn, countdown: endTurn, playing: endTurn, results: toReady, over: playAgain })[g.phase]();
  }
  function onAlt() {
    if (g.phase === 'over' || performance.now() < quitUntil) { newGame(); return; }
    quitUntil = performance.now() + 3000;
    $('btn-game-alt').textContent = 'Sure?';
    setTimeout(paintButtons, 3050);
  }

  function startGame() {
    const name = (id, d) => ($(id).value.trim() || d).slice(0, 12);
    g.names = [name('g-p1', 'Player 1'), name('g-p2', 'Player 2')];
    g.balls = +$('g-balls').value; g.rounds = +$('g-rounds').value;
    store.set('p1', g.names[0]); store.set('p2', g.names[1]);
    g.k = 0; g.history = [];
    resetBoard();
    toReady();
  }
  function playAgain() {
    g = fresh(g);
    resetBoard();
    toReady();
  }
  function newGame() {
    countdownId++; clearTimeout(endTimer); turn = null; quitUntil = 0;
    if (live.running) stopLive();
    g = fresh(g); save();
    resetBoard();
    paint();
  }
  /** Next player's turn: open the camera so the person filming can line up the target. */
  async function toReady() {
    g.phase = 'ready'; save();
    resetBoard(true);
    paint();
    if (!live.running) { await startLive(); paint(); }
  }
  async function startTurn() {
    if (!live.running) { await startLive(); paint(); return; } // show the picture first; Start turn again begins
    const id = ++countdownId;
    g.phase = 'countdown'; paint();
    for (const n of ['3', '2', '1']) {
      flash(n); sound.notes([660], 0, 0.1, 0.12);
      await sleep(800);
      if (id !== countdownId) return;
    }
    flash('Shoot!', 'go'); sound.notes([880, 1320], 0, 0.1, 0.22);
    frameWorker.postMessage({ type: 'live-start', captureFps: live.captureFps }); // fresh scorer: nothing from the countdown counts
    resetBoard(true);
    turn = { shots: [], steadySum: 0, steadyN: 0, recent: 1, framing: [] };
    g.phase = 'playing'; save();
    paint();
  }
  function endTurn() {
    clearTimeout(endTimer);
    if (g.phase === 'countdown') { countdownId++; g.phase = 'ready'; paint(); return; }
    if (g.phase !== 'playing' || !turn) return;
    const shots = turn.shots, half = (CAM_PER_BALL / 2) * g.balls;
    const steady = turn.steadyN ? turn.steadySum / turn.steadyN : 0;
    const framing = turn.framing.length ? sum(turn.framing) / turn.framing.length : null;
    g.history.push({
      k: g.k, shooter: shooter(), filmer: filmer(),
      shootPts: sum(shots.map((s) => s.score)), shots: shots.length,
      hits: shots.filter((s) => s.score > 0).length, best: shots.length ? Math.max(...shots.map((s) => s.score)) : 0,
      steady, framing, camPts: Math.round(half * steady) + Math.round(half * (framing || 0)),
    });
    turn = null; g.k++;
    g.phase = g.k >= turns() ? 'over' : 'results';
    save();
    if (g.phase === 'over') stopLive();
    paint();
    if (g.phase === 'over') finale();
    else sound.notes([784, 988, 1175], 0, 0.1, 0.18);
  }

  // ------------------------------------------------------------ effects
  function flash(text, cls) {
    const el = document.createElement('div');
    el.className = 'count' + (cls ? ' ' + cls : '');
    el.textContent = text;
    $('pops').append(el);
    setTimeout(() => el.remove(), cls ? 1150 : 850);
  }
  function finale() {
    const v = $('viewer').getBoundingClientRect();
    confetti($('fx'), v.width / 2, v.height / 3);
    sound.notes([523, 659, 784, 1047, 784, 1047], 0, 0.13, 0.2);
  }

  // ------------------------------------------------------------ drawing
  function paint() { paintBoard(); paintCard(); paintStrip(); paintButtons(); paintHud(); }

  function paintBoard() {
    const t = totals(), lead = g.history.length || turn ? leader(t) : -1;
    for (const i of [0, 1]) {
      const li = $('gp-' + i);
      const role = g.phase === 'setup' || g.phase === 'over' ? '' : i === shooter() ? 'shoot' : 'film';
      li.className = 'player' + (role ? ' ' + role : '') + (i === lead ? ' lead' : '');
      li.querySelector('.role').innerHTML = role ? ICON[role] : String(i + 1);
      const tag = role === 'shoot' ? 'shooting' : role === 'film' ? 'filming' : '';
      li.querySelector('.pname').innerHTML = esc(g.names[i]) + (tag ? `<small>${tag}</small>` : '');
      li.querySelector('.ptotal').textContent = t[i].total;
      li.querySelector('.psplit').innerHTML = `${ICON.shoot}${t[i].shoot}<i></i>${ICON.film}${t[i].cam}`;
    }
    $('g-round').textContent = g.phase === 'setup' ? 'New game'
      : g.phase === 'over' ? 'Final score' : `Round ${round()} of ${g.rounds} · turn ${g.k + 1} of ${turns()}`;
    $('g-ball').textContent = turn ? `${turn.shots.length} / ${g.balls} balls` : g.phase === 'setup' ? '' : `${g.balls} balls a turn`;
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
      <p>Take turns: one shoots while the other films, then swap. The shooter scores the rings.
        Whoever films scores up to ${CAM_PER_BALL} a ball: half for holding steady, half for keeping
        the target centred and filling the view.</p>
      <div class="g-form">
        <label>Player 1<input id="g-p1" maxlength="12" autocomplete="off" enterkeyhint="next" value="${esc(g.names[0])}"></label>
        <label>Player 2<input id="g-p2" maxlength="12" autocomplete="off" enterkeyhint="done" value="${esc(g.names[1])}"></label>
        <label>Balls a turn<select id="g-balls">${options(BALL_CHOICES, g.balls)}</select></label>
        <label>Rounds<select id="g-rounds">${options(ROUND_CHOICES, g.rounds)}</select></label>
      </div>`;
  }
  function resultsHtml() {
    const h = g.history[g.history.length - 1];
    return `<div class="g-kicker">Turn ${h.k + 1} of ${turns()} done</div>
      <div class="g-line shoot"><span class="badge">${ICON.shoot}</span>
        <div><b>${esc(g.names[h.shooter])}</b> shot<small>${h.hits} of ${h.shots} on the rings${h.best ? ` · best ${h.best}` : ''}</small></div>
        <span class="g-pts">${h.shootPts}</span></div>
      <div class="g-line film"><span class="badge">${ICON.film}</span>
        <div><b>${esc(g.names[h.filmer])}</b> filmed<small>Steady ${pct(h.steady)} · framing ${pct(h.framing)}</small></div>
        <span class="g-pts">+${h.camPts}</span></div>
      <p class="g-next">Swap! <b>${esc(g.names[shooter()])}</b> shoots, <b>${esc(g.names[filmer()])}</b> films.</p>`;
  }
  function overHtml() {
    const t = totals(), win = leader(t), order = win === 1 ? [1, 0] : [0, 1];
    const row = (i) => `<tr${i === win ? ' class="win"' : ''}><th>${esc(g.names[i])}</th><td>${t[i].shoot}</td><td>${t[i].cam}</td><td>${t[i].total}</td></tr>`;
    // little awards: best shooting turn, steadiest hands, best framing
    const avg = (i, key) => {
      const v = g.history.filter((h) => h.filmer === i && h[key] != null).map((h) => h[key]);
      return v.length ? sum(v) / v.length : null;
    };
    const best = g.history.reduce((a, h) => (!a || h.shootPts > a.shootPts ? h : a), null);
    const award = (label, key) => {
      const v = [avg(0, key), avg(1, key)];
      if (v[0] == null && v[1] == null) return '';
      const i = (v[1] ?? -1) > (v[0] ?? -1) ? 1 : 0;
      return `<li>${label}: <b>${esc(g.names[i])}</b> ${pct(v[i])}</li>`;
    };
    return `<div class="g-kicker">Game over</div>
      <h2 class="g-winner">${win < 0 ? 'It’s a tie!' : `${esc(g.names[win])} wins!`}</h2>
      <table class="g-final"><thead><tr><th></th><th>Shooting</th><th>Camera</th><th>Total</th></tr></thead>
        <tbody>${order.map(row).join('')}</tbody></table>
      <ul class="g-awards">
        ${best ? `<li>Best turn: <b>${esc(g.names[best.shooter])}</b> ${best.shootPts}</li>` : ''}
        ${award('Steadiest hands', 'steady')}${award('Best framing', 'framing')}
      </ul>`;
  }

  function paintStrip() {
    const el = $('g-strip'), S = esc(g.names[shooter()]), F = esc(g.names[filmer()]);
    el.className = 'g-strip game-only';
    if (g.phase === 'ready') {
      el.innerHTML = `${ICON.film}<div><b>${F}</b> films, <b>${S}</b> shoots<small>${live.running
        ? 'Centre the target so it fills most of the width, then tap Start turn.'
        : 'Hand the phone over and tap Camera on.'}</small></div>`;
    } else if (g.phase === 'countdown' || g.phase === 'playing') {
      const steady = turn && turn.steadyN ? turn.steadySum / turn.steadyN : null;
      const framing = turn && turn.framing.length ? sum(turn.framing) / turn.framing.length : null;
      if (turn) el.classList.add(turn.recent > 0.8 ? 'good' : turn.recent > 0.5 ? 'ok' : 'bad');
      el.innerHTML = `${ICON.film}<span class="m">Steady<b>${pct(steady)}</b></span><span class="m">Framing<b>${pct(framing)}</b></span>
        <span class="m who">${F}<b>${turn ? `${turn.shots.length}/${g.balls}` : 'Ready'}</b></span>`;
    }
    el.hidden = !['ready', 'countdown', 'playing'].includes(g.phase);
  }

  function paintButtons() {
    const labels = {
      setup: ['Start game', ''], ready: [live.running ? 'Start turn' : 'Camera on', 'Quit'],
      countdown: ['Cancel', 'Quit'], playing: ['End turn', 'Quit'], results: ['Next turn', 'Quit'], over: ['Play again', 'New game'],
    }[g.phase];
    $('btn-game').textContent = labels[0];
    const alt = $('btn-game-alt');
    alt.hidden = !labels[1];
    if (performance.now() >= quitUntil) alt.textContent = labels[1];
  }

  /** One line under the big score in overlay mode. */
  function paintHud() {
    const S = g.names[shooter()], F = g.names[filmer()];
    const steady = turn && turn.steadyN ? turn.steadySum / turn.steadyN : null;
    $('hud-game').textContent = g.phase === 'playing' || g.phase === 'countdown'
      ? `${S} shooting · ${F} filming · steady ${pct(steady)}`
      : g.phase === 'ready' ? `Next: ${S} shoots, ${F} films` : '';
  }

  // ------------------------------------------------------------- wiring
  $('btn-game').onclick = onPrimary;
  $('btn-game-alt').onclick = onAlt;

  return {
    onFrame, onShot,
    enter() { paint(); },
    /** Leaving the Game tab drops an unfinished turn (it is replayed on return). */
    leave() {
      countdownId++; clearTimeout(endTimer);
      if (turn || g.phase === 'countdown') { turn = null; g.phase = 'ready'; }
      save();
    },
  };
})();

if (store.get('mode') === 'game') setMode('game');
