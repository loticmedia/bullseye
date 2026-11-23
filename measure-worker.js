/* Measure worker: loads OpenCV.js and turns impact jobs (from frame-worker) into
 * scored shots with a thumbnail.
 *
 * In:  {type:'init', port}            MessagePort from frame-worker
 *      via port: {type:'reset'} | {type:'job', job}
 *      {type:'locate', buffer, width, height, id}   one RGBA frame: where is the target? (2-player framing)
 * Out: {type:'ready'} | {type:'error', message}
 *      {type:'shot', shot, thumb}     thumb: JPEG Blob of the target with the ball marked
 *      {type:'job-done'}              one per job (shot or not), for progress accounting
 *      {type:'located', id, target, width, height}   target: [cx, cy, R, conf] or null
 */
/* global cv, Bullseye */
'use strict';
importScripts('vendor/opencv.js', 'scorer.js');

let Measurer = null, measurer = null;
const ZONE_COLORS = ['#ffcf33', '#ff8f3a', '#f2545b', '#d561b8', '#8b78f6', '#45a6f5', '#33c3b0', '#8a7f72'];

const ready = (async () => {
  let c = self.cv;
  if (c instanceof Promise) c = await c;
  else if (!c.Mat) await new Promise((r) => { c.onRuntimeInitialized = r; });
  self.cv = c;
  Measurer = Bullseye.createMeasurer(c);
  measurer = new Measurer();
})();

async function thumbnail(shot, frame) {
  if (!frame) return null;
  try {
    const [cx, cy] = shot.center, R = shot.R;
    const half = Math.round(R * 1.3), size = 2 * half;
    const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
    const padded = new cv.Mat();
    cv.copyMakeBorder(frame, padded, size, size, size, size, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0));
    const roi = padded.roi(new cv.Rect(x0 + size, y0 + size, size, size));
    const S = 200, small = new cv.Mat(), rgba = new cv.Mat();
    cv.resize(roi, small, new cv.Size(S, S), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, rgba, cv.COLOR_RGB2RGBA);
    const img = new ImageData(new Uint8ClampedArray(rgba.data), S, S);
    roi.delete(); padded.delete(); small.delete(); rgba.delete();
    const oc = new OffscreenCanvas(S, S), ctx = oc.getContext('2d');
    ctx.putImageData(img, 0, 0);
    const s = S / size, P = (x, y) => [(x - x0) * s, (y - y0) * s];
    const [ccx, ccy] = P(cx, cy);
    ctx.strokeStyle = 'rgba(255,0,255,0.5)'; ctx.lineWidth = 1;
    for (let k = 1; k <= 7; k++) { ctx.beginPath(); ctx.arc(ccx, ccy, (R * k / 7) * s, 0, 2 * Math.PI); ctx.stroke(); }
    const [bx, by] = P(shot.ball[0], shot.ball[1]);
    ctx.strokeStyle = ZONE_COLORS[shot.zone] || '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(bx, by, 10, 0, 2 * Math.PI); ctx.stroke();
    return await oc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } catch (e) {
    return null;
  }
}

// jobs are handled strictly one after another (the target position carries over)
let chain = Promise.resolve();
function onPortMessage(e) {
  const msg = e.data;
  chain = chain.then(async () => {
    await ready;
    if (msg.type === 'reset') { measurer = new Measurer(); return; }
    if (msg.type !== 'job') return;
    try {
      const shot = measurer.measure(msg.job);
      if (shot) {
        shot.epoch = msg.job.epoch;
        const frame = measurer.impactFrame(msg.job);
        const thumb = await thumbnail(shot, frame);
        if (frame) frame.delete();
        postMessage({ type: 'shot', shot, thumb });
      }
    } catch (err) {
      postMessage({ type: 'error', message: 'measuring a shot failed: ' + (err && err.message ? err.message : err) });
    }
    postMessage({ type: 'job-done' });
  });
}

onmessage = async (e) => {
  if (e.data.type === 'locate') {
    const { buffer, width, height, id } = e.data;
    chain = chain.then(async () => {
      await ready;
      let target = null;
      try { target = measurer.locate(new Uint8Array(buffer), width, height); } catch (err) { /* treat as not found */ }
      postMessage({ type: 'located', id, target, width, height });
    });
    return;
  }
  if (e.data.type !== 'init') return;
  e.data.port.onmessage = onPortMessage;
  try {
    await ready;
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'error', message: 'OpenCV failed to load: ' + err });
  }
};
