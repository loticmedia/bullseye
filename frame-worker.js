/* Frame worker: the per-frame stage (pure JS, no OpenCV) — live frames from the page,
 * or every frame of a video file decoded here with WebCodecs. Impact jobs go straight
 * to the measure worker over a MessagePort.
 *
 * In:  {type:'init', port}                      MessagePort to measure-worker
 *      {type:'live-start', captureFps}
 *      {type:'frame', buffer, width, height}    RGBA at working size (transferred)
 *      {type:'live-stop'}
 *      {type:'clip', file, captureFps}
 *      {type:'cancel'}
 * Out: {type:'ready'} | {type:'error', message}
 *      {type:'frame-done', ms}
 *      {type:'clip-info', frames, fps, width, height, codec}
 *      {type:'progress', done, total, ms}
 *      {type:'clip-done', jobs, cancelled, ms}
 */
/* global Bullseye, MP4Box, DataStream */
'use strict';
importScripts('scorer.js', 'vendor/mp4box.all.min.js');

let port = null, lut = null, scorer = null, cancelled = false, jobsSent = 0;

const ready = fetch('ball_lut.bin')
  .then((r) => { if (!r.ok) throw new Error('ball_lut.bin: HTTP ' + r.status); return r.arrayBuffer(); })
  .then((b) => { lut = new Uint8Array(b); });

function sendJobs(jobs) {
  for (const job of jobs) {
    const transfer = job.refs.map((r) => r.rgba.buffer);
    if (job.cur) transfer.push(job.cur.buffer);
    port.postMessage({ type: 'job', job }, transfer);
    jobsSent++;
  }
}

// ------------------------------------------------------------------- clip
function descriptionOf(file, track) {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the box header
    }
  }
  return undefined;
}

async function demux(blob) {
  const mp4 = MP4Box.createFile();
  const samples = [];
  let track = null, description, error = null;
  mp4.onError = (e) => { error = e; };
  mp4.onReady = (info) => {
    track = info.videoTracks[0];
    if (!track) return;
    description = descriptionOf(mp4, track);
    mp4.setExtractionOptions(track.id, null, { nbSamples: 1000 });
    mp4.start();
  };
  mp4.onSamples = (id, user, ss) => { for (const s of ss) samples.push(s); };
  const CH = 4 << 20;
  for (let pos = 0; pos < blob.size; pos += CH) {
    const ab = await blob.slice(pos, pos + CH).arrayBuffer();
    ab.fileStart = pos;
    mp4.appendBuffer(ab);
  }
  mp4.flush();
  if (!track) throw new Error(error ? 'Could not read video: ' + error : 'No video track found in this file');
  return { track, samples, description };
}

function rotationOf(track) {
  const m = track.matrix ? Array.from(track.matrix) : [65536, 0, 0, 0, 65536];
  const deg = Math.round(Math.atan2(m[1] / 65536, m[0] / 65536) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

async function scoreClip(msg) {
  cancelled = false; jobsSent = 0;
  const t0 = performance.now();
  const { track, samples, description } = await demux(msg.file);
  const total = samples.length;
  const fps = total / (track.duration / track.timescale);
  const rot = rotationOf(track);
  const cw = track.video.width, ch = track.video.height;
  const ow = rot % 180 ? ch : cw, oh = rot % 180 ? cw : ch; // displayed orientation
  postMessage({ type: 'clip-info', frames: total, fps, width: ow, height: oh, codec: track.codec });

  const s = Bullseye.WORK_SHORT / Math.min(ow, oh);
  const dw = Math.round(ow * s), dh = Math.round(oh * s);
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  scorer = new Bullseye.ShotScorer({ fps, captureFps: msg.captureFps || 240, lut });
  const config = { codec: track.codec, codedWidth: cw, codedHeight: ch, description };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error('This browser cannot decode ' + track.codec);
  const queue = [];
  let decodeError = null;
  const decoder = new VideoDecoder({ output: (f) => queue.push(f), error: (e) => { decodeError = e; } });
  decoder.configure(config);

  // decode order = sample order; frames come out in presentation order
  let fed = 0, done = 0, flushed = false, lastPost = 0;
  const feed = () => {
    while (fed < samples.length && decoder.decodeQueueSize < 8 && queue.length < 6) {
      const sm = samples[fed++];
      decoder.decode(new EncodedVideoChunk({
        type: sm.is_sync ? 'key' : 'delta',
        timestamp: Math.round(1e6 * sm.cts / sm.timescale),
        duration: Math.round(1e6 * sm.duration / sm.timescale),
        data: sm.data,
      }));
      sm.data = null;
    }
    if (fed === samples.length && !flushed) { flushed = true; decoder.flush().catch(() => {}); }
  };
  feed();
  let idle = 0;
  while (done < total && !cancelled) {
    if (decodeError) throw new Error('Decoding failed: ' + decodeError.message);
    if (!queue.length) {
      feed();
      await new Promise((r) => setTimeout(r, 1));
      if (flushed && !queue.length && decoder.decodeQueueSize === 0 && ++idle > 200) break;
      continue;
    }
    idle = 0;
    const frame = queue.shift();
    ctx.save();
    ctx.translate(dw / 2, dh / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const fw = rot % 180 ? dh : dw, fh = rot % 180 ? dw : dh;
    ctx.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
    ctx.restore();
    frame.close();
    feed();
    const img = ctx.getImageData(0, 0, dw, dh);
    sendJobs(scorer.push(new Uint8Array(img.data.buffer), dw, dh));
    done++;
    const now = performance.now();
    if (now - lastPost > 200) {
      lastPost = now;
      postMessage({ type: 'progress', done, total, ms: now - t0 });
      await new Promise((r) => setTimeout(r, 0)); // let 'cancel' messages in
    }
  }
  if (!cancelled) sendJobs(scorer.finish());
  for (const f of queue) f.close();
  try { decoder.close(); } catch (e) { /* closed */ }
  postMessage({ type: 'progress', done, total, ms: performance.now() - t0 });
  postMessage({ type: 'clip-done', jobs: jobsSent, cancelled, ms: performance.now() - t0 });
}

// --------------------------------------------------------------- dispatch
onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      port = msg.port;
      await ready;
      postMessage({ type: 'ready' });
      return;
    }
    await ready;
    if (msg.type === 'live-start') {
      scorer = new Bullseye.ShotScorer({ fps: msg.captureFps, captureFps: msg.captureFps, lut });
      jobsSent = 0;
      port.postMessage({ type: 'reset' });
    } else if (msg.type === 'frame') {
      if (!scorer) return;
      const t0 = performance.now();
      sendJobs(scorer.push(new Uint8Array(msg.buffer), msg.width, msg.height, { motionPx: msg.motionPx }));
      postMessage({ type: 'frame-done', ms: performance.now() - t0 });
    } else if (msg.type === 'live-stop') {
      if (scorer) sendJobs(scorer.finish());
      scorer = null;
    } else if (msg.type === 'clip') {
      port.postMessage({ type: 'reset' });
      await scoreClip(msg);
    } else if (msg.type === 'cancel') {
      cancelled = true;
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
