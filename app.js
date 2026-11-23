/* Bullseye web app — UI, camera capture and clip selection.
 * Scoring runs in frame-worker.js (every frame) and measure-worker.js (each impact).
 * Test hook: ?demo=<video url>[&capture=240] plays a video through the live pipeline. */
'use strict';

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const ZONE_COLORS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => css.getPropertyValue('--z' + k).trim());
const RING_POINTS = [100, 60, 50, 40, 30, 20, 10];
const WORK_SHORT = 540;

// Two workers: frame-worker (every frame, pure JS) hands impact jobs straight to
// measure-worker (OpenCV) over a MessageChannel, so live frames never wait on a shot.
const frameWorker = new Worker('frame-worker.js');
const measureWorker = new Worker('measure-worker.js');
{
  const ch = new MessageChannel();
  frameWorker.postMessage({ type: 'init', port: ch.port1 }, [ch.port1]);
  measureWorker.postMessage({ type: 'init', port: ch.port2 }, [ch.port2]);
}
let frameReady = false, measureReady = false;
let mode = 'live'; // 'live' | 'game' (both use the camera) | 'clip'
const cameraMode = () => mode !== 'clip';
const clipRun = { active: false, jobsTotal: null, jobsDone: 0, info: '', ms: 0, cancelled: false };

// ------------------------------------------------------------- scoreboard
const board = { shots: [], shown: 0 };
function resetBoard(keepList) {
  board.shots = [];
  if (!keepList) {
    $('list').querySelectorAll('img[src^="blob:"]').forEach((im) => URL.revokeObjectURL(im.src));
    $('list').innerHTML = '';
  }
  renderBoard(true);
  drawOverlay();
}
function stats() {
  const s = board.shots.filter((x) => !x.void), hits = s.filter((x) => x.score > 0);
  let streak = 0;
  for (let i = s.length - 1; i >= 0 && s[i].score > 0; i--) streak++;
  return {
    total: s.reduce((a, x) => a + x.score, 0),
    shots: s.length,
    hitRate: s.length ? Math.round((100 * hits.length) / s.length) + '%' : '–',
    best: hits.length ? Math.max(...hits.map((x) => x.score)) : '–',
    streak,
  };
}
/** Animated count-up of the score in every place it is shown. */
function countTo(target, instant) {
  const from = board.shown, els = [$('total'), $('hud-total')];
  if (instant || from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    board.shown = target; els.forEach((e) => (e.textContent = target)); return;
  }
  const t0 = performance.now(), dur = 520;
  els.forEach((e) => { e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); });
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), v = Math.round(from + (target - from) * (1 - (1 - k) ** 3));
    els.forEach((e) => (e.textContent = v));
    if (k < 1) requestAnimationFrame(step); else board.shown = target;
  };
  requestAnimationFrame(step);
}
function renderBoard(instant) {
  const st = stats();
  countTo(st.total, instant);
  $('shots').textContent = st.shots;
  $('hitrate').textContent = st.hitRate;
  $('best').textContent = st.best;
  $('streak').textContent = st.streak;
  $('hud-shots').textContent = st.shots;
  $('hud-streak').textContent = st.streak;
  // shot string: one chip per shot (newest last); a greyed ring key when empty
  const str = $('string');
  str.innerHTML = '';
  if (!board.shots.length) {
    RING_POINTS.forEach((p, z) => {
      const li = document.createElement('li');
      li.className = 'key'; li.textContent = p; li.style.background = ZONE_COLORS[z];
      str.append(li);
    });
  } else {
    for (const sh of board.shots) {
      const li = document.createElement('li');
      if (sh.score) { li.textContent = sh.score; li.style.background = ZONE_COLORS[sh.zone]; } else { li.className = 'miss'; li.textContent = '×'; }
      if (sh.void) li.classList.add('void');
      li.title = sh.void ? 'Struck out: tap to count it again' : 'Not a real hit? Tap to strike it out';
      str.append(li);
    }
    str.scrollLeft = str.scrollWidth;
  }
  const last = board.shots.filter((x) => !x.void).pop(), hl = $('hud-last');
  hl.textContent = last ? (last.score || 'MISS') : '';
  hl.style.background = last ? (last.score ? ZONE_COLORS[last.zone] : 'var(--panel-hi)') : '';
  hl.style.color = last && !last.score ? 'var(--z7)' : '';
  const listed = $('list').querySelectorAll('li:not(.void)').length;
  $('list-count').textContent = listed ? `· ${listed}` : '';
  $('list-empty').hidden = $('list').children.length > 0;
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), r = sec - 60 * m;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
function addShot(shot, thumb) {
  shot.n = board.shots.length + 1;
  shot.zoomAt = cameraMode() && !zoom.native ? zoom.value : 1;
  board.shots.push(shot);
  const li = document.createElement('li');
  if (!shot.score) li.className = 'miss';
  const edge = document.createElement('span');
  edge.className = 'edge';
  edge.style.background = ZONE_COLORS[shot.score ? shot.zone : 7];
  const img = document.createElement('img');
  if (thumb) { img.src = URL.createObjectURL(thumb); img.alt = `Shot ${shot.n} on the target`; } else { img.alt = ''; }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const ring = shot.score === 100 ? 'Bullseye' : shot.score ? `${ordinalRing(shot.zone)} ring` : 'Off the rings';
  const title = document.createElement('b');
  title.textContent = shot.player ? `${shot.player} · shot ${shot.n}` : `Shot ${shot.n}`;
  meta.append(title, `${ring} · ${fmtTime(shot.time)}${shot.note ? ' · low confidence' : ''}`);
  const pts = document.createElement('div');
  pts.className = 'pts';
  pts.textContent = shot.score || 'miss';
  if (shot.score) pts.style.background = ZONE_COLORS[shot.zone];
  li.append(edge, img, meta, pts);
  shot.li = li;
  $('list').prepend(li);
  renderBoard();
  const hl = $('hud-last'); hl.classList.remove('fresh'); void hl.offsetWidth; hl.classList.add('fresh');
  drawOverlay();
  celebrate(shot);
}
/** Tap a chip in the shot string to strike out a false hit (tap again to restore it). */
$('string').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('key')) return;
  const shot = board.shots[[...$('string').children].indexOf(li)];
  if (!shot) return;
  if (mode === 'game') { if (!game.toggleVoid(shot)) return; } else shot.void = !shot.void;
  if (shot.li) shot.li.classList.toggle('void', !!shot.void);
  renderBoard();
  drawOverlay();
});
function ordinalRing(zone) { return ['Centre', 'Inner', '2nd', '3rd', '4th', '5th', 'Outer'][zone] || 'Outer'; }

// ------------------------------------------------------------ hit effects
/** Working-frame coordinates -> CSS pixels inside the viewer (preview is object-fit cover, or contain in overlay mode). */
function viewPoint(x, y, sh) {
  const r = $('viewer').getBoundingClientRect();
  const fit = getComputedStyle($('video')).objectFit === 'cover' ? Math.max : Math.min;
  const s = fit(r.width / live.w, r.height / live.h);
  const ox = (r.width - live.w * s) / 2, oy = (r.height - live.h * s) / 2;
  const k = (zoom.native ? 1 : zoom.value) / ((sh && sh.zoomAt) || 1);
  return [ox + (live.w / 2 + (x - live.w / 2) * k) * s, oy + (live.h / 2 + (y - live.h / 2) * k) * s, s * k];
}
function pop(text, color, x, y, layer, cls) {
  const el = document.createElement('div');
  el.className = 'pop' + (cls ? ' ' + cls : '');
  el.textContent = text;
  el.style.setProperty('--c', color);
  el.style.left = x + 'px'; el.style.top = y + 'px';
  layer.append(el);
  el.addEventListener('animationend', () => el.remove());
}
function celebrate(shot) {
  const logo = $('logo'); logo.classList.remove('thunk'); void logo.getBoundingClientRect(); logo.classList.add('thunk');
  sound.hit(shot.score);
  const liveView = cameraMode() && live.running && live.w;
  let layer, x, y;
  if (liveView) {
    layer = $('pops');
    [x, y] = viewPoint(shot.ball[0], shot.ball[1], shot);
  } else {
    layer = $('board');
    const t = $('total').getBoundingClientRect(), b = layer.getBoundingClientRect();
    x = t.left - b.left + t.width + 30; y = t.top - b.top + t.height / 2;
  }
  if (shot.score) pop('+' + shot.score, ZONE_COLORS[shot.zone], x, y, layer);
  else pop('MISS', ZONE_COLORS[7], x, y, layer, 'miss');
  if (shot.score === 100) {
    const banner = document.createElement('div');
    banner.className = 'banner'; banner.textContent = 'Bullseye!';
    const host = liveView ? $('pops') : $('board');
    host.append(banner);
    banner.addEventListener('animationend', () => banner.remove());
    confetti(liveView ? $('fx') : null, x, y);
  }
}

/** Confetti in ring colours. Draws on the viewer's fx canvas, or a temporary full-page one. */
function confetti(canvas, x0, y0) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let temp = null;
  if (!canvas) {
    temp = canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 50 });
    document.body.append(canvas);
    const b = $('total').getBoundingClientRect(); x0 = b.left + b.width / 2; y0 = b.top + b.height / 2;
  }
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const ctx = canvas.getContext('2d');
  const parts = Array.from({ length: 140 }, () => {
    const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 9;
    return { x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, rot: Math.random() * 6, vr: (Math.random() - .5) * .5,
      w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, c: ZONE_COLORS[(Math.random() * 7) | 0] };
  });
  const t0 = performance.now();
  const frame = (now) => {
    const t = now - t0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - t / 1800);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (t < 1800) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, canvas.width, canvas.height); if (temp) temp.remove(); }
  };
  requestAnimationFrame(frame);
}

/** Small synthesised sound kit: paper "thwack" for a hit (brighter for better rings),
 * a rising arpeggio for a bullseye, a low "bonk" for a miss. */
const sound = {
  on: (() => { try { return localStorage.getItem('sound') !== 'off'; } catch (e) { return true; } })(),
  ctx: null,
  unlock() {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state !== 'running') this.ctx.resume();
    } catch (e) { this.ctx = null; }
  },
  hit(score) {
    if (!this.on || !this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createGain(); out.gain.value = 0.55; out.connect(c.destination);
    // thwack: band-passed noise burst + body thump
    const len = Math.floor(c.sampleRate * 0.12), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const noise = c.createBufferSource(); noise.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = score ? 900 + score * 18 : 500; bp.Q.value = 1.4;
    noise.connect(bp).connect(out); noise.start(t);
    const thump = c.createOscillator(), tg = c.createGain();
    thump.type = 'sine'; thump.frequency.setValueAtTime(score ? 180 : 140, t); thump.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    tg.gain.setValueAtTime(0.9, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    thump.connect(tg).connect(out); thump.start(t); thump.stop(t + 0.25);
    if (!score) { // bonk
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(220, t + 0.05); o.frequency.exponentialRampToValueAtTime(90, t + 0.35);
      g.gain.setValueAtTime(0.35, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(out); o.start(t + 0.05); o.stop(t + 0.45);
    }
    this.notes(score === 100 ? [523, 659, 784, 1047] : score >= 50 ? [659, 988] : score ? [587] : [], t + 0.08);
  },
  /** Square-wave notes, one after another (countdown beeps, fanfares). */
  notes(freqs, at, step = 0.09, len = 0.16) {
    if (!this.on || !this.ctx) return;
    const c = this.ctx, out = c.createGain(); out.gain.value = 0.55; out.connect(c.destination);
    at = at || c.currentTime;
    freqs.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), t0 = at + i * step;
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + len + 0.02);
    });
  },
};
$('btn-sound').setAttribute('aria-pressed', sound.on);
$('btn-sound').onclick = () => {
  sound.on = !sound.on;
  try { localStorage.setItem('sound', sound.on ? 'on' : 'off'); } catch (e) { /* private mode */ }
  $('btn-sound').setAttribute('aria-pressed', sound.on);
  if (sound.on) { sound.unlock(); sound.hit(60); }
};

// ----------------------------------------------------------- overlay mode
/** Full-screen camera with a big HUD scoreboard, score-coloured rings and hit markers. */
function setOverlay(on) {
  document.body.classList.toggle('overlay', on);
  $('btn-overlay').setAttribute('aria-pressed', on);
  try { localStorage.setItem('overlay', on ? 'on' : 'off'); } catch (e) { /* private mode */ }
  fitViewer();
  requestAnimationFrame(drawOverlay);
}

// ------------------------------------------------------------ live layout
/** Size the camera view to the room left between the scoreboard and the
 * controls, so Start is on screen without scrolling. Uses the small viewport
 * height, so Safari's toolbar sliding in and out doesn't resize it. */
const vhProbe = document.createElement('div');
vhProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
document.body.append(vhProbe);
function fitViewer() {
  const v = $('viewer');
  if ($('pane-live').hidden || document.body.classList.contains('overlay')) return;
  const vr = v.getBoundingClientRect(), status = $('live-status');
  const below = status.getBoundingClientRect().bottom + parseFloat(getComputedStyle(status).marginBottom) - vr.bottom;
  const safeBottom = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const room = vhProbe.offsetHeight - (vr.top + window.scrollY) - below - safeBottom - 6;
  const full = v.parentElement.clientWidth;
  const h = Math.round(Math.max(280, Math.min(room, (full * 16) / 9)));
  // the preview fills the box (object-fit: cover); narrow the box rather than crop away more than ~40% of the picture
  const cardUp = document.body.classList.contains('g-card'); // a game card covers the view: use the width
  const w = live.w && live.h && !cardUp ? Math.min(full, Math.round(h * (live.w / live.h) * 1.6)) : full;
  setVar(v, '--fit-h', h + 'px');
  setVar(v, '--fit-w', w < full ? w + 'px' : '');
}
function setVar(el, name, value) {
  if (el.style.getPropertyValue(name) === value) return;
  if (value) el.style.setProperty(name, value); else el.style.removeProperty(name);
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => fitViewer());
  ['.topbar', '#board', '.live-controls'].forEach((q) => ro.observe(document.querySelector(q)));
}
window.addEventListener('resize', fitViewer);
document.fonts?.ready.then(fitViewer);
$('btn-overlay').onclick = () => setOverlay(!document.body.classList.contains('overlay'));
$('btn-exit-overlay').onclick = () => setOverlay(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('overlay')) setOverlay(false); });

// ---------------------------------------------------------------- workers
function setStatus(text) { $('live-status').textContent = text; }
function readyText() {
  if (!frameReady) return 'Loading…';
  if (!measureReady) return 'Loading ring reader (first time can take a few seconds)…';
  return 'Ready.';
}
function showError(message) {
  setStatus('Error: ' + message);
  $('clip-status').textContent = 'Error: ' + message;
}
frameWorker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      frameReady = true;
      $('btn-live').disabled = false;
      $('btn-game').disabled = false;
      $('file').disabled = false;
      if (!live.running) setStatus(readyText());
      break;
    case 'error': showError(m.message); clipRun.active = false; $('btn-cancel').hidden = true; $('file').disabled = false; break;
    case 'frame-done':
      live.outstanding--;
      live.procMs = live.procMs * 0.9 + m.ms * 0.1;
      if (mode === 'game') game.onFrame(m);
      break;
    case 'clip-info':
      clipRun.info = `${m.frames} frames · ${m.width}×${m.height} · ${m.codec}`;
      $('clip-status').textContent = clipRun.info;
      break;
    case 'progress': {
      $('prog-bar').style.width = (m.total ? (100 * m.done) / m.total : 0) + '%';
      const rate = m.done / Math.max(m.ms / 1000, 1e-3);
      const left = (m.total - m.done) / Math.max(rate, 1e-3);
      $('clip-status').textContent = `Frame ${m.done} / ${m.total} · ${rate.toFixed(0)} fps · ~${Math.ceil(left)} s left`;
      break;
    }
    case 'clip-done':
      clipRun.jobsTotal = m.jobs; clipRun.ms = m.ms; clipRun.cancelled = m.cancelled;
      checkClipDone();
      break;
  }
};
measureWorker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      measureReady = true;
      if (!live.running) setStatus(readyText());
      if (mode === 'game') game.paint();
      break;
    case 'error': showError(m.message); break;
    case 'shot':
      if (m.shot.epoch !== live.epoch) break; // from an earlier scoring session
      if (mode === 'game') game.onShot(m.shot, m.thumb); else addShot(m.shot, m.thumb);
      break;
    case 'located': if (mode === 'game') game.onLocated(m); break;
    case 'job-done': clipRun.jobsDone++; checkClipDone(); break;
  }
};
function checkClipDone() {
  if (!clipRun.active || clipRun.jobsTotal === null) return;
  if (clipRun.jobsDone < clipRun.jobsTotal) {
    $('clip-status').textContent = `Reading rings… ${clipRun.jobsDone} / ${clipRun.jobsTotal}`;
    return;
  }
  clipRun.active = false;
  const total = board.shots.reduce((a, x) => a + x.score, 0);
  $('clip-status').textContent = clipRun.cancelled ? 'Cancelled.'
    : `Done: ${board.shots.length} shots, ${total} points (${(clipRun.ms / 1000).toFixed(0)} s).`;
  $('btn-cancel').hidden = true;
  $('file').disabled = false;
}
frameWorker.onerror = (e) => showError('frame worker: ' + e.message);
measureWorker.onerror = (e) => showError('measure worker: ' + e.message);

// ------------------------------------------------------------------- tabs
function setMode(m) {
  if (m === mode) return;
  if (live.running) stopLive();
  live.startToken++; live.epoch++;
  if (mode === 'game') game.leave();
  mode = m;
  store.set('mode', m);
  for (const t of ['live', 'game', 'clip']) $('tab-' + t).setAttribute('aria-selected', m === t);
  $('pane-live').hidden = m === 'clip'; // the game uses the live camera view
  $('pane-clip').hidden = m !== 'clip';
  document.body.classList.toggle('game', m === 'game');
  // overlay mode belongs to the live camera; come back to it with the Live or Game tab
  if (m === 'clip') document.body.classList.remove('overlay');
  else if (savedOverlay()) setOverlay(true);
  resetBoard();
  if (m === 'game') game.enter();
  fitViewer();
}
function savedOverlay() { try { return localStorage.getItem('overlay') === 'on'; } catch (e) { return false; } }
$('tab-live').onclick = () => setMode('live');
$('tab-game').onclick = () => setMode('game');
$('tab-clip').onclick = () => setMode('clip');

// ------------------------------------------------------------------- live
const live = {
  running: false, stream: null, canvas: null, ctx: null, w: 0, h: 0,
  outstanding: 0, procMs: 0, frames: 0, dropped: 0, t0: 0, captureFps: 60, wakeLock: null,
  gen: 0, // bumped on every start/stop so a frame loop from an earlier run can't keep going
  epoch: 0, // scoring session: shots carry it, and only the current session's count
  startToken: 0, starting: null, // camera start in progress (see startLive)
  lastMT: null, lastPF: null, // media time / presented-frame count of the last frame sent
};
const video = $('video');

const params = new URLSearchParams(location.search);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ } },
};

// ------------------------------------------------------------------- zoom
// Uses the camera's own zoom when Safari exposes it (it can switch to the
// telephoto lens); otherwise crops the centre of each frame before scoring
// ("digital" zoom), and the preview is scaled to match.
const zoom = { value: 1, min: 1, max: 4, native: false, track: null, pending: null, applying: false };

function setupZoom(track) {
  zoom.track = track;
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoom.native = true;
    zoom.min = caps.zoom.min;
    zoom.max = Math.min(caps.zoom.max, 15);
    zoom.value = (track.getSettings && track.getSettings().zoom) || zoom.min;
  } else {
    zoom.native = false; zoom.min = 1; zoom.max = 4; zoom.value = 1;
  }
  const slider = $('zoom');
  slider.min = zoom.min; slider.max = zoom.max; slider.step = 0.05;
  slider.disabled = false;
  $('zoom-row').hidden = false;
  const saved = parseFloat(store.get('zoom'));
  setZoom(Number.isFinite(saved) ? saved : zoom.value);
}

function setZoom(z) {
  z = Math.min(zoom.max, Math.max(zoom.min, z));
  zoom.value = z;
  $('zoom').value = z;
  $('zoom-val').textContent = z.toFixed(1) + '×';
  store.set('zoom', z.toFixed(2));
  if (zoom.native) {
    video.style.transform = '';
    applyNativeZoom(z);
  } else {
    video.style.transform = z > 1.001 ? `scale(${z})` : '';
  }
  drawOverlay();
}

/** applyConstraints is slow on iOS: apply only the latest value, one at a time. */
function applyNativeZoom(z) {
  zoom.pending = z;
  if (zoom.applying) return;
  zoom.applying = true;
  (async () => {
    while (zoom.pending !== null) {
      const v = zoom.pending;
      zoom.pending = null;
      try {
        await zoom.track.applyConstraints({ advanced: [{ zoom: v }] });
      } catch (e) {
        zoom.native = false; zoom.min = 1; zoom.max = 4; // fall back to cropping
        $('zoom').min = 1; $('zoom').max = 4;
        zoom.applying = false;
        setZoom(v);
        return;
      }
    }
    zoom.applying = false;
  })();
}

$('zoom').oninput = () => setZoom(+$('zoom').value);

// pinch on the preview
{
  const viewer = document.querySelector('.viewer');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  viewer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && live.running) { pinch = { d0: dist(e.touches), z0: zoom.value }; e.preventDefault(); }
  }, { passive: false });
  viewer.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) { setZoom(pinch.z0 * dist(e.touches) / pinch.d0); e.preventDefault(); }
  }, { passive: false });
  viewer.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
}

// ------------------------------------------------------------------ lenses
async function listLenses(currentId) {
  const sel = $('lens');
  let cams = [];
  try { cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { /* none */ }
  const back = cams.filter((d) => /back|rear|environment/i.test(d.label));
  const list = back.length ? back : cams;
  if (list.length < 2) { sel.hidden = true; return; }
  sel.innerHTML = '';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = (d.label || 'Camera').replace(/^Back /i, '').replace(/ Camera$/i, '') || 'Camera';
    if (d.deviceId === currentId) o.selected = true;
    sel.append(o);
  }
  sel.hidden = false;
}
$('lens').onchange = async () => {
  store.set('lens', $('lens').value);
  if (live.running && !params.get('demo')) await openCamera($('lens').value);
};

/** Magnification of the working frame relative to the main lens at 1x (lens choice × zoom). */
function viewZoom() {
  const name = $('lens').selectedOptions[0]?.textContent || '';
  return (/tele/i.test(name) ? 5 : /ultra/i.test(name) ? 0.5 : 1) * zoom.value;
}

// ---------------------------------------------------------- motion sensors
// The gyroscope tells us when the phone itself moves, so camera jiggle is not mistaken
// for the paper flapping on a hit. Converted to "how far the picture slides per frame".
const sensors = {
  enabled: false, peakDeg: 0, peakAcc: 0, movingUntil: 0, lastEvent: -1e9, quietSince: 0,
  /** Must run inside a tap handler: iOS asks the user once. */
  request() {
    const DME = window.DeviceMotionEvent;
    if (!DME) return;
    const listen = () => {
      if (this.enabled) return;
      this.enabled = true;
      window.addEventListener('devicemotion', (e) => {
        const r = e.rotationRate || {}, a = e.acceleration || {};
        if (r.alpha == null && r.beta == null) return; // no gyroscope (e.g. a desktop browser)
        const pitchYaw = Math.hypot(r.beta || 0, r.gamma || 0), roll = Math.abs(r.alpha || 0);
        const now = performance.now();
        this.lastEvent = now;
        if (pitchYaw + roll > 0.25) this.quietSince = now; // hand tremor is well above this
        this.peakDeg = Math.max(this.peakDeg, pitchYaw + 0.35 * roll); // deg/s
        this.peakAcc = Math.max(this.peakAcc, Math.hypot(a.x || 0, a.y || 0, a.z || 0)); // m/s^2
      });
    };
    if (typeof DME.requestPermission === 'function') {
      DME.requestPermission().then((st) => { if (st === 'granted') listen(); }).catch(() => {});
    } else {
      listen();
    }
  },
  /** Phone lying still on something (gyro below hand tremor for 2 s): the game asks for hand-held. */
  resting() {
    const now = performance.now();
    return this.enabled && now - this.lastEvent < 500 && now - this.quietSince > 2000;
  },
  /** Image slide (working px) since the last call, for one frame at `fps`. */
  take(fps) {
    if (!this.enabled) return undefined;
    const pxPerDeg = 12.5 * viewZoom(); // ~43° across the 540 px short side at 1x
    let px = (this.peakDeg / Math.max(fps, 1)) * pxPerDeg;
    if (this.peakAcc > 1.5) px = Math.max(px, 99); // a tap or bump on the phone
    this.peakDeg = 0; this.peakAcc = 0;
    if (px > 4) this.movingUntil = performance.now() + 400; // scorer's "phone moved" level
    return px;
  },
};

// ------------------------------------------------------------------- live
async function openCamera(deviceId) {
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
  let stream = null;
  if (deviceId) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, deviceId: { exact: deviceId } } }); } catch (e) { /* lens gone */ }
  }
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: { ideal: 'environment' } } });
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = stream;
  video.srcObject = stream;
  await video.play();
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => {
    if (live.stream !== stream || document.visibilityState !== 'visible') return; // reopened on return
    stopLive();
    setStatus('The camera stopped.');
    if (mode === 'game') game.paint();
  });
  const settings = track.getSettings();
  live.captureFps = Math.round(settings.frameRate || 30);
  sizeWork();
  setupZoom(track);
  listLenses(settings.deviceId);
}

/** Open the camera and start scoring. Only one start runs at a time; a start overtaken by
 * Stop, a tab switch or another start (live.startToken changed) shuts its camera again. */
function startLive() {
  if (!frameReady) return Promise.resolve();
  if (live.starting) return live.starting;
  const token = ++live.startToken, m0 = mode;
  const stale = () => token !== live.startToken || mode !== m0;
  live.starting = (async () => {
    try {
      if (params.get('demo')) await startDemo(params.get('demo'), +(params.get('capture') || 240));
      else await openCamera(store.get('lens'));
    } catch (err) {
      if (!stale()) setStatus('Camera unavailable: ' + err.message);
      return;
    }
    if (stale()) { closeCamera(); return; }
    await beginLive();
  })().finally(() => { live.starting = null; });
  return live.starting;
}
function closeCamera() {
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = null;
  video.srcObject = null;
  video.removeAttribute('src');
}
/** Start a fresh scoring session in the frame worker; shots from earlier sessions are dropped. */
function restartScoring() {
  frameWorker.postMessage({ type: 'live-start', captureFps: live.captureFps, epoch: ++live.epoch });
  live.lastMT = live.lastPF = null;
}

/** Working frame size from the video's current size (short side WORK_SHORT). */
function sizeWork() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = WORK_SHORT / Math.min(vw, vh);
  live.w = Math.round(vw * s); live.h = Math.round(vh * s);
  if (!live.canvas) live.canvas = document.createElement('canvas');
  live.canvas.width = live.w; live.canvas.height = live.h;
  live.ctx = live.canvas.getContext('2d', { willReadFrequently: true });
  fitViewer();
}

async function beginLive() {
  sizeWork();
  live.outstanding = 0; live.frames = 0; live.dropped = 0; live.t0 = performance.now();
  live.running = true;
  resetBoard(mode === 'game'); // a game keeps its shot list across turns
  restartScoring();
  $('btn-live').textContent = 'Stop';
  $('live-hint').hidden = true;
  await startFrameLoop();
}
async function startFrameLoop() {
  const gen = ++live.gen;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch (e) { /* optional */ }
  if (gen !== live.gen || !live.running) { lock?.release?.(); return; } // stopped meanwhile
  live.wakeLock?.release?.();
  live.wakeLock = lock;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now, m) => onVideoFrame(gen, m));
  else requestAnimationFrame(() => onAnimFrame(gen));
  statusLoop(gen);
}
// iOS stops the camera (and drops the wake lock) while the app is in the background: resume both
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden' && mode === 'game') { game.onHidden(); return; }
  if (document.visibilityState !== 'visible' || !live.running || !live.stream) return;
  const track = live.stream.getVideoTracks()[0];
  try {
    if (!track || track.readyState !== 'live' || track.muted) await openCamera(store.get('lens'));
    startFrameLoop();
  } catch (e) {
    setStatus('Camera unavailable: ' + e.message);
  }
});

/** Live pipeline fed from a video file instead of the camera (for testing). */
async function startDemo(url, captureFps) {
  video.srcObject = null;
  video.src = url;
  video.loop = false;
  await video.play();
  live.stream = null;
  live.captureFps = captureFps;
  setupZoom(null);
}

function grabFrame(meta) {
  if (live.outstanding >= 2) { live.dropped++; return; } // worker is behind: skip rather than lag
  // real seconds since the previous frame sent (a slo-mo demo file has one capture frame per frame)
  let dt = 1 / live.captureFps;
  if (meta && params.get('demo')) {
    if (live.lastPF != null && meta.presentedFrames > live.lastPF) dt = (meta.presentedFrames - live.lastPF) / live.captureFps;
    live.lastPF = meta.presentedFrames;
  } else if (meta) {
    if (live.lastMT != null && meta.mediaTime > live.lastMT) dt = Math.min(meta.mediaTime - live.lastMT, 0.25);
    live.lastMT = meta.mediaTime;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  if (Math.abs(vw / vh - live.w / live.h) > 0.01) sizeWork(); // camera changed orientation/size
  if (!zoom.native && zoom.value > 1.001) {
    const sw = vw / zoom.value, sh = vh / zoom.value; // centre crop = digital zoom
    live.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, live.w, live.h);
  } else {
    live.ctx.drawImage(video, 0, 0, live.w, live.h);
  }
  const img = live.ctx.getImageData(0, 0, live.w, live.h);
  live.outstanding++;
  live.frames++;
  if (mode === 'game' && game.wantsLocate()) {
    const copy = img.data.slice();
    measureWorker.postMessage({ type: 'locate', buffer: copy.buffer, width: live.w, height: live.h }, [copy.buffer]);
  }
  const motionPx = sensors.take(live.captureFps);
  frameWorker.postMessage({ type: 'frame', buffer: img.data.buffer, width: live.w, height: live.h, motionPx, dt }, [img.data.buffer]);
  $('steady').hidden = performance.now() > sensors.movingUntil;
}
function onVideoFrame(gen, meta) {
  if (!live.running || gen !== live.gen) return;
  grabFrame(meta);
  video.requestVideoFrameCallback((now, m) => onVideoFrame(gen, m));
}
let lastVideoTime = -1;
function onAnimFrame(gen) {
  if (!live.running || gen !== live.gen) return;
  if (video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; grabFrame(); }
  requestAnimationFrame(() => onAnimFrame(gen));
}
function statusLoop(gen) {
  if (!live.running || gen !== live.gen) return;
  const sec = (performance.now() - live.t0) / 1000;
  setStatus(`Scoring ${(live.frames / sec).toFixed(0)} of ${live.captureFps} fps` +
    ` · ${live.procMs.toFixed(1)} ms${live.dropped ? ` · ${live.dropped} skipped` : ''}` +
    (sensors.enabled ? ' · motion on' : '') +
    (measureReady ? '' : ' · ring reader loading'));
  setTimeout(() => statusLoop(gen), 500);
}
function stopLive() {
  live.running = false;
  live.gen++; live.startToken++;
  frameWorker.postMessage({ type: 'live-stop' });
  closeCamera();
  video.style.transform = '';
  $('zoom').disabled = true;
  $('zoom-row').hidden = true;
  live.wakeLock?.release?.();
  $('btn-live').textContent = 'Start';
  $('steady').hidden = true;
  $('live-hint').hidden = false;
  setStatus('Stopped.');
}
$('btn-live').onclick = () => { sound.unlock(); if (!live.running) sensors.request(); return live.running ? stopLive() : startLive(); };
$('btn-reset-live').onclick = () => {
  resetBoard();
  if (live.running) restartScoring();
};

/** Overlay mode: tint the real target's rings in score colours and mark every hit. */
function drawOverlay() {
  const cv = $('overlay');
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!cameraMode() || !document.body.classList.contains('overlay') || !board.shots.length || !live.w) return;
  ctx.scale(dpr, dpr);
  const last = board.shots[board.shots.length - 1];
  const [cx, cy, sc] = viewPoint(last.center[0], last.center[1], last);
  const band = (last.R / 7) * sc;
  for (let z = 6; z >= 0; z--) { // outer to inner translucent bands
    ctx.beginPath(); ctx.arc(cx, cy, band * (z + 1), 0, 2 * Math.PI);
    if (z > 0) ctx.arc(cx, cy, band * z, 0, 2 * Math.PI, true);
    ctx.fillStyle = ZONE_COLORS[z]; ctx.globalAlpha = 0.16; ctx.fill('evenodd');
    ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5; ctx.strokeStyle = ZONE_COLORS[z];
    ctx.beginPath(); ctx.arc(cx, cy, band * (z + 1), 0, 2 * Math.PI); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = '13px Bungee, sans-serif'; ctx.textBaseline = 'middle';
  board.shots.forEach((sh, i) => {
    const [bx, by] = viewPoint(sh.ball[0], sh.ball[1], sh);
    const latest = i === board.shots.length - 1, col = ZONE_COLORS[sh.score ? sh.zone : 7];
    ctx.beginPath(); ctx.arc(bx, by, latest ? 9 : 6, 0, 2 * Math.PI);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#1b1511'; ctx.stroke();
    if (latest) { ctx.beginPath(); ctx.arc(bx, by, 15, 0, 2 * Math.PI); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke(); }
    const label = sh.score ? String(sh.score) : '×';
    ctx.lineWidth = 4; ctx.strokeStyle = '#1b1511'; ctx.strokeText(label, bx + 12, by - 12);
    ctx.fillStyle = '#f4ead6'; ctx.fillText(label, bx + 12, by - 12);
  });
}
window.addEventListener('resize', drawOverlay);

// ------------------------------------------------------------------- clip
$('file').onchange = () => {
  sound.unlock();
  const file = $('file').files[0];
  if (!file) return;
  resetBoard();
  $('clip-progress').hidden = false;
  $('btn-cancel').hidden = false;
  $('prog-bar').style.width = '0%';
  $('clip-status').textContent = 'Reading video…';
  $('file').disabled = true;
  Object.assign(clipRun, { active: true, jobsTotal: null, jobsDone: 0, cancelled: false });
  frameWorker.postMessage({ type: 'clip', file, captureFps: +$('rate').value, epoch: ++live.epoch });
  $('file').value = '';
};
$('btn-cancel').onclick = () => frameWorker.postMessage({ type: 'cancel' });

// ---------------------------------------------------------------- offline
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ------------------------------------------------------------------ start
renderBoard(true);
if (savedOverlay()) setOverlay(true);
