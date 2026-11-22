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
let mode = 'live';
const clipRun = { active: false, jobsTotal: null, jobsDone: 0, info: '', ms: 0, cancelled: false };

// ------------------------------------------------------------- scoreboard
const board = { shots: [], shown: 0 };
function resetBoard() {
  board.shots = [];
  $('list').innerHTML = '';
  renderBoard(true);
  drawOverlay();
}
function stats() {
  const s = board.shots, hits = s.filter((x) => x.score > 0);
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
      str.append(li);
    }
    str.scrollLeft = str.scrollWidth;
  }
  const last = board.shots[board.shots.length - 1], hl = $('hud-last');
  hl.textContent = last ? (last.score || 'MISS') : '';
  hl.style.background = last ? (last.score ? ZONE_COLORS[last.zone] : 'var(--panel-hi)') : '';
  hl.style.color = last && !last.score ? 'var(--z7)' : '';
  $('list-count').textContent = board.shots.length ? `· ${board.shots.length}` : '';
  $('list-empty').hidden = board.shots.length > 0;
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), r = sec - 60 * m;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
function addShot(shot, thumb) {
  shot.n = board.shots.length + 1;
  shot.zoomAt = mode === 'live' && !zoom.native ? zoom.value : 1;
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
  meta.innerHTML = `<b>Shot ${shot.n}</b>${ring} · ${fmtTime(shot.time)}${shot.note ? ' · low confidence' : ''}`;
  const pts = document.createElement('div');
  pts.className = 'pts';
  pts.textContent = shot.score || 'miss';
  if (shot.score) pts.style.background = ZONE_COLORS[shot.zone];
  li.append(edge, img, meta, pts);
  $('list').prepend(li);
  renderBoard();
  const hl = $('hud-last'); hl.classList.remove('fresh'); void hl.offsetWidth; hl.classList.add('fresh');
  drawOverlay();
  celebrate(shot);
}
function ordinalRing(zone) { return ['Centre', 'Inner', '2nd', '3rd', '4th', '5th', 'Outer'][zone] || 'Outer'; }

// ------------------------------------------------------------ hit effects
/** Working-frame coordinates -> CSS pixels inside the viewer (video is object-fit: contain). */
function viewPoint(x, y, sh) {
  const r = $('viewer').getBoundingClientRect();
  const s = Math.min(r.width / live.w, r.height / live.h);
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
  const liveView = mode === 'live' && live.running && live.w;
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
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
    const notes = score === 100 ? [523, 659, 784, 1047] : score >= 50 ? [659, 988] : score ? [587] : [];
    notes.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), at = t + 0.08 + i * 0.09;
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g).connect(out); o.start(at); o.stop(at + 0.18);
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
  requestAnimationFrame(drawOverlay);
}
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
      $('file').disabled = false;
      if (!live.running) setStatus(readyText());
      break;
    case 'error': showError(m.message); clipRun.active = false; $('btn-cancel').hidden = true; $('file').disabled = false; break;
    case 'frame-done':
      live.outstanding--;
      live.procMs = live.procMs * 0.9 + m.ms * 0.1;
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
      break;
    case 'error': showError(m.message); break;
    case 'shot': addShot(m.shot, m.thumb); break;
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
  mode = m;
  $('tab-live').setAttribute('aria-selected', m === 'live');
  $('tab-clip').setAttribute('aria-selected', m === 'clip');
  $('pane-live').hidden = m !== 'live';
  $('pane-clip').hidden = m !== 'clip';
  // overlay mode belongs to the live camera; come back to it with the Live tab
  if (m === 'clip') document.body.classList.remove('overlay');
  else if (savedOverlay()) setOverlay(true);
  resetBoard();
}
function savedOverlay() { try { return localStorage.getItem('overlay') === 'on'; } catch (e) { return false; } }
$('tab-live').onclick = () => setMode('live');
$('tab-clip').onclick = () => setMode('clip');

// ------------------------------------------------------------------- live
const live = {
  running: false, stream: null, canvas: null, ctx: null, w: 0, h: 0,
  outstanding: 0, procMs: 0, frames: 0, dropped: 0, t0: 0, captureFps: 60, wakeLock: null,
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
  const settings = track.getSettings();
  live.captureFps = Math.round(settings.frameRate || 30);
  sizeWork();
  setupZoom(track);
  listLenses(settings.deviceId);
}

async function startLive() {
  if (!frameReady) return;
  if (params.get('demo')) return startDemo(params.get('demo'), +(params.get('capture') || 240));
  try {
    await openCamera(store.get('lens'));
  } catch (err) {
    setStatus('Camera unavailable: ' + err.message);
    return;
  }
  beginLive();
}

/** Working frame size from the video's current size (short side WORK_SHORT). */
function sizeWork() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = WORK_SHORT / Math.min(vw, vh);
  live.w = Math.round(vw * s); live.h = Math.round(vh * s);
  if (!live.canvas) live.canvas = document.createElement('canvas');
  live.canvas.width = live.w; live.canvas.height = live.h;
  live.ctx = live.canvas.getContext('2d', { willReadFrequently: true });
}

async function beginLive() {
  sizeWork();
  live.outstanding = 0; live.frames = 0; live.dropped = 0; live.t0 = performance.now();
  live.running = true;
  resetBoard();
  frameWorker.postMessage({ type: 'live-start', captureFps: live.captureFps });
  $('btn-live').textContent = 'Stop';
  $('live-hint').hidden = true;
  try { live.wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* optional */ }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
  else requestAnimationFrame(onAnimFrame);
  statusLoop();
}

/** Live pipeline fed from a video file instead of the camera (for testing). */
async function startDemo(url, captureFps) {
  video.srcObject = null;
  video.src = url;
  video.loop = false;
  await video.play();
  live.stream = null;
  live.captureFps = captureFps;
  setupZoom(null);
  beginLive();
}

function grabFrame() {
  if (live.outstanding >= 2) { live.dropped++; return; } // worker is behind: skip rather than lag
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
  frameWorker.postMessage({ type: 'frame', buffer: img.data.buffer, width: live.w, height: live.h }, [img.data.buffer]);
}
function onVideoFrame() {
  if (!live.running) return;
  grabFrame();
  video.requestVideoFrameCallback(onVideoFrame);
}
let lastVideoTime = -1;
function onAnimFrame() {
  if (!live.running) return;
  if (video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; grabFrame(); }
  requestAnimationFrame(onAnimFrame);
}
function statusLoop() {
  if (!live.running) return;
  const sec = (performance.now() - live.t0) / 1000;
  setStatus(`Camera ${live.captureFps} fps · scoring ${(live.frames / sec).toFixed(0)} fps` +
    ` · ${live.procMs.toFixed(1)} ms/frame${live.dropped ? ` · ${live.dropped} skipped` : ''}` +
    (zoom.native ? ' · lens zoom' : zoom.value > 1.001 ? ' · cropped zoom' : '') +
    (measureReady ? '' : ' · ring reader still loading'));
  setTimeout(statusLoop, 500);
}
function stopLive() {
  live.running = false;
  frameWorker.postMessage({ type: 'live-stop' });
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = null;
  video.srcObject = null;
  video.removeAttribute('src');
  video.style.transform = '';
  $('zoom').disabled = true;
  live.wakeLock?.release?.();
  $('btn-live').textContent = 'Start';
  $('live-hint').hidden = false;
  setStatus('Stopped.');
}
$('btn-live').onclick = () => { sound.unlock(); return live.running ? stopLive() : startLive(); };
$('btn-reset-live').onclick = () => {
  resetBoard();
  if (live.running) frameWorker.postMessage({ type: 'live-start', captureFps: live.captureFps });
};

/** Overlay mode: tint the real target's rings in score colours and mark every hit. */
function drawOverlay() {
  const cv = $('overlay');
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (mode !== 'live' || !document.body.classList.contains('overlay') || !board.shots.length || !live.w) return;
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
  frameWorker.postMessage({ type: 'clip', file, captureFps: +$('rate').value });
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
