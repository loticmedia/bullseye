/* Bullseye web app — UI, camera capture and clip selection.
 * Scoring runs in frame-worker.js (every frame) and measure-worker.js (each impact).
 * Test hook: ?demo=<video url>[&capture=240] plays a video through the live pipeline. */
'use strict';

const $ = (id) => document.getElementById(id);
const ZONE_COLORS = ['#ffd400', '#ff8c00', '#ff5a36', '#e0457b', '#9b59ff', '#3d8bff', '#22c4c4', '#9aa0a6'];
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
const board = { shots: [] };
function resetBoard() {
  board.shots = [];
  $('list').innerHTML = '';
  renderBoard();
  drawOverlay();
}
function renderBoard() {
  const s = board.shots;
  $('total').textContent = s.reduce((a, x) => a + x.score, 0);
  $('shots').textContent = s.length;
  $('hits').textContent = s.filter((x) => x.score > 0).length;
  $('last').textContent = s.length ? (s[s.length - 1].score || 'miss') : '–';
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), r = sec - 60 * m;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
function addShot(shot, thumb) {
  shot.n = board.shots.length + 1;
  board.shots.push(shot);
  const li = document.createElement('li');
  if (!shot.score) li.className = 'miss';
  const img = document.createElement('img');
  img.alt = `shot ${shot.n}`;
  if (thumb) img.src = URL.createObjectURL(thumb);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<b>Shot ${shot.n}</b>${fmtTime(shot.time)}${shot.note ? ' · low confidence' : ''}`;
  const pts = document.createElement('div');
  pts.className = 'pts';
  pts.textContent = shot.score || 'miss';
  if (shot.score) pts.style.color = ZONE_COLORS[shot.zone];
  li.append(img, meta, pts);
  $('list').prepend(li);
  renderBoard();
  drawOverlay();
}

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
      $('prog').value = m.total ? m.done / m.total : 0;
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
  resetBoard();
}
$('tab-live').onclick = () => setMode('live');
$('tab-clip').onclick = () => setMode('clip');

// ------------------------------------------------------------------- live
const live = {
  running: false, stream: null, canvas: null, ctx: null, w: 0, h: 0,
  outstanding: 0, procMs: 0, frames: 0, dropped: 0, t0: 0, captureFps: 60, wakeLock: null,
};
const video = $('video');

const params = new URLSearchParams(location.search);
async function startLive() {
  if (!frameReady) return;
  if (params.get('demo')) return startDemo(params.get('demo'), +(params.get('capture') || 240));
  try {
    live.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 },
        frameRate: { ideal: 60, max: 60 } },
    });
  } catch (err) {
    setStatus('Camera unavailable: ' + err.message);
    return;
  }
  video.srcObject = live.stream;
  await video.play();
  const settings = live.stream.getVideoTracks()[0].getSettings();
  live.captureFps = Math.round(settings.frameRate || 30);
  beginLive();
}

async function beginLive() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = WORK_SHORT / Math.min(vw, vh);
  live.w = Math.round(vw * s); live.h = Math.round(vh * s);
  live.canvas = document.createElement('canvas');
  live.canvas.width = live.w; live.canvas.height = live.h;
  live.ctx = live.canvas.getContext('2d', { willReadFrequently: true });
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
  beginLive();
}

function grabFrame() {
  if (live.outstanding >= 2) { live.dropped++; return; } // worker is behind: skip rather than lag
  live.ctx.drawImage(video, 0, 0, live.w, live.h);
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
  live.wakeLock?.release?.();
  $('btn-live').textContent = 'Start';
  $('live-hint').hidden = false;
  setStatus('Stopped.');
}
$('btn-live').onclick = () => (live.running ? stopLive() : startLive());
$('btn-reset-live').onclick = () => {
  resetBoard();
  if (live.running) frameWorker.postMessage({ type: 'live-start', captureFps: live.captureFps });
};

/** Target rings of the latest shot and every impact, over the live preview. */
function drawOverlay() {
  const cv = $('overlay');
  const rect = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (mode !== 'live' || !board.shots.length || !live.w) return;
  // map working coords -> canvas coords (video is object-fit: contain)
  const s = Math.min(cv.width / live.w, cv.height / live.h);
  const ox = (cv.width - live.w * s) / 2, oy = (cv.height - live.h * s) / 2;
  const P = (x, y) => [ox + x * s, oy + y * s];
  const last = board.shots[board.shots.length - 1];
  const [cx, cy] = P(last.center[0], last.center[1]);
  ctx.strokeStyle = 'rgba(255,0,255,0.5)';
  ctx.lineWidth = 1.5 * dpr;
  for (let k = 1; k <= 7; k++) { ctx.beginPath(); ctx.arc(cx, cy, (last.R * k / 7) * s, 0, 2 * Math.PI); ctx.stroke(); }
  board.shots.forEach((sh, idx) => {
    const [bx, by] = P(sh.ball[0], sh.ball[1]);
    ctx.fillStyle = ZONE_COLORS[sh.zone] || '#fff';
    ctx.globalAlpha = idx === board.shots.length - 1 ? 1 : 0.6;
    ctx.beginPath(); ctx.arc(bx, by, (idx === board.shots.length - 1 ? 7 : 4) * dpr, 0, 2 * Math.PI); ctx.fill();
  });
  ctx.globalAlpha = 1;
}
window.addEventListener('resize', drawOverlay);

// ------------------------------------------------------------------- clip
$('file').onchange = () => {
  const file = $('file').files[0];
  if (!file) return;
  resetBoard();
  $('clip-progress').hidden = false;
  $('btn-cancel').hidden = false;
  $('prog').value = 0;
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
