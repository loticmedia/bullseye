/* Bullseye Nerf-ball scorer — JavaScript port of score_bullseye.py (streaming).
 *
 * Split in two so a phone can keep up with the camera:
 *   ShotScorer  — per frame, pure JavaScript (no OpenCV): ball blobs, tracking,
 *                 camera shake, paper-motion spikes. Each candidate impact becomes
 *                 a small "job" (a few frames + ball candidates) LOOKAHEAD frames later.
 *   Measurer    — per job, uses OpenCV.js: finds the target, picks the impacting
 *                 ball and reads the ring. Can run in another worker.
 *
 *   const B = Bullseye;                       // browser global, or require('./scorer.js') in Node
 *   const s = new B.ShotScorer({ fps: 30, captureFps: 240, lut });
 *   const m = new (B.createMeasurer(cv))();
 *   for each frame: for (const job of s.push(rgba, w, h)) { const shot = m.measure(job); ... }
 *   at the end:     for (const job of s.finish()) ...
 *
 * Frames must be RGBA at working resolution (short side WORK_SHORT px).
 * `lut` is the ball-colour lookup table (ball_lut.bin, see buildBallLut).
 * Frame-count constants are defined for 240 fps capture and scaled by
 * captureFps / 240 (FrameParams).
 */
(function (root) {
  'use strict';

  const RING_SCORES = [100, 60, 50, 40, 30, 20, 10];
  const WORK_SHORT = 540;
  const SIG_SCALE = 0.5;
  const FIND_SCALE = 0.5;
  const BALL_INDEX_MIN = 25;
  const MIN_BLOB_AREA = 15;
  const MAX_BLOBS = 8;
  const MAX_SHAKE = 8; // SIG px
  const TRACK_GATE = 45.0;
  const EDGE_MARGIN = 12;
  const SPIKE_RISE = 2.5;
  const SPIKE_RATIO = 1.8;
  const SMOOTH_REL = 0.3;
  const DIFF_MARGIN = 10;

  /** Frame-count parameters, defined at 240 fps and scaled to the capture rate. */
  function FrameParams(captureFps) {
    const r = captureFps / 240;
    const p = {
      rate: r,
      spikeWindow: Math.max(3, Math.round(6 * r)),
      spikeRefractory: Math.max(1, Math.round(3 * r)),
      maxNewAge: Math.max(4, Math.round(14 * r)),
      lookahead: 3,
      refOffsets: r >= 0.99 ? [-7, -5, -3, -1] : [-3, -2, -1],
      trackKeep: Math.max(12, Math.round(40 * r)),
      // a ball lost for a few frames (camera jolt, blur) is re-linked to its old track
      relinkGap: Math.max(3, Math.round(8 * r)),
      // camera shake searched per frame (SIG px): hand jolts are bigger between 60 fps frames
      maxShake: MAX_SHAKE / Math.min(1, Math.max(r, 0.25)),
      // motion sensors (estimated picture slide, working px per frame):
      //  - a jolt (bump or tap on the phone) blocks scoring for a short hold-off;
      //  - noticeable movement around an impact makes the measurer demand that the
      //    target changed clearly more than its surroundings (a real hit shakes the paper).
      sensorVeto: 20,
      sensorHold: Math.max(3, Math.round(24 * r)),
      sensorMoving: 4,
    };
    p.buffer = p.lookahead - p.refOffsets[0] + 2;
    p.histKeep = p.buffer + 4;
    return p;
  }

  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y);
    const n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  // =========================================================================
  // Per-frame: ball blobs (exact OpenCV-equivalent, on a sparse pixel set)
  // =========================================================================
  /** Bitset over all 2^24 RGB colours: 1 where Lab (b* - a*) > BALL_INDEX_MIN,
   * computed with OpenCV's own 8-bit RGB->Lab conversion (so results match). */
  function buildBallLut(cv) {
    const lut = new Uint8Array(1 << 21);
    const img = new cv.Mat(256, 256, cv.CV_8UC3), lab = new cv.Mat();
    const d = img.data;
    for (let r = 0; r < 256; r++) {
      for (let g = 0; g < 256; g++) for (let b = 0; b < 256; b++) {
        const p = (g * 256 + b) * 3;
        d[p] = r; d[p + 1] = g; d[p + 2] = b;
      }
      cv.cvtColor(img, lab, cv.COLOR_RGB2Lab);
      const L = lab.data;
      for (let k = 0; k < 65536; k++) {
        if (L[3 * k + 2] - L[3 * k + 1] > BALL_INDEX_MIN) {
          const idx = (r << 16) | k;
          lut[idx >> 3] |= 1 << (idx & 7);
        }
      }
    }
    img.delete(); lab.delete();
    return lut;
  }

  class BlobFinder {
    constructor(W, H, lut) {
      this.W = W; this.H = H; this.lut = lut;
      const n = W * H;
      this.mask = new Uint8Array(n);
      this.open = new Uint8Array(n);
      this.label = new Int32Array(n);
      this.list = new Int32Array(n);
      this.ero = new Int32Array(n);
      this.dil = new Int32Array(n);
      this.stack = new Int32Array(n);
      this.gen = 0;
    }

    /** cv: yellow index > 25 -> morph open 3x3 -> connected components (8). */
    find(rgba) {
      const { W, H, lut, mask, open, list, ero, dil } = this;
      const n = W * H;
      let cnt = 0;
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        const idx = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
        if (lut[idx >> 3] & (1 << (idx & 7))) { mask[p] = 1; list[cnt++] = p; }
      }
      // erosion (outside the image counts as set, like OpenCV's default border)
      let ecnt = 0;
      for (let k = 0; k < cnt; k++) {
        const p = list[k], x = p % W, y = (p - x) / W;
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            if (!mask[yy * W + xx]) { ok = false; break; }
          }
        }
        if (ok) ero[ecnt++] = p;
      }
      for (let k = 0; k < cnt; k++) mask[list[k]] = 0; // reset for next frame
      // dilation (outside counts as unset)
      let dcnt = 0;
      for (let k = 0; k < ecnt; k++) {
        const p = ero[k], x = p % W, y = (p - x) / W;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (!open[q]) { open[q] = 1; dil[dcnt++] = q; }
          }
        }
      }
      // connected components, 8-connectivity
      const label = this.label, stack = this.stack;
      const gen = ++this.gen;
      const comps = [];
      for (let k = 0; k < dcnt; k++) {
        const s = dil[k];
        if (label[s] === gen) continue;
        let sp = 0, area = 0, sx = 0, sy = 0, minP = s;
        stack[sp++] = s; label[s] = gen;
        while (sp) {
          const p = stack[--sp], x = p % W, y = (p - x) / W;
          area++; sx += x; sy += y; if (p < minP) minP = p;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx;
              if (open[q] && label[q] !== gen) { label[q] = gen; stack[sp++] = q; }
            }
          }
        }
        if (area >= MIN_BLOB_AREA) comps.push({ area, x: sx / area, y: sy / area, track: -1, minP });
      }
      for (let k = 0; k < dcnt; k++) open[dil[k]] = 0;
      if (this.gen > 2e9) { this.label.fill(0); this.gen = 0; }
      comps.sort((a, b) => b.area - a.area || a.minP - b.minP); // OpenCV label order breaks ties
      return comps.slice(0, MAX_BLOBS).map(({ area, x, y }) => ({ area, x, y, track: -1 }));
    }
  }

  // =========================================================================
  // Per-frame: grey signal, camera shake, paper-motion difference
  // =========================================================================
  /** Half-size grey image exactly as cv2.resize(INTER_AREA, 0.5) + cvtColor(RGB2GRAY). */
  function halfGray(rgba, W, H, out) {
    const hw = W >> 1, hh = H >> 1;
    for (let y = 0; y < hh; y++) {
      const r0 = (2 * y) * W * 4, r1 = (2 * y + 1) * W * 4;
      for (let x = 0; x < hw; x++) {
        const a = r0 + 8 * x, b = r1 + 8 * x;
        const R = (rgba[a] + rgba[a + 4] + rgba[b] + rgba[b + 4] + 2) >> 2;
        const G = (rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5] + 2) >> 2;
        const B = (rgba[a + 2] + rgba[a + 6] + rgba[b + 2] + rgba[b + 6] + 2) >> 2;
        out[y * hw + x] = (R * 4899 + G * 9617 + B * 1868 + 8192) >> 14;
      }
    }
  }

  /** Row and column mean-brightness profiles (inside a margin), zero mean / unit variance. */
  function profiles(g, w, h, m) {
    const col = new Float64Array(w), row = new Float64Array(h);
    for (let y = m; y < h - m; y++) {
      let s = 0;
      const o = y * w;
      for (let x = m; x < w - m; x++) { const v = g[o + x]; s += v; col[x] += v; }
      row[y] = s;
    }
    const norm = (a, lo, hi) => {
      let mean = 0;
      for (let i = lo; i < hi; i++) mean += a[i];
      mean /= hi - lo;
      let v = 0;
      for (let i = lo; i < hi; i++) { a[i] -= mean; v += a[i] * a[i]; }
      const sd = Math.sqrt(v / (hi - lo)) || 1;
      for (let i = lo; i < hi; i++) a[i] /= sd;
    };
    norm(col, m, w - m); norm(row, m, h - m);
    return { col, row };
  }

  /** Sub-pixel shift s minimising sum (prev[i - s] - cur[i])^2 over the overlap; null if
   * the best match is at the search limit (implausible shake, e.g. paper flapping). */
  function shift1d(prev, cur, lo, hi, maxS) {
    const cost = new Float64Array(2 * maxS + 1);
    for (let s = -maxS; s <= maxS; s++) {
      let acc = 0, n = 0;
      for (let i = Math.max(lo, lo + s); i < Math.min(hi, hi + s); i++) {
        const d = prev[i - s] - cur[i];
        acc += d * d; n++;
      }
      cost[s + maxS] = acc / Math.max(n, 1);
    }
    let bi = 0;
    for (let k = 1; k < cost.length; k++) if (cost[k] < cost[bi]) bi = k;
    if (bi === 0 || bi === cost.length - 1) return null;
    const c0 = cost[bi - 1], c1 = cost[bi], c2 = cost[bi + 1];
    const den = c0 - 2 * c1 + c2;
    const frac = den > 1e-12 ? 0.5 * (c0 - c2) / den : 0;
    return bi - maxS + Math.max(-0.5, Math.min(0.5, frac));
  }

  /** Mean |prev shifted by (dx,dy) - cur| inside the margin (bilinear, replicate border). */
  function shiftedDiff(prev, cur, w, h, dx, dy, m) {
    let sum = 0, cnt = 0;
    if (dx === 0 && dy === 0) {
      for (let y = m; y < h - m; y++) for (let x = m, o = y * w; x < w - m; x++) { sum += Math.abs(prev[o + x] - cur[o + x]); cnt++; }
      return sum / cnt;
    }
    for (let y = m; y < h - m; y++) {
      let sy = y - dy;
      sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, h - 1), fy = sy - y0;
      for (let x = m; x < w - m; x++) {
        let sx = x - dx;
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, w - 1), fx = sx - x0;
        const a = prev[y0 * w + x0], b = prev[y0 * w + x1], c = prev[y1 * w + x0], d = prev[y1 * w + x1];
        const v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        sum += Math.abs(v - cur[y * w + x]); cnt++;
      }
    }
    return sum / cnt;
  }

  // =========================================================================
  // Per-frame: tracking and impact candidates (same logic as the Python reference)
  // =========================================================================
  class Tracker {
    /** keep: frames of history; relinkGap: frames a lost ball may be re-linked over;
     * camAt(j): camera motion [dx, dy] of frame j relative to j-1 (working px). */
    constructor(keep, relinkGap, camAt) {
      this.tracks = new Map(); this.next = 0; this.keep = keep; this.relinkGap = relinkGap; this.camAt = camAt;
    }
    predict(t, i) {
      const [lx, ly] = t.pts.get(t.last);
      let f0 = -Infinity;
      for (const f of t.pts.keys()) if (f < t.last && f > f0) f0 = f;
      let vx = 0, vy = 0;
      if (f0 > -Infinity) {
        const p0 = t.pts.get(f0);
        vx = (lx - p0[0]) / (t.last - f0); vy = (ly - p0[1]) / (t.last - f0);
      }
      let cx = 0, cy = 0; // follow the camera
      for (let j = t.last + 1; j <= i; j++) { const c = this.camAt(j); cx += c[0]; cy += c[1]; }
      return { x: lx + vx * (i - t.last) + cx, y: ly + vy * (i - t.last) + cy, v: Math.hypot(vx, vy) };
    }
    update(i, blobs) {
      const usedT = new Set(), usedB = new Set();
      const assign = (maxGap, gateOf) => {
        const cand = [];
        for (const t of this.tracks.values()) {
          const gap = i - t.last;
          if (gap < 1 || gap > maxGap || usedT.has(t.id)) continue;
          const p = this.predict(t, i), gate = gateOf(p.v, gap);
          blobs.forEach((b, j) => {
            if (usedB.has(j)) return;
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d < gate) cand.push([d, t.id, j]);
          });
        }
        cand.sort((x, y) => x[0] - y[0]);
        for (const [, tid, j] of cand) {
          if (usedT.has(tid) || usedB.has(j)) continue;
          usedT.add(tid); usedB.add(j);
          const t = this.tracks.get(tid), b = blobs[j];
          t.pts.set(i, [b.x, b.y, b.area]); t.last = i; b.track = tid;
        }
      };
      assign(2, (v) => Math.max(TRACK_GATE, 1.6 * v));
      // second chance for balls lost over a few frames, with a wider gate
      assign(this.relinkGap, (v, gap) => Math.max(1.6 * TRACK_GATE, 1.6 * v * Math.min(gap, 3)));
      blobs.forEach((b, j) => {
        if (usedB.has(j)) return;
        const t = { id: this.next++, start: i, last: i, pts: new Map([[i, [b.x, b.y, b.area]]]) };
        this.tracks.set(t.id, t); b.track = t.id;
      });
      for (const [tid, t] of this.tracks) {
        if (i - t.last > this.keep) { this.tracks.delete(tid); continue; }
        if (t.pts.size > this.keep) for (const f of [...t.pts.keys()]) if (f < i - this.keep) t.pts.delete(f);
      }
    }
  }

  function velIn(tr, k) {
    for (let j = k - 1; j > k - 4; j--) {
      if (tr.pts.has(j) && tr.pts.has(k)) {
        const a = tr.pts.get(j), b = tr.pts.get(k);
        return [(b[0] - a[0]) / (k - j), (b[1] - a[1]) / (k - j)];
      }
    }
    return null;
  }
  function velOut(tr, k) {
    for (let m = k + 1; m < k + 4; m++) {
      if (tr.pts.has(m) && tr.pts.has(k)) {
        const a = tr.pts.get(k), b = tr.pts.get(m);
        return [(b[0] - a[0]) / (m - k), (b[1] - a[1]) / (m - k)];
      }
    }
    return null;
  }
  function motionBreak(tr, k) {
    const vi = velIn(tr, k), vo = velOut(tr, k);
    if (!vi || !vo) return null;
    const d = Math.hypot(vo[0] - vi[0], vo[1] - vi[1]);
    return d / Math.max(Math.hypot(vi[0], vi[1]), Math.hypot(vo[0], vo[1]), 6.0);
  }

  function impactCandidates(t, blobs, tracks, W, H, P) {
    const out = [], seen = new Set();
    for (const dt of [0, 1, -1]) {
      const f = t + dt;
      for (const b of blobs.get(f) || []) {
        const tr = tracks.get(b.track);
        if (!tr) continue;
        const age = f - tr.start;
        if (seen.has(tr.id) || age > P.maxNewAge) continue;
        seen.add(tr.id);
        // only up to t: after the bounce every ball moves smoothly
        const brks = [motionBreak(tr, t - 1), motionBreak(tr, t)].filter((m) => m !== null);
        const brk = brks.length ? Math.max(...brks) : null;
        if (brk !== null && brk < SMOOTH_REL) continue;
        let x = b.x, y = b.y;
        if (dt === 1 && tr.pts.has(f + 1)) {
          const nx = tr.pts.get(f + 1);
          x = 2 * x - nx[0]; y = 2 * y - nx[1];
          if (x < 0 || y < 0 || x >= W || y >= H) { x = b.x; y = b.y; } // implausible step back
        }
        const edge = Math.min(b.x, b.y, W - b.x, H - b.y) < EDGE_MARGIN;
        out.push({ x, y, f: dt === 1 ? t : f, dt, track: tr.id, age, brk, area: b.area, edge });
      }
    }
    return out;
  }

  class RunningQuantile {
    constructor(hi = 60, bins = 1200) { this.h = new Float64Array(bins + 1); this.k = bins / hi; this.n = 0; }
    add(v) { this.h[Math.min(Math.floor(v * this.k), this.h.length - 1)] += 1; this.n++; }
    quantile(q) {
      if (!this.n) return 0;
      const target = q * this.n;
      let c = 0;
      for (let i = 0; i < this.h.length; i++) { c += this.h[i]; if (c >= target) return (i + 0.5) / this.k; }
      return (this.h.length - 0.5) / this.k;
    }
  }

  // =========================================================================
  // ShotScorer: per-frame stage
  // =========================================================================
  class ShotScorer {
    /**
     * fps: playback rate of the source (time stamps); captureFps: real capture rate
     * (240 for iPhone slo-mo, ~60 for a live web camera); clip: [startSec, endSec] or null;
     * lut: ball colour bitset (Uint8Array, 2 MiB).
     */
    constructor({ fps = 30, captureFps = 240, clip = null, lut, off = {} }) {
      if (!lut) throw new Error('ShotScorer needs the ball colour LUT');
      this.fps = fps;
      this.P = FrameParams(captureFps);
      // test switches
      if (off.relink) this.P.relinkGap = 2;
      this.clip = clip;
      this.lut = lut;
      this.i = -1;
      this.W = 0; this.H = 0;
      this.frames = new Map(); this.blobs = new Map(); this.shift = new Map(); this.diff = new Map();
      this.quiet = new RunningQuantile();
      this.tracker = new Tracker(this.P.trackKeep, this.P.relinkGap, (j) => this.shift.get(j) || [0, 0]);
      this.motion = new Map();
      this.lastMoving = -1e9;
      this.vetoed = 0;
      this.pending = [];
      this.lastSpike = -1e9;
      this.finder = null;
      this.prevGray = null; this.prevProf = null;
      this.lastDiff = 0;
    }

    /** Push one RGBA frame at working resolution. Returns measurement jobs that became ready. */
    /** meta.motionPx: camera motion from the phone's motion sensors, as the estimated
     * image slide in working px for this frame (omit when there are no sensors). */
    push(rgba, width, height, meta) {
      const i = ++this.i, P = this.P;
      if (meta && Number.isFinite(meta.motionPx)) {
        this.motion.set(i, meta.motionPx);
        if (meta.motionPx > P.sensorVeto) this.lastMoving = i;
      }
      if (Math.min(width, height) !== WORK_SHORT) throw new Error(`frames must have short side ${WORK_SHORT}px`);
      if (!this.finder || this.W !== width || this.H !== height) {
        this.W = width; this.H = height;
        this.finder = new BlobFinder(width, height, this.lut);
        this.prevGray = null;
      }
      this.frames.set(i, rgba);

      // camera shake + residual (shake-compensated) difference on a half-size grey image
      const hw = width >> 1, hh = height >> 1;
      const gray = new Uint8Array(hw * hh);
      halfGray(rgba, width, height, gray);
      const prof = profiles(gray, hw, hh, DIFF_MARGIN);
      if (!this.prevGray) {
        this.shift.set(i, [0, 0]); this.diff.set(i, 0);
      } else {
        const ms = Math.round(P.maxShake);
        let dx = shift1d(this.prevProf.col, prof.col, DIFF_MARGIN, hw - DIFF_MARGIN, ms);
        let dy = shift1d(this.prevProf.row, prof.row, DIFF_MARGIN, hh - DIFF_MARGIN, ms);
        if (dx === null || dy === null || Math.hypot(dx, dy) > P.maxShake) { dx = 0; dy = 0; }
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) { dx = 0; dy = 0; }
        const d = shiftedDiff(this.prevGray, gray, hw, hh, dx, dy, DIFF_MARGIN);
        this.diff.set(i, d);
        this.shift.set(i, [dx / SIG_SCALE, dy / SIG_SCALE]);
        this.quiet.add(d);
      }
      this.prevGray = gray; this.prevProf = prof;
      this.lastDiff = this.diff.get(i);

      const bl = this.finder.find(rgba);
      this.tracker.update(i, bl);
      this.blobs.set(i, bl);

      if (this.isSpike(i)) {
        this.lastSpike = i;
        const tsec = i / this.fps;
        if (i - this.lastMoving <= P.sensorHold) this.vetoed++; // the camera moved, not the paper
        else if (!this.clip || (this.clip[0] <= tsec && tsec <= this.clip[1])) this.pending.push(i);
      }
      const out = [];
      while (this.pending.length && this.pending[0] + P.lookahead <= i) {
        const job = this.makeJob(this.pending.shift());
        if (job) out.push(job);
      }
      for (const mp of [this.frames, this.diff]) for (const k of mp.keys()) if (k <= i - P.buffer) mp.delete(k);
      for (const mp of [this.blobs, this.shift, this.motion]) for (const k of mp.keys()) if (k <= i - P.histKeep) mp.delete(k);
      return out;
    }

    finish() {
      const out = [];
      while (this.pending.length) { const job = this.makeJob(this.pending.shift()); if (job) out.push(job); }
      return out;
    }

    isSpike(i) {
      const P = this.P;
      if (i < P.spikeWindow || i - this.lastSpike <= P.spikeRefractory) return false;
      const d = this.diff, w = [];
      for (let k = i - P.spikeWindow; k < i; k++) w.push(d.get(k));
      const base = median(w), di = d.get(i);
      return di - base > SPIKE_RISE && di > SPIKE_RATIO * base && di >= d.get(i - 1);
    }

    /** Everything the Measurer needs for the impact at frame t (self-contained, transferable). */
    makeJob(t) {
      const P = this.P;
      if (this.lastMoving >= t - 1) { this.vetoed++; return null; } // phone jolted around the impact
      const cands = impactCandidates(t, this.blobs, this.tracker.tracks, this.W, this.H, P);
      if (!cands.length) return null; // paper motion without a newly arrived ball
      const base = t - 1;
      const quiet = this.quiet.quantile(0.2);
      const before = [];
      for (let k = t + P.refOffsets[0]; k < t; k++) if (this.diff.has(k) && k > 0) before.push(this.diff.get(k));
      const settled = before.length > 0 && Math.max(...before) < 1.6 * quiet + 0.6;
      const refs = [];
      for (const o of settled ? P.refOffsets : [-1]) {
        const k = t + o, f = this.frames.get(k);
        if (!f) continue;
        let dx = 0, dy = 0;
        for (let j = k + 1; j <= base; j++) { const s = this.shift.get(j) || [0, 0]; dx += s[0]; dy += s[1]; }
        refs.push({ rgba: f.slice(), dx, dy });
      }
      if (!refs.length) return null;
      const cur = this.frames.get(t);
      let sensor = null; // strongest phone movement around the impact, if sensors report
      for (let k = t - 3; k <= t + 1; k++) if (this.motion.has(k)) sensor = Math.max(sensor || 0, this.motion.get(k));
      return { t, time: t / this.fps, W: this.W, H: this.H, settled, cands, refs, cur: cur ? cur.slice() : null,
        moving: sensor !== null && sensor > P.sensorMoving };
    }
  }

  // =========================================================================
  // Measurer: per-impact stage (OpenCV.js)
  // =========================================================================
  function createMeasurer(cv) {
    function del(...mats) { for (const m of mats) if (m && !m.isDeleted()) m.delete(); }
    function argmaxFinite(data) {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < data.length; i++) { const v = data[i]; if (v > best && Number.isFinite(v)) { best = v; bi = i; } }
      return [bi, best === -Infinity ? -1 : best];
    }
    function rgbFromRgba(rgba, W, H) {
      const src = new cv.Mat(H, W, cv.CV_8UC4);
      src.data.set(rgba);
      const rgb = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      src.delete();
      return rgb;
    }

    /** Darkness map: {data: Float32Array (NaN = unknown), rows, cols}. */
    function darknessMap(rgb, win) {
      const rows = rgb.rows, cols = rgb.cols, n = rows * cols;
      const hsv = new cv.Mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const hd = hsv.data;
      const v = new cv.Mat(rows, cols, cv.CV_32F);
      const vd = v.data32F;
      for (let i = 0, j = 0; i < n; i++, j += 3) vd[i] = hd[j + 2];
      win = Math.max(3, Math.trunc(win) | 1);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(win, win));
      const ks = new cv.Size(win, win);
      const white = new cv.Mat(), black = new cv.Mat(), mean = new cv.Mat();
      cv.dilate(v, white, k); cv.blur(white, white, ks);
      cv.erode(v, black, k); cv.blur(black, black, ks);
      cv.blur(v, mean, ks);
      const wd = white.data32F, bd = black.data32F, md = mean.data32F;
      const d = new Float32Array(n);
      const unk = new cv.Mat(rows, cols, cv.CV_8U);
      const ud = unk.data;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const h = hd[j], s = hd[j + 1], vv = hd[j + 2];
        const contrast = Math.max(wd[i] - bd[i], 30);
        let x = 0.5 + (md[i] - vv) / contrast * 1.5;
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        let g = (130 - s) / 30; g = g < 0 ? 0 : g > 1 ? 1 : g;
        d[i] = x * g;
        ud[i] = (h >= 90 && h <= 140 && s > 40) || (h >= 22 && h <= 48 && s > 80 && vv > 90) ? 1 : 0;
      }
      const k3 = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(unk, unk, k3);
      for (let i = 0; i < n; i++) if (ud[i]) d[i] = NaN;
      del(hsv, v, k, white, black, mean, unk, k3);
      return { data: d, rows, cols };
    }

    const _tpl = new Map();
    function template(R) {
      if (!_tpl.has(R)) {
        const s = 2 * R + 1;
        const t = new cv.Mat(s, s, cv.CV_32F), m = new cv.Mat(s, s, cv.CV_32F);
        const td = t.data32F, mdd = m.data32F;
        for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
          const r = Math.hypot(x, y) / R * 7, i = (y + R) * s + (x + R);
          td[i] = r >= 7 ? 0 : (Math.floor(r) % 2 === 0 ? 1 : 0);
          mdd[i] = r <= 7.5 ? 1 : 0;
        }
        _tpl.set(R, [t, m]);
      }
      return _tpl.get(R);
    }
    function matFromFloat(data, rows, cols, nanValue) {
      const m = new cv.Mat(rows, cols, cv.CV_32F);
      const d = m.data32F;
      for (let i = 0; i < d.length; i++) { const v = data[i]; d[i] = v === v ? v : nanValue; }
      return m;
    }

    function findTarget(ref, prior) {
      const sc = FIND_SCALE;
      const small = new cv.Mat();
      cv.resize(ref, small, new cv.Size(0, 0), sc, sc, cv.INTER_AREA);
      const H = small.rows, W = small.cols, short = Math.min(H, W);
      const dmap = darknessMap(small, 0.093 * short);
      small.delete();
      const dm = matFromFloat(dmap.data, H, W, 0.3);
      const rLo = Math.round(0.133 * short), rHi = Math.round(0.61 * short);
      const pad = rHi + 5;
      const padded = new cv.Mat();
      cv.copyMakeBorder(dm, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(0));
      dm.delete();
      const res = new cv.Mat();
      function search(r0, r1, cx0 = 0, cy0 = 0, cx1 = W - 1, cy1 = H - 1) {
        let best = null, R = r0;
        while (R <= r1) {
          const [tpl, mask] = template(R);
          const region = padded.roi(new cv.Rect(cx0 + pad - R, cy0 + pad - R, (cx1 - cx0) + 2 * R + 1, (cy1 - cy0) + 2 * R + 1));
          cv.matchTemplate(region, tpl, res, cv.TM_CCOEFF_NORMED, mask);
          region.delete();
          const [bi, mx] = argmaxFinite(res.data32F);
          if (!best || mx > best[3]) best = [(cx0 + (bi % res.cols)) / sc, (cy0 + Math.floor(bi / res.cols)) / sc, R / sc, mx];
          R = Math.round(R * 1.04) + 1;
        }
        return best;
      }
      let out = null;
      if (prior) {
        const pr = prior[2] * sc, m = Math.trunc(0.35 * pr) + 2;
        const pcx = Math.round(prior[0] * sc), pcy = Math.round(prior[1] * sc);
        const local = search(Math.max(rLo, Math.round(0.88 * pr)), Math.min(rHi, Math.round(1.12 * pr) + 1),
          Math.max(0, pcx - m), Math.max(0, pcy - m), Math.min(W - 1, pcx + m), Math.min(H - 1, pcy + m));
        if (local && local[3] >= Math.max(0.45, 0.8 * prior[3])) out = local;
      }
      if (!out) out = search(rLo, rHi);
      del(padded, res);
      return out;
    }

    function roiDarkness(ref, cx, cy, R) {
      const H = ref.rows, W = ref.cols, m = 1.5 * R;
      const x0 = Math.min(Math.max(0, Math.trunc(cx - m)), W - 8), y0 = Math.min(Math.max(0, Math.trunc(cy - m)), H - 8);
      const x1 = Math.max(Math.min(W, Math.trunc(cx + m)), x0 + 8), y1 = Math.max(Math.min(H, Math.trunc(cy + m)), y0 + 8);
      const roi = ref.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      const crop = roi.clone(); roi.delete();
      const dk = darknessMap(crop, 2 * R / 7);
      crop.delete();
      dk.ox = x0; dk.oy = y0;
      return dk;
    }

    function refineCenter(dk, cx, cy, R) {
      const rDisc = R / 7;
      const m = new cv.Mat(dk.rows, dk.cols, cv.CV_8U);
      const md = m.data, d = dk.data;
      for (let i = 0; i < d.length; i++) { const v = d[i]; md[i] = (v !== v || v > 0.5) ? 1 : 0; }
      const k = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.morphologyEx(m, m, cv.MORPH_OPEN, k);
      const lbl = new cv.Mat(), st = new cv.Mat(), cen = new cv.Mat();
      const n = cv.connectedComponentsWithStats(m, lbl, st, cen, 8, cv.CV_32S);
      const expArea = Math.PI * rDisc * rDisc;
      let best = null;
      for (let i = 1; i < n; i++) {
        const a = st.intAt(i, cv.CC_STAT_AREA);
        if (!(0.4 * expArea < a && a < 2.0 * expArea)) continue;
        const w = st.intAt(i, cv.CC_STAT_WIDTH), h = st.intAt(i, cv.CC_STAT_HEIGHT);
        if (Math.max(w, h) > 3 * rDisc || Math.min(w, h) < rDisc) continue;
        const gx = cen.doubleAt(i, 0) + dk.ox, gy = cen.doubleAt(i, 1) + dk.oy;
        const dist = Math.hypot(gx - cx, gy - cy);
        if (dist <= 1.5 * rDisc && (!best || dist < best[0])) best = [dist, gx, gy];
      }
      del(m, k, lbl, st, cen);
      return best ? [best[1], best[2]] : [cx, cy];
    }

    function rayProfile(dk, cx, cy, th, rmax, half, band, nRays = 11) {
      const N = Math.ceil(rmax / 0.5), cols = dk.cols, rows = dk.rows, d = dk.data;
      const samples = [];
      for (let k = 0; k < nRays; k++) {
        const a = th - half + (2 * half * k) / (nRays - 1), c = Math.cos(a), s = Math.sin(a);
        const row = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const x = Math.round(cx - dk.ox + c * i * 0.5), y = Math.round(cy - dk.oy + s * i * 0.5);
          row[i] = (x < 0 || y < 0 || x >= cols || y >= rows) ? NaN : d[y * cols + x];
        }
        samples.push(row);
      }
      const prof = new Float32Array(N), buf = [];
      for (let i = 0; i < N; i++) {
        buf.length = 0;
        for (let k = 0; k < nRays; k++) { const v = samples[k][i]; if (v === v) buf.push(v); }
        prof[i] = buf.length ? median(buf) : NaN;
      }
      const n = Math.max(3, Math.round(0.16 * band) | 1), hh = n >> 1;
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let num = 0, den = 0;
        for (let j = Math.max(0, i - hh); j <= Math.min(N - 1, i + hh); j++) { const v = prof[j]; if (v === v) { num += v; den++; } }
        out[i] = den >= 0.4 * n ? num / den : NaN;
      }
      return out;
    }

    function fitRings(prof, R, rp) {
      const band = R / 7, N = prof.length;
      const w0 = new Float32Array(N), p = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const r = i * 0.5, v = prof[i], valid = v === v;
        p[i] = (valid ? v : 0.5) - 0.5;
        w0[i] = valid && r > 0.5 * band ? 1 + 2 * Math.exp(-(((r - rp) / (1.5 * band)) ** 2)) : 0;
      }
      let best = [-Infinity, 0, R];
      for (let a = 0; a < 29; a++) {
        const delta = -0.7 * band + (1.4 * band * a) / 28;
        for (let b = 0; b < 45; b++) {
          const Rd = R * (0.78 + (0.44 * b) / 44), k = 7 / Rd;
          let num = 0, den = 0;
          for (let i = 0; i < N; i++) {
            const w = w0[i];
            if (!w) continue;
            const u = (i * 0.5 + delta) * k;
            if (u < 0 || u >= 7.6) continue;
            num += w * p[i] * (u >= 7 ? -0.5 : (Math.floor(u) % 2 === 0 ? 0.5 : -0.5)); den += w;
          }
          const q = (num / Math.max(den, 1e-6)) * 4;
          if (q > best[0]) best = [q, delta, Rd];
        }
      }
      return { delta: best[1], Rd: best[2], q: best[0] };
    }

    function observedCrossing(prof, near, risingDark, win) {
      const n = prof.length;
      const a = Math.max(1, Math.trunc((near - win) * 2)), b = Math.min(n - 1, Math.trunc((near + win) * 2));
      let best = null;
      for (let i = a; i <= b; i++) {
        const p0 = prof[i - 1], p1 = prof[i];
        if (p0 !== p0 || p1 !== p1) continue;
        if ((risingDark && p0 < 0.5 && 0.5 <= p1) || (!risingDark && p0 >= 0.5 && 0.5 > p1)) {
          if (best === null || Math.abs(i * 0.5 - near) < Math.abs(best - near)) best = i * 0.5;
        }
      }
      return best;
    }

    function zoneAlongRay(dk, cx, cy, px, py, R) {
      const rp = Math.hypot(px - cx, py - cy), th = Math.atan2(py - cy, px - cx), band = R / 7;
      const rmax = Math.max(rp + 2 * band, R * 1.3);
      const half = Math.min(10 * Math.PI / 180, Math.max(2.5 * Math.PI / 180, 0.4 * band / Math.max(rp, 1)));
      const prof = rayProfile(dk, cx, cy, th, rmax, half, band);
      const { delta, Rd, q } = fitRings(prof, R, rp);
      const bw = Rd / 7;
      let z = Math.floor(Math.max(7 * (rp + delta) / Rd, 0));
      const modelZ = z;
      if (z <= 7) {
        if (z >= 1) {
          const e = observedCrossing(prof, z * bw - delta, z % 2 === 0, 0.45 * bw);
          if (e !== null && rp < e) z -= 1;
        }
        if (z === modelZ && z <= 6) {
          const e = observedCrossing(prof, (z + 1) * bw - delta, z % 2 === 1, 0.45 * bw);
          if (e !== null && rp >= e) z += 1;
        }
      }
      return { zone: Math.min(Math.max(z, 0), 7), q };
    }

    function cropPadded(img, x, y, half, pad) {
      x = Math.min(Math.max(x, 0), img.cols - 1); y = Math.min(Math.max(y, 0), img.rows - 1);
      const big = new cv.Mat();
      cv.copyMakeBorder(img, big, pad, pad, pad, pad, cv.BORDER_REPLICATE, new cv.Scalar());
      const roi = big.roi(new cv.Rect(x + pad - half, y + pad - half, 2 * half + 1, 2 * half + 1));
      const out = roi.clone();
      del(roi, big);
      return out;
    }

    function paperDisplacement(ref, cur, bx, by, R, rb) {
      const band = R / 7;
      const h = Math.trunc(Math.max(2.5 * band, 3.2 * rb)), srch = Math.trunc(1.3 * band), pad = h + srch + 2;
      const x = Math.round(bx), y = Math.round(by);
      const c1 = cropPadded(ref, x, y, h, pad), c2 = cropPadded(cur, x, y, h + srch, pad);
      const tplD = darknessMap(c1, 2 * band), areaD = darknessMap(c2, 2 * band);
      del(c1, c2);
      const tw = tplD.cols, th = tplD.rows;
      const mask = new cv.Mat(th, tw, cv.CV_32F), mk = mask.data32F;
      let msum = 0, s1 = 0, s2 = 0;
      for (let yy = 0; yy < th; yy++) for (let xx = 0; xx < tw; xx++) {
        const i = yy * tw + xx, rr = Math.hypot(xx - (tw - 1) / 2, yy - (th - 1) / 2), v = tplD.data[i];
        const on = rr >= 1.5 * rb && rr <= h && v === v;
        mk[i] = on ? 1 : 0;
        if (on) { msum++; s1 += v; s2 += v * v; }
      }
      const std = msum ? Math.sqrt(Math.max(s2 / msum - (s1 / msum) ** 2, 0)) : 0;
      if (msum < 50 || std < 0.15) { mask.delete(); return [null, 0]; }
      const tpl = matFromFloat(tplD.data, th, tw, 0.5), area = matFromFloat(areaD.data, areaD.rows, areaD.cols, 0.5);
      const res = new cv.Mat();
      cv.matchTemplate(area, tpl, res, cv.TM_CCOEFF_NORMED, mask);
      const [bi, mx] = argmaxFinite(res.data32F);
      const out = [[(bi % res.cols) - (res.cols - 1) / 2, Math.floor(bi / res.cols) - (res.rows - 1) / 2], mx];
      del(tpl, area, res, mask);
      return out;
    }

    /** Did the target change more than its surroundings between the frame before impact
     * and the impact frame? Camera motion (estimated from the background around the target)
     * is compensated first. A real hit shakes the paper; a camera jiggle changes everything.
     * Returns {din, dout, nout, sx, sy} (mean grey change inside the target / around it). */
    function motionCheck(prevRgb, curRgb, cx, cy, R) {
      const sc = 0.25, S = 8;
      const g = [prevRgb, curRgb].map((m) => {
        const sm = new cv.Mat(), gr = new cv.Mat(), f = new cv.Mat();
        cv.resize(m, sm, new cv.Size(0, 0), sc, sc, cv.INTER_AREA);
        cv.cvtColor(sm, gr, cv.COLOR_RGB2GRAY);
        gr.convertTo(f, cv.CV_32F);
        sm.delete(); gr.delete();
        return f;
      });
      const [g1, g2] = g, W = g1.cols, H = g1.rows, cs = cx * sc, ys = cy * sc, Rs = R * sc;
      // camera translation from the background only (target masked out)
      const tpl = g1.roi(new cv.Rect(S, S, W - 2 * S, H - 2 * S));
      const mask = new cv.Mat(H - 2 * S, W - 2 * S, cv.CV_32F);
      const mk = mask.data32F;
      let nbg = 0;
      for (let y = 0; y < H - 2 * S; y++) for (let x = 0; x < W - 2 * S; x++) {
        const on = Math.hypot(x + S - cs, y + S - ys) > 1.25 * Rs;
        mk[y * (W - 2 * S) + x] = on ? 1 : 0; if (on) nbg++;
      }
      let sx = 0, sy = 0;
      if (nbg > 400) {
        const res = new cv.Mat();
        cv.matchTemplate(g2, tpl, res, cv.TM_SQDIFF, mask);
        const d = res.data32F;
        let bi = 0;
        for (let k = 1; k < d.length; k++) if (d[k] < d[bi]) bi = k;
        sx = (bi % res.cols) - S; sy = Math.floor(bi / res.cols) - S;
        res.delete();
      }
      tpl.delete(); mask.delete();
      const a = g1.data32F, b = g2.data32F;
      let si = 0, ni = 0, so = 0, no = 0;
      for (let y = 0; y < H; y++) {
        const py = y - sy;
        if (py < 0 || py >= H) continue;
        for (let x = 0; x < W; x++) {
          const px = x - sx;
          if (px < 0 || px >= W) continue;
          const r = Math.hypot(x - cs, y - ys) / Rs, dv = Math.abs(b[y * W + x] - a[py * W + px]);
          if (r < 1) { si += dv; ni++; } else if (r > 1.3 && r < 2.6) { so += dv; no++; }
        }
      }
      g1.delete(); g2.delete();
      return { din: ni ? si / ni : 0, dout: no ? so / no : 0, nout: no, sx: sx / sc, sy: sy / sc };
    }

    /** Clean view of the target just before impact: median of the job's aligned frames. */
    function referenceFrom(job) {
      const mats = job.refs.map(({ rgba, dx, dy }) => {
        let m = rgbFromRgba(rgba, job.W, job.H);
        if (Math.abs(dx) + Math.abs(dy) > 0.25) {
          const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, dx, 0, 1, dy]), w = new cv.Mat();
          cv.warpAffine(m, w, M, new cv.Size(job.W, job.H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
          M.delete(); m.delete(); m = w;
        }
        return m;
      });
      if (mats.length === 1) return mats[0];
      const ref = new cv.Mat(job.H, job.W, cv.CV_8UC3);
      const out = ref.data, srcs = mats.map((m) => m.data), n = srcs.length, v = new Array(n);
      for (let p = 0; p < out.length; p++) {
        for (let q = 0; q < n; q++) v[q] = srcs[q][p];
        v.sort((a, b) => a - b);
        out[p] = n % 2 ? v[(n - 1) / 2] : Math.trunc((v[n / 2 - 1] + v[n / 2]) / 2);
      }
      del(...mats);
      return ref;
    }

    class Measurer {
      constructor() { this.targetPrior = null; this.nShots = 0; }

      /** Score one impact job; returns a shot object or null (no target / no ball). */
      measure(job) {
        const ref = referenceFrom(job);
        const cur = job.cur ? rgbFromRgba(job.cur, job.W, job.H) : null;
        try {
          const tgt = findTarget(ref, this.targetPrior);
          if (!tgt || tgt[3] < 0.25) return null; // target not in view
          this.targetPrior = tgt;
          let [cx, cy, R, conf] = tgt;
          const dk = roiDarkness(ref, cx, cy, R);
          [cx, cy] = refineCenter(dk, cx, cy, R);
          // choose the impacting ball: on the target first; then seen at impact >
          // just after (slow rebound) > just before (still flying in); then the most
          // abrupt change of motion; then the biggest blob
          const ranked = [];
          for (const c of job.cands) {
            const inside = Math.hypot(c.x - cx, c.y - cy) < 1.1 * R;
            if (c.edge && !inside) continue;
            const when = c.dt === 0 ? 2 : c.dt === 1 ? 1 : 0;
            ranked.push([[inside ? 1 : 0, when, c.brk !== null ? c.brk : 0.6, c.area], c]);
          }
          if (!ranked.length) return null;
          ranked.sort((a, b) => { for (let k = 0; k < 4; k++) if (a[0][k] !== b[0][k]) return b[0][k] - a[0][k]; return 0; });
          const c = ranked[0][1];
          let bx = c.x, by = c.y;
          // the sheet may lurch on impact: follow the paper back to where the hit spot was
          if (cur && c.dt >= 0) {
            const [D, corr] = paperDisplacement(ref, cur, c.x, c.y, R, Math.sqrt(c.area / Math.PI));
            if (D && corr >= 0.45 && Math.hypot(D[0], D[1]) <= 1.3 * R / 7) { bx = c.x - D[0]; by = c.y - D[1]; }
          }
          let motion = null;
          if (cur) {
            const prev = rgbFromRgba(job.refs[job.refs.length - 1].rgba, job.W, job.H);
            try { motion = motionCheck(prev, cur, cx, cy, R); } finally { prev.delete(); }
          }
          // the phone moved: only a target that changed clearly more than its surroundings
          // (after following the camera) is a hit; otherwise it was the camera
          if (job.moving && motion && motion.nout > 400 && motion.din < 1.4 * (motion.dout + 0.5)) return null;
          const rp = Math.hypot(bx - cx, by - cy);
          const zr = zoneAlongRay(dk, cx, cy, bx, by, R);
          let zone = zr.zone, note;
          if (zr.q < 0.2) { zone = Math.min(7, Math.trunc(rp / (R / 7))); note = 'weak ring fit; used template geometry'; }
          const shot = {
            n: ++this.nShots, t: job.t, time: job.time, score: zone < 7 ? RING_SCORES[zone] : 0, zone,
            fit_q: zr.q, settled: job.settled, center: [cx, cy], R, target_conf: conf,
            ball: [c.x, c.y], impact: [bx, by], work: [job.W, job.H],
            cand: { dt: c.dt, age: c.age, brk: c.brk, area: c.area }, motion,
          };
          if (note) shot.note = note;
          return shot;
        } finally {
          ref.delete();
          if (cur) cur.delete();
        }
      }

      /** RGB cv.Mat of a job's impact frame (caller deletes), e.g. for thumbnails. */
      impactFrame(job) { return job.cur ? rgbFromRgba(job.cur, job.W, job.H) : null; }
    }
    return Measurer;
  }

  const api = { ShotScorer, FrameParams, createMeasurer, buildBallLut, RING_SCORES, WORK_SHORT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bullseye = api;
})(typeof self !== 'undefined' ? self : this);
