/* analyse-sample.mjs - measure a real engine recording and report the numbers
 * soundconfig.json wants.
 *
 *     node tools/analyse-sample.mjs onboard.m4a --from 1:20 --to 3:05
 *     node tools/analyse-sample.mjs --selftest
 *
 * The three shipped profiles were invented: every generator parameter was a
 * guess at what an engine "ought" to look like spectrally. This measures one
 * instead. Give it any file ffmpeg can decode and it reports the firing
 * frequency track, the harmonic structure per rev band, the fixed resonances,
 * the induction band, gearbox whine orders and the shift points.
 *
 * Two ideas do most of the work:
 *
 *  - Everything is measured in HARMONIC INDEX space, not frequency. Each
 *    analysis frame contributes its harmonic amplitudes A[1..H] relative to
 *    its own tracked f0, so frames at 3000 and 8000 rpm can be averaged
 *    together. No long steady-state section is needed - which matters,
 *    because a lap of the Nurburgring does not contain one.
 *
 *  - The rev sweep IS the deconvolution. A fixed cabin/airbox/exhaust
 *    resonance sits at one frequency while the harmonics sweep through it, so
 *    plotting (measured harmonic / harmonic predicted by the spectral tilt)
 *    against ABSOLUTE frequency makes the resonances stand out on their own.
 *    That is where the "formants" come from, and they are the part of the
 *    sound that identifies a specific car rather than a generic engine.
 *
 * Nothing here touches the network. You supply the file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, writeWav, layerSpec } from './synth-node.mjs';
import { runOnboardSelftest } from './selftest-onboard.mjs';

/* ============================ small numerics ============================ */

/** In-place iterative radix-2 FFT. Same routine as js/synth.js:27, which is
 *  private to that file's IIFE. n must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const median = (a) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Least-squares slope/intercept of y on x. */
function regress(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

/* ============================== decoding =============================== */

function parseTime(t) {
  if (t == null) return null;
  return String(t).split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0);
}

/** ffmpeg -> mono float32 at `sr`. Any container it can open works. */
export function decode(file, sr, from, to) {
  const args = ['-v', 'error', '-i', file];
  if (from != null) args.push('-ss', String(from));
  if (to != null) args.push('-to', String(to));
  void 0;
  args.push('-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-');
  const res = spawnSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  if (res.error) {
    throw new Error('could not run ffmpeg (' + res.error.message + '). Install it, or put it on PATH.');
  }
  if (res.status !== 0) throw new Error('ffmpeg failed:\n' + res.stderr.toString().trim());
  const buf = res.stdout;
  const n = buf.length >> 2;
  if (!n) throw new Error('ffmpeg produced no audio from ' + file);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}


/** Decode several sections and join them.
 *
 *  A lap recording is mostly not the car you want: pit lane, other cars,
 *  commentary, the camera being moved. Pointing the analyser at the whole
 *  thing lets all of that into the averages and into the RPM track. Joining
 *  only the named sections keeps the measurement on the material you chose.
 *
 *  A short silence is inserted between sections. It costs a couple of frames
 *  and stops the join looking like a gearshift - the RPM track reads zero
 *  across it, and both the shift finder and the frame filter drop zeros.
 */
export function decodeSegments(file, sr, segments) {
  if (!segments.length) return decode(file, sr, null, null);
  const gap = new Float32Array(Math.round(sr * 0.35));
  const parts = [];
  let total = 0;
  for (const [from, to] of segments) {
    const part = decode(file, sr, from, to);
    parts.push(part, gap);
    total += part.length + gap.length;
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/* ============================ spectral front end ======================== */

const WIN = 8192;          // 170 ms at 48 kHz: 5.9 Hz bins, tolerable smear on a pull
const HOP = 2048;          // 43 ms

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 25th percentile per 64-bin band, held flat across the band. Used by the
 *  f0 tracker for scoring; the harmonic measurement needs something tighter
 *  and gets it from localFloor() below. */
function noiseFloor(mag) {
  const B = 64, out = new Float64Array(mag.length);
  for (let b = 0; b < mag.length; b += B) {
    const end = Math.min(b + B, mag.length), m = end - b;
    const s = Float64Array.from(mag.slice(b, end)).sort();
    const v = s[Math.floor(m * 0.25)] || 1e-12;
    for (let i = b; i < end; i++) out[i] = v;
  }
  return out;
}

/** Magnitude spectra (linear) plus a cheap local noise floor per frame. */
function stft(x, sr) {
  const w = hann(WIN), half = WIN / 2;
  const frames = [];
  const re = new Float64Array(WIN), im = new Float64Array(WIN);
  for (let start = 0; start + WIN <= x.length; start += HOP) {
    for (let i = 0; i < WIN; i++) { re[i] = x[start + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) / half;
    frames.push({ t: (start + WIN / 2) / sr, mag, floor: noiseFloor(mag) });
  }
  return { frames, df: sr / WIN };
}

const interp = (mag, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= mag.length) return 0;
  const f = x - i;
  return mag[i] * (1 - f) + mag[i + 1] * f;
};

/** Largest magnitude within +/-1 bin of `f`. The tracked f0 is good but not
 *  exact, so a partial can straddle bins.
 *
 *  EVERY amplitude compared against another must come through here. Reading
 *  harmonics with a peak-pick and the floor between them with a plain
 *  interpolation biases the ratio by 2-3x on noise alone, which is enough to
 *  make pure noise look like a harmonic all the way to the search limit. */
function peakAt(mag, f, df) {
  const k = f / df;
  let m = 0;
  for (let o = -1; o <= 1; o += 0.25) m = Math.max(m, interp(mag, k + o));
  return m;
}

/* ============================== f0 tracking ============================= */

/** Mean excess-over-floor, in dB, across the harmonics of `f0` that fall in
 *  band. Taking the MEAN (not the sum) is what kills the octave-down error:
 *  guessing f0/2 fills half its slots with empty spectrum and halves the
 *  score, whereas a summed score would tie. */
function harmonicScore(frame, f0, df, maxHz, maxH) {
  let acc = 0, count = 0;
  for (let h = 1; h <= maxH; h++) {
    const f = h * f0;
    if (f > maxHz) break;
    const k = f / df;
    const m = interp(frame.mag, k);
    const fl = frame.floor[Math.min(frame.floor.length - 1, Math.round(k))] || 1e-12;
    acc += Math.max(0, 20 * Math.log10((m + 1e-12) / fl));
    count++;
  }
  return count >= 4 ? acc / count : 0;
}

/** Comparing the two readings of an octave ambiguity.
 *
 *  Dropping to f0/d inserts partials between the ones already found. Returns
 *  median(inserted) / median(existing), or null when the frame cannot decide.
 *
 *  Two things this must get right. Real engines DO have crank-order content
 *  in the gaps (that is what the generator's `half` models), so mere presence
 *  proves nothing - only comparable LOUDNESS means we are an octave high. And
 *  the probes have to stop while there is still signal: run them out to the
 *  8 kHz ceiling and most land past the last real harmonic, leaving the
 *  decision to a coin-toss between two patches of noise.
 */
function gapRatio(frame, f0, d, df, maxHz) {
  const have = [], added = [];
  for (let h = 1; h <= 12 * d; h++) {
    const f = (h * f0) / d;
    if (f > maxHz) break;
    const a = peakAt(frame.mag, f, df);
    const fl = frame.floor[Math.min(frame.floor.length - 1, Math.round(f / df))] || 1e-12;
    if (a < fl * 1.5) continue;                       // no signal here to judge
    (h % d === 0 ? have : added).push(a);
  }
  if (have.length < 4 || added.length < 3) return null;
  return median(added) / median(have);
}

// An inserted set this close in level to the existing one means we are
// reading the octave wrong; anything weaker is ordinary crank-order content.
const GAP_SAME = 0.8;

/** Running median over a window of `w` frames. */
function movingMedian(a, w) {
  const h = w >> 1;
  return a.map((_, i) => median(a.slice(Math.max(0, i - h), Math.min(a.length, i + h + 1))));
}

/** Octave correction across the whole track, by shortest path.
 *
 *  The per-frame octave decision is made on that frame alone, and on a real
 *  recording with strong crank-order content it flips repeatedly - the Audi
 *  clip this was built for dropped to exactly half for runs of five to
 *  seventeen frames, then jumped back. A median filter cannot fix that: a
 *  seventeen-frame run outvotes any window short enough to follow a real
 *  pull.
 *
 *  What does fix it is that an engine's speed is continuous. Each frame may
 *  keep its estimate or take an octave (or third) of it, and Viterbi picks
 *  the sequence minimising: a small cost per frame for disbelieving its own
 *  estimate, plus a large cost for any jump between neighbouring frames
 *  beyond what a real engine can do in 43 ms. A slipped run then pays for
 *  its two edges however long it is, so long runs get corrected too, while
 *  a genuine gearshift - about a quarter of an octave, spread over two or
 *  three frames - stays comfortably inside the free allowance.
 */
function fixOctaves(raw, fMin, fMax) {
  const MULT = [1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4];
  const ALPHA = 0.15;     // per frame, for not believing its own estimate
  const BETA = 4;         // per octave of implausible jump between frames
  const FREE = 0.15;      // log2 change per frame that costs nothing
  const S = MULT.length, N = raw.length;
  if (!N) return raw;

  // A multiplier that lands outside the search range is not a candidate.
  // Without this the decoder happily walks a track to three times the
  // engine's redline, which is what --rpm-max was given for.
  const ok = (i, mi) => {
    const f = raw[i] * MULT[mi];
    return !(raw[i] > 0) || (f >= fMin * 0.98 && f <= fMax * 1.02);
  };
  const emit = MULT.map((m) => ALPHA * Math.abs(Math.log2(m)));
  let cost = MULT.map((_, si) => (ok(0, si) ? (raw[0] > 0 ? emit[si] : 0) : Infinity));
  const back = [];

  for (let i = 1; i < N; i++) {
    const prev = cost;
    const next = new Float64Array(S);
    const bk = new Int8Array(S);
    for (let si = 0; si < S; si++) {
      let best = Infinity, bestT = 0;
      for (let ti = 0; ti < S; ti++) {
        let step = 0;
        if (raw[i] > 0 && raw[i - 1] > 0) {
          const d = Math.abs(Math.log2((raw[i] * MULT[si]) / (raw[i - 1] * MULT[ti])));
          step = BETA * Math.max(0, d - FREE);
        }
        const c = prev[ti] + step;
        if (c < best) { best = c; bestT = ti; }
      }
      next[si] = ok(i, si) ? best + (raw[i] > 0 ? emit[si] : 0) : Infinity;
      bk[si] = bestT;
    }
    cost = next;
    back.push(bk);
  }

  let si = 0;
  for (let k = 1; k < S; k++) if (cost[k] < cost[si]) si = k;
  const out = new Array(N);
  for (let i = N - 1; i >= 0; i--) {
    out[i] = raw[i] > 0 ? raw[i] * MULT[si] : 0;
    if (i > 0) si = back[i - 1][si];
  }
  return out;
}

/** How many coarse peaks per frame the path search may choose between. */
const CAND = 6;
/** Cost, in score-decibels, of moving the engine one octave in one hop. */
const MOVE = 55;
/** Speed changes this far per second are free - a hard pull is ~5%/hop. */
const FREE_RATE = 1.2;

/** Cheapest path through per-frame candidate lists.
 *
 *  Emission: how far this candidate scored below the best in its own frame,
 *  so a frame with one clear winner is expensive to leave and a frame with
 *  six near-ties is nearly free to route through. Transition: octaves moved
 *  per second, beyond what an engine can really do.
 *
 *  Frames with no candidate at all are skipped rather than routed through.
 *  --from/--to joins its sections with a silent gap, and silence scores
 *  nothing; chaining through it once left the whole track null. The engine
 *  is also allowed to have moved further across a long gap than across one
 *  hop, which is what `times` is for. */
function cheapestPath(cands, times) {
  const out = new Array(cands.length).fill(null);
  const idx = [];
  for (let i = 0; i < cands.length; i++) if (cands[i].length) idx.push(i);
  if (!idx.length) return out;

  const cost = [], back = [];
  for (let k = 0; k < idx.length; k++) {
    const here = cands[idx[k]];
    const top = Math.max(...here.map((c) => c.score));
    const emit = here.map((c) => top - c.score);
    if (k === 0) { cost.push(emit.slice()); back.push(here.map(() => 0)); continue; }
    const prev = cands[idx[k - 1]], pc = cost[k - 1];
    const free = Math.log2(1 + FREE_RATE * Math.max(1e-3, times[idx[k]] - times[idx[k - 1]]));
    const row = [], bk = [];
    for (let a = 0; a < here.length; a++) {
      let bestC = Infinity, bestJ = 0;
      for (let b = 0; b < prev.length; b++) {
        const d = Math.abs(Math.log2(here[a].f / prev[b].f));
        const c = pc[b] + MOVE * Math.max(0, d - free);
        if (c < bestC) { bestC = c; bestJ = b; }
      }
      row.push(bestC + emit[a]); bk.push(bestJ);
    }
    cost.push(row); back.push(bk);
  }

  let j = 0;
  const last = cost[cost.length - 1];
  for (let k = 1; k < last.length; k++) if (last[k] < last[j]) j = k;
  for (let k = idx.length - 1; k >= 0; k--) {
    out[idx[k]] = cands[idx[k]][j];
    j = back[k][j];
  }
  return out;
}

function trackF0(frames, df, sr, opts) {
  const maxHz = Math.min(8000, sr * 0.45);
  const fMin = (opts.rpmMin / 60) * opts.order;
  const fMax = (opts.rpmMax / 60) * opts.order;
  const maxH = 24;
  const track = [];

  // Per frame, keep the whole coarse score curve's best few peaks rather than
  // just its winner, and let a path through time pick between them.
  //
  // The winner alone is enough on a clean recording and hopeless on a noisy
  // one. On a V8 onboard with the harmonics only ~20 dB clear of the floor,
  // the top few peaks scored within a decibel of each other and the argmax
  // hopped between them frame by frame - 5985, 6956, 5019, 7010, 5080 rpm
  // inside two seconds. None of that is an octave, so fixOctaves could not
  // touch it, and findShifts read the hopping as 57 upshifts in 28 seconds.
  // The engine's speed is continuous, so the cheapest path wins instead:
  // each frame pays for how far its candidate is off that frame's best, and
  // each step pays for how far the speed moved.
  const cands = [];
  for (const frame of frames) {
    const curve = [], fs = [];
    for (let f = fMin; f <= fMax; f += 1) {                  // coarse
      fs.push(f); curve.push(harmonicScore(frame, f, df, maxHz, maxH));
    }
    const peaks = [];
    for (let i = 0; i < curve.length; i++) {
      if (curve[i] <= 0) continue;
      if (i > 0 && curve[i] < curve[i - 1]) continue;
      if (i < curve.length - 1 && curve[i] < curve[i + 1]) continue;
      peaks.push(i);
    }
    peaks.sort((a, b) => curve[b] - curve[a]);
    const here = [];
    for (const i of peaks.slice(0, CAND)) {                  // refine each
      let f = fs[i], sc = curve[i];
      for (let g = fs[i] - 1; g <= fs[i] + 1; g += 0.05) {
        const v = harmonicScore(frame, g, df, maxHz, maxH);
        if (v > sc) { sc = v; f = g; }
      }
      here.push({ f, score: sc });
    }
    cands.push(here);
  }
  const chosen = cheapestPath(cands, frames.map((f) => f.t));

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    let best = chosen[fi] ? chosen[fi].f : 0;
    let bestScore = chosen[fi] ? chosen[fi].score : 0;
    if (best) {
      // Octave resolution - see gapRatio(). Both directions are needed.
      // The coarse search is biased LOW all by itself: scoring the mean
      // excess over a fixed 8 kHz span means a subharmonic gets judged on
      // fewer, lower, stronger partials and can outscore the true firing
      // frequency outright. So climb first, then descend. Each move needs a
      // decisive measurement - an undecidable frame stays where it is.
      for (let i = 0; i < 2; i++) {
        let moved = false;
        for (const d of [2, 3]) {
          const up = best * d;
          if (up > fMax) continue;
          const upScore = harmonicScore(frame, up, df, maxHz, maxH);
          if (upScore < 0.5 * bestScore) continue;
          const g = gapRatio(frame, up, d, df, maxHz);
          if (g == null || g >= GAP_SAME) continue;   // the gap partials are real
          best = up; bestScore = upScore; moved = true;
          break;
        }
        if (!moved) break;
      }
      for (const d of [2, 3]) {
        const sub = best / d;
        if (sub < fMin) continue;
        const g = gapRatio(frame, best, d, df, maxHz);
        if (g == null || g < GAP_SAME) continue;
        best = sub;
        bestScore = harmonicScore(frame, sub, df, maxHz, maxH);
        break;
      }
    }
    track.push({ t: frame.t, f0: best, score: bestScore, frame });
  }

  // Settle the octave across time first, then a short median to take the
  // jitter off. Order matters: median-filtering a track that is jumping by a
  // factor of two just smears the jumps.
  const fixed = fixOctaves(track.map((p) => p.f0), fMin, fMax);
  const smoothed = movingMedian(fixed, 5);
  for (let i = 0; i < track.length; i++) {
    track[i].f0s = smoothed[i];
    track[i].rpm = (track[i].f0s * 60) / opts.order;
  }
  return track;
}

/* ============================== segmentation ============================ */

/** Confident frames only: a weak or ambiguous frame poisons every average. */
function confident(track) {
  const scores = track.map((p) => p.score).filter((s) => s > 0);
  const cut = Math.max(3, median(scores) * 0.5);
  return track.filter((p) => p.score >= cut && p.f0s > 0);
}

/** Ignition-cut upshifts, found on the SLOPE of the rpm track.
 *
 *  Not a frame-to-frame drop: a 170 ms analysis window smears a step change
 *  across three or four frames, so the per-frame difference never reaches
 *  the size of the real one and a fixed drop threshold finds nothing. The
 *  rate separates cleanly instead - a shift unloads the engine at well over
 *  10 000 rpm/s where engine braking manages one or two thousand - and the
 *  ratio is then read off the peak before and the trough after, clear of the
 *  smeared frames in between.
 */
function findShifts(track, dt) {
  const SHIFT_SLOPE = -4000;             // rpm/s; engine braking never gets near
  const shifts = [];
  const rpmOf = (i) => (track[i] ? track[i].rpm : 0);
  let i = 1;
  while (i < track.length - 1) {
    const slope = (rpmOf(i + 1) - rpmOf(i - 1)) / (2 * dt);
    if (slope > SHIFT_SLOPE) { i++; continue; }
    let end = i;
    while (end < track.length - 2
      && (rpmOf(end + 2) - rpmOf(end)) / (2 * dt) < SHIFT_SLOPE) end++;

    let before = 0, after = Infinity;
    for (let k = Math.max(0, i - 4); k <= i; k++) before = Math.max(before, rpmOf(k));
    for (let k = end; k <= Math.min(track.length - 1, end + 4); k++) after = Math.min(after, rpmOf(k));

    // A lift reads exactly like a shift on the way down; what separates them
    // is what happens next. After an upshift the engine pulls again.
    let resumes = 0;
    for (let k = end; k <= Math.min(track.length - 1, end + 24); k++) {
      resumes = Math.max(resumes, rpmOf(k));
    }
    if (before - after >= 250 && after > 0 && resumes > after + 150) {
      shifts.push({
        t: r2(track[i].t), rpmBefore: Math.round(before), rpmAfter: Math.round(after),
        ratioStep: r3(before / after), frames: end - i + 1
      });
    }
    i = end + 2;
  }
  return shifts;
}

/** rising = on throttle, falling = overrun. Shift frames are excluded, or a
 *  rev-match would be filed as overrun. */
function classify(track, dt, shifts) {
  const near = (t) => shifts.some((s) => Math.abs(s.t - t) < 0.35);
  for (let i = 1; i < track.length - 1; i++) {
    const slope = (track[i + 1].rpm - track[i - 1].rpm) / (2 * dt);
    track[i].slope = slope;
    track[i].state = near(track[i].t) ? 'shift'
      : slope > 250 ? 'throttle'
        : slope < -250 ? 'overrun'
          : 'steady';
  }
  if (track.length) {
    track[0].state = 'steady';
    track[track.length - 1].state = 'steady';
  }
  return track;
}

/* ========================== harmonic measurement ======================== */

// A partial counts as present at ~6 dB over its local floor, and is only
// trusted to CARRY A LEVEL at ~10 dB. The gap matters: counting harmonics
// wants the looser bar, fitting a slope through them wants the tighter one.
const SNR_PRESENT = 2;
const SNR_FIT = 3;

/** Per frame: harmonic amplitudes, half-order amplitudes and the floor
 *  between harmonics, all relative to that frame's own f0. */
function harmonicsOf(frame, f0, df, maxHz, maxH, order) {
  // The floor beside a harmonic: the typical level across the gap up to the
  // next one, sampled rather than assumed.
  //
  // Both halves of this comparison have to come through peakAt, or the
  // max-of-five-samples bias makes noise look like signal. Where to sample
  // is the harder half. Probing at fixed fractions of f0 assumes where the
  // gaps are, and that assumption is order-dependent: a V8 fires four times
  // per revolution, so an engine order sits at every quarter of f0, and a
  // probe at 0.2 or 0.3 f0 lands in the skirt of a real partial. That
  // collapsed every SNR in a V8 clip - all six rev bands fell back to the
  // default tilt because fewer than three harmonics cleared their own floor.
  //
  // So keep sweeping the gap and taking the median, but sweep only the parts
  // of it that ARE gaps: a dense set of offsets with a guard band removed
  // around every whole ENGINE order, which is where an engine puts its
  // content whatever its cylinder count. Measured on a known layer, the
  // offsets left over read 10-20 dB below the whole orders either side.
  //
  // Two bounds matter. Offsets closer than 2.5 bins are dropped, because the
  // window cannot separate those from the harmonic itself. And the span
  // stays near one f0 either side: a floor sampled three harmonics away is
  // not a local floor, and on a resonance it reads the slope instead of the
  // gap.
  const fr = f0 / order;                               // crank rotation, Hz
  const offs = [];
  for (let n = 0.125; n * fr <= 1.1 * f0 + 1e-9; n += 0.125) {
    if (Math.abs(n - Math.round(n)) < 0.2) continue;   // a whole engine order lives here
    if (n * fr < 2.5 * df) continue;                   // unresolvable at this f0
    offs.push(n * fr);
  }
  if (!offs.length) offs.push(Math.max(2.5 * df, 0.5 * fr));   // low f0: best we can do
  // Reused across calls to keep one array instead of one per harmonic.
  const probes = [];
  const localFloor = (f) => {
    probes.length = 0;
    for (const d of offs) {
      probes.push(peakAt(frame.mag, f + d, df));
      if (f - d > 20) probes.push(peakAt(frame.mag, f - d, df));
    }
    // Median, not minimum. The minimum of sixteen peak-picks is biased low
    // exactly as a single peak-pick is biased high, and either bias alone is
    // enough to move the harmonic count by 60%.
    return Math.max(median(probes), 1e-12);
  };

  // A measured partial is the partial PLUS the floor it sits on. Subtract it
  // in power - without this, a partial that is not there at all still reads
  // as one, which puts a hard floor under every ratio fitted downstream (a
  // generated half=0 measured back as half=0.23).
  const clean = (a, fl) => Math.sqrt(Math.max(0, a * a - fl * fl));

  const A = [], halfA = [], floors = [];
  for (let h = 1; h <= maxH; h++) {
    const f = h * f0;
    if (f > maxHz) break;
    const fl = localFloor(f), raw = peakAt(frame.mag, f, df);
    A.push({ h, f, a: clean(raw, fl), snr: raw / Math.max(fl, 1e-12) });
    if (f + f0 * 0.5 < maxHz) floors.push({ h, f: f + f0 * 0.5, a: fl });
  }
  for (let h = 1; h <= maxH; h++) {
    const x = h - 0.5;                                       // 0.5, 1.5, 2.5 ... crank order
    const f = x * f0;
    if (f > maxHz) break;
    const fl = localFloor(f), raw = peakAt(frame.mag, f, df);
    halfA.push({ x, f, a: clean(raw, fl), snr: raw / Math.max(fl, 1e-12) });
  }
  return { A, halfA, floors };
}

/** Pool frames (already filtered to one state / rev band) into the numbers
 *  js/synth.js makeEngineLoop actually reads. */
function fitSpec(points, sr) {
  const byH = new Map(), byX = new Map();
  const snrH = new Map(), snrX = new Map();
  const floorF = [], floorA = [];
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

  const usable = [];
  for (const p of points) {
    const { A, halfA, floors } = p.harm;
    const a1 = A.length ? A[0].a : 0;
    if (!(a1 > 0)) continue;
    usable.push(p);
    p._a1 = a1;
    for (const { h, a, snr } of A) { push(byH, h, a / a1); push(snrH, h, snr); }
    for (const { x, a, snr } of halfA) { push(byX, x, a / a1); push(snrX, x, snr); }
    for (const { f, a } of floors) { floorF.push(f); floorA.push(a / a1); }
  }
  if (!byH.size) return null;

  const hs = [...byH.keys()].sort((a, b) => a - b);
  const relH = hs.map((h) => median(byH.get(h)));

  // FIRST find where the harmonics stop, by comparing each against the floor
  // just above it. Everything after this point is fitted over 1..harmonics
  // only: fitting the tilt across the noise beyond the last real harmonic
  // drags the slope steeply negative, and every parameter derived from tilt
  // then inherits the error.
  // Smoothed across harmonic INDEX before the cutoff test. Engine spectra
  // have notches - an interference dip at one or two orders - and testing
  // raw values stops the count at the first notch: the Audi rolls off
  // smoothly to the sixteenth harmonic but has a dip at the eighth, and the
  // count came back as seven.
  const rawSnr = hs.map((h) => median(snrH.get(h) || [0]));
  const snrSm = rawSnr.map((_, i) => median(rawSnr.slice(Math.max(0, i - 1), i + 2)));
  let harmonics = 1, misses = 0;
  for (let i = 0; i < hs.length; i++) {
    if (snrSm[i] >= SNR_PRESENT) { harmonics = hs[i]; misses = 0; }
    else if (++misses >= 3) break;
  }
  const snrOf = (h) => snrSm[hs.indexOf(h)] ?? 0;

  // Fit only where there is signal to fit. Once the floor has been subtracted,
  // a harmonic that was never there sits near zero, and log10 of near-zero
  // dominates a least-squares fit completely - a generated tilt of -0.9 came
  // back as -1.50 before this gate.
  const keep = hs.map((_, i) => i)
    .filter((i) => hs[i] <= harmonics && relH[i] > 0 && snrOf(hs[i]) >= SNR_FIT);

  // tilt: amp ~ h^tilt, so dB is linear in log10(h) with slope 20*tilt.
  const fitH = keep.map((i) => Math.log10(hs[i]));
  const fitY = keep.map((i) => 20 * Math.log10(relH[i]));
  const tilt = fitH.length >= 3 ? regress(fitH, fitY).slope / 20 : -1.2;
  const predicted = (h) => Math.pow(h, tilt);

  // half: crank-order content against what the tilt predicts at that index.
  //
  // Summed, not a median of per-order ratios. The half-orders fade into the
  // floor long before the firing harmonics do, so most of the orders in
  // range read zero and a median over them returns zero however loud the
  // first few are - a generated 0.5 measured back as 0. Summing lets the low
  // orders, which are the ones you actually hear, carry the answer.
  let halfGot = 0, halfPred = 0;
  for (const [x, arr] of byX) {
    if (x > harmonics) continue;
    const pred = Math.pow(x, tilt - 0.15);
    if (!(pred > 0)) continue;
    halfPred += pred;
    if (median(snrX.get(x) || [0]) >= SNR_PRESENT) halfGot += median(arr);
  }
  // Bounded. Above about 1.4 the crank orders would be louder than the
  // firing harmonics, which does not happen; a number above that means the
  // fit broke down, usually on a band with too few frames to average.
  const halfAmt = Math.min(1.4, halfPred > 0 ? halfGot / halfPred : 0);

  // oddBias multiplies the EVEN harmonics in the generator (js/synth.js).
  const odd = [], even = [];
  for (const i of keep) (hs[i] % 2 ? odd : even).push(relH[i] / predicted(hs[i]));
  const oddBias = odd.length && even.length ? median(even) / median(odd) : 1;

  // The floor BETWEEN the harmonics, and how it tilts with frequency.
  //
  // Deliberately not converted into the generator's `noise` parameter. That
  // inversion looks like simple algebra and is not: the probes pick up
  // window leakage and shimmer skirts as well as the noise bed, and the
  // resulting additive offset measured larger than the parameter's whole
  // useful range (a generated 0.15 and 0.45 both read back around 1.5-2.9,
  // and the scale factor moved by 2x across rev bands). `fitGenerator` finds
  // it by closing the loop instead.
  const lf = [], la = [];
  for (let i = 0; i < floorF.length; i++) {
    if (floorA[i] > 0 && floorF[i] > 60) {
      lf.push(Math.log10(floorF[i] / 250));
      la.push(Math.log10(floorA[i]));
    }
  }
  const nFit = regress(lf, la);

  // Resonance cloud: measured harmonic over tilt-predicted harmonic, against
  // ABSOLUTE frequency. The rev sweep does the deconvolution.
  const resF = [], resR = [];
  for (const p of usable) {
    for (const { h, f, a } of p.harm.A) {
      if (h > harmonics) break;
      const pred = p._a1 * predicted(h);
      if (pred > 0 && a > 0) { resF.push(f); resR.push(a / pred); }
    }
  }

  return {
    tilt: r3(tilt),
    harmonics,
    half: r3(Math.max(0, halfAmt)),
    oddBias: r3(oddBias),
    noiseTilt: r3(nFit.slope),
    floorRel: r3(median(floorA.length ? floorA : [0])),
    floorDb: r2(20 * Math.log10(Math.max(1e-9, median(floorA.length ? floorA : [1e-9])))),
    frames: usable.length,
    harmonicProfile: hs.map((h, i) => [h, r3(relH[i])]),
    _res: { f: resF, r: resR }
  };
}

/** Log-spaced average of the resonance cloud -> a smooth envelope. */
function resonanceCurve(resF, resR, sr) {
  // 96 log-spaced bands, ~5.5% apart. Finer than this was tried and is
  // worse: each bin then holds too few samples, the extra noise sharpens
  // every peak, and a resonance of known Q 3 came back as the clamped Q 8.
  // A reported Q at the clamp means "narrower than this can resolve".
  const lo = 50, hi = Math.min(8000, sr * 0.45), bands = 96;
  const step = Math.log(hi / lo) / bands;
  const buckets = Array.from({ length: bands }, () => []);
  for (let i = 0; i < resF.length; i++) {
    if (resF[i] < lo || resF[i] > hi) continue;
    buckets[Math.min(bands - 1, Math.floor(Math.log(resF[i] / lo) / step))].push(resR[i]);
  }
  const out = [];
  for (let b = 0; b < bands; b++) {
    if (buckets[b].length < 6) continue;
    out.push({ f: Math.round(lo * Math.exp((b + 0.5) * step)), g: median(buckets[b]), n: buckets[b].length });
  }
  return out;
}

/** The between-harmonic floor as a log-frequency curve, divided by its own
 *  smooth trend so a resonant bulge stands out from the overall spectral
 *  slope. */
function floorBulge(points, sr) {
  const F = [], R = [];
  for (const p of points) {
    const a1 = p.harm.A.length ? p.harm.A[0].a : 0;
    if (!(a1 > 0)) continue;
    for (const { f, a } of p.harm.floors) { F.push(f); R.push(a / a1); }
  }
  const curve = resonanceCurve(F, R, sr);
  if (curve.length < 8) return [];
  const lx = curve.map((c) => Math.log10(c.f));
  const ly = curve.map((c) => Math.log10(Math.max(1e-12, c.g)));
  const { slope, intercept } = regress(lx, ly);
  return curve.map((c, i) => ({
    f: c.f, level: c.g, bulge: c.g / Math.pow(10, intercept + slope * lx[i])
  }));
}

/** Induction: a resonant bulge in the floor that TRACKS RPM and collapses
 *  when the throttle shuts.
 *
 *  Three things this has to avoid. Induction roar is broadband, so it lives
 *  between the harmonics, not on them. Its band moves with engine speed, so
 *  it has to be found per rev band and regressed - which is also what
 *  `intake.freq` in the config actually wants. And it cannot be found by
 *  maximising the on-throttle / overrun ratio, because that ratio blows up
 *  wherever the overrun spectrum happens to be quietest, which is the top
 *  end, every time.
 */
function induction(onThr, ovr, sr, rpmLo, rpmHi) {
  const LO = 200, HI = 6000;
  const picks = [];
  const edges = 5;                       // more picks = a less levered intercept
  for (let b = 0; b < edges; b++) {
    const a = rpmLo * Math.pow(rpmHi / rpmLo, b / edges);
    const z = rpmLo * Math.pow(rpmHi / rpmLo, (b + 1) / edges);
    const pts = onThr.filter((p) => p.rpm >= a && p.rpm < z);
    if (pts.length < 6) continue;
    const c = floorBulge(pts, sr).filter((x) => x.f >= LO && x.f <= HI);
    if (!c.length) continue;
    const best = c.reduce((x, y) => (y.bulge > x.bulge ? y : x));
    if (best.bulge < 1.3) continue;                      // no real bulge here
    picks.push({ rpm: median(pts.map((p) => p.rpm)), f: best.f, bulge: r2(best.bulge) });
  }
  if (!picks.length) return null;

  const fit = picks.length >= 2
    ? regress(picks.map((p) => p.rpm), picks.map((p) => p.f))
    : { slope: 0, intercept: picks[0].f };

  // Confirm it really is induction: does it collapse off throttle?
  const midRpm = median(picks.map((p) => p.rpm));
  const centre = Math.max(LO, Math.min(HI, fit.intercept + fit.slope * midRpm));
  const near = (curve) => {
    const hit = curve.filter((x) => Math.abs(Math.log2(x.f / centre)) < 0.25);
    return hit.length ? median(hit.map((x) => x.level)) : null;
  };
  const onLvl = near(floorBulge(onThr, sr));
  const offLvl = ovr.length >= 6 ? near(floorBulge(ovr, sr)) : null;

  return {
    centreHz: Math.round(centre),
    freqBase: Math.round(fit.intercept),
    freqPerRpm: r3(fit.slope),
    onOverOverrun: onLvl && offLvl ? r2(onLvl / offLvl) : null,
    perBand: picks.map((p) => [Math.round(p.rpm), p.f, p.bulge])
  };
}

/** Top peaks of the resonance envelope -> the profile's `formants` array. */
function pickFormants(curve, want) {
  if (curve.length < 5) return [];
  // 3-point median first. On the raw envelope a single noisy bin next to a
  // peak stops the -3 dB walk early, which pins every Q at the clamp and
  // invents narrow peaks that are not resonances.
  const sm = curve.map((c, i) => median(curve.slice(Math.max(0, i - 1), i + 2).map((x) => x.g)));
  const dbs = sm.map((g) => 20 * Math.log10(Math.max(1e-6, g)));
  const base = median(dbs);
  const peaks = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (dbs[i] <= dbs[i - 1] || dbs[i] < dbs[i + 1]) continue;
    // -3 dB width, with the crossing interpolated between bins. Snapping to
    // bin edges quantises the width to whole log-frequency steps, and at this
    // curve's resolution that pins almost every Q at the same one or two
    // values - three separate resonances came back as Q 6.07, 6.12, 6.12.
    let l = i, r = i;
    while (l > 0 && dbs[l] > dbs[i] - 3) l--;
    while (r < curve.length - 1 && dbs[r] > dbs[i] - 3) r++;
    const cross = (a, b) => {
      const da = dbs[a], db2 = dbs[b], want = dbs[i] - 3;
      if (a === b || da === db2) return Math.log(curve[a].f);
      const t = Math.min(1, Math.max(0, (da - want) / (da - db2)));
      return Math.log(curve[a].f) + t * (Math.log(curve[b].f) - Math.log(curve[a].f));
    };
    const fl = Math.exp(cross(Math.min(l + 1, i), l));
    const fr = Math.exp(cross(Math.max(r - 1, i), r));
    const bw = Math.max(1e-6, fr - fl);
    peaks.push({
      n: curve[i].n,
      freq: curve[i].f,
      q: r2(Math.max(0.4, Math.min(8, curve[i].f / bw))),
      // dB, because that is what soundconfig's `formants[].gain` is: it goes
      // straight to a peaking BiquadFilterNode's .gain, which is in dB. A
      // linear ratio here would write +1.7 where +4.5 dB was measured and
      // leave the resonance all but inaudible.
      gain: r2(dbs[i] - base)
    });
  }
  peaks.sort((a, b) => b.gain - a.gain);
  const kept = [];
  // A bin fed by a handful of harmonics is mostly sampling error. At the
  // bottom of the range only h1 and h2 ever land, so without this the noise
  // down there outranks a real resonance higher up and crowds it out of the
  // list entirely.
  const maxN = Math.max(...curve.map((c) => c.n));
  for (const p of peaks) {
    if (p.gain < 1.5) continue;                                            // not a resonance
    if (p.n < maxN * 0.02) continue;                                       // too few samples
    if (kept.some((k) => Math.abs(Math.log2(k.freq / p.freq)) < 0.4)) continue;   // same peak twice
    kept.push(p);
    if (kept.length >= want) break;
  }
  return kept.sort((a, b) => a.freq - b.freq);
}

/** Narrow partials at a NON-integer engine order: straight-cut gear whine. It
 *  sits at a different order in every gear, so expect several. */
function findWhine(points, df, sr, order) {
  const maxHz = Math.min(8000, sr * 0.45);
  const hist = new Map();
  for (const p of points) {
    const f0 = p.f0s;
    if (!(f0 > 0)) continue;
    const { mag, floor } = p.frame;
    for (let k = 2; k < mag.length - 1; k++) {
      const f = k * df;
      if (f < 400 || f > maxHz) continue;
      if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      if (mag[k] < (floor[k] || 1e-12) * 6) continue;
      // Engine order: multiples of the crank speed, so the firing harmonics
      // sit at multiples of `order` and the crank half-orders at every 0.5.
      // Skip anything on that grid; a straight-cut gear runs at a shaft speed
      // unrelated to it, which is exactly what makes it findable.
      const eo = (f / f0) * order;
      if (Math.abs(eo * 2 - Math.round(eo * 2)) < 0.25) continue;
      const key = Math.round(eo * 10) / 10;
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  return [...hist.entries()]
    .filter(([, n]) => n >= Math.max(8, points.length * 0.08))
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([eo, n]) => ({ order: eo, hits: n }));
}

/* ================================ report ================================ */

function bandsFor(rpmLo, rpmHi, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(Math.round(rpmLo * Math.pow(rpmHi / rpmLo, i / (count - 1))));
  return out;
}

export function analyse(samples, sr, opts) {
  const { frames, df } = stft(samples, sr);
  if (frames.length < 8) throw new Error('clip too short: ' + frames.length + ' frames');
  const dt = HOP / sr;
  const maxHz = Math.min(8000, sr * 0.45);

  let track = trackF0(frames, df, sr, opts);
  const shifts = findShifts(track, dt);
  track = classify(track, dt, shifts);
  const good = confident(track);
  for (const p of good) p.harm = harmonicsOf(p.frame, p.f0s, df, maxHz, 40, opts.order);

  const rpms = good.map((p) => p.rpm).sort((a, b) => a - b);
  const pct = (q) => rpms[Math.min(rpms.length - 1, Math.floor(rpms.length * q))] || 0;
  const rpmLo = Math.round(pct(0.02)), rpmHi = Math.round(pct(0.995));

  const byState = (s) => good.filter((p) => p.state === s);
  const overrun = byState('overrun');
  const onThr = byState('throttle').concat(byState('steady'));

  // Per-band fits over the on-throttle frames: the six pitched layers.
  const bandFits = bandsFor(Math.max(rpmLo, 500), Math.max(rpmHi, 1000), opts.bands).map((c) => {
    const pts = onThr.filter((p) => p.rpm >= c / 1.22 && p.rpm <= c * 1.22);
    const fit = pts.length >= 4 ? fitSpec(pts, sr) : null;
    if (fit) delete fit._res;
    return { baseRpm: c, covered: pts.length, fit };
  });

  const thrFit = fitSpec(onThr, sr);
  const ovrFit = overrun.length >= 6 ? fitSpec(overrun, sr) : null;
  const thrCurve = thrFit ? resonanceCurve(thrFit._res.f, thrFit._res.r, sr) : [];
  const ovrCurve = ovrFit ? resonanceCurve(ovrFit._res.f, ovrFit._res.r, sr) : [];
  const formants = pickFormants(thrCurve, 5);

  const intake = induction(onThr, overrun, sr, Math.max(rpmLo, 600), Math.max(rpmHi, 1200));

  if (thrFit) delete thrFit._res;
  if (ovrFit) delete ovrFit._res;

  return {
    input: {
      sampleRate: sr, seconds: r2(samples.length / sr), frames: frames.length,
      analysed: good.length, order: opts.order
    },
    rpm: {
      min: rpmLo, max: rpmHi, median: Math.round(median(rpms)),
      limiterHint: Math.round(pct(0.999)), firingHzAtMax: r2((rpmHi / 60) * opts.order)
    },
    states: {
      throttle: byState('throttle').length, overrun: overrun.length,
      steady: byState('steady').length, shift: byState('shift').length
    },
    shifts: {
      count: shifts.length,
      upshiftRpm: shifts.length ? Math.round(median(shifts.map((s) => s.rpmBefore))) : null,
      ratioSteps: shifts.map((s) => s.ratioStep),
      medianRatioStep: shifts.length ? r3(median(shifts.map((s) => s.ratioStep))) : null,
      events: shifts
    },
    onThrottle: thrFit,
    overrun: ovrFit,
    bands: bandFits,
    formants,
    resonance: {
      throttle: thrCurve.map((c) => [c.f, r3(c.g)]),
      overrun: ovrCurve.map((c) => [c.f, r3(c.g)])
    },
    intake,
    whine: findWhine(good, df, sr, opts.order),
    _track: track.map((p) => [r2(p.t), Math.round(p.rpm), p.state])
  };
}

/* =========================== profile suggestion ========================= */

/** Shape the measurements the way soundconfig.json wants them. Curves and
 *  gains still come from the preset calculator; this fills in the parts only
 *  the recording can answer. */
function suggestProfile(rep, key) {
  const g = (fit, extra) => fit && Object.assign({
    type: 'engine', order: rep.input.order,
    harmonics: fit.harmonics, tilt: fit.tilt, half: fit.half,
    oddBias: fit.oddBias, noiseTilt: fit.noiseTilt
  }, extra);
  const redline = Math.round(rep.rpm.limiterHint / 50) * 50;
  return {
    [key]: {
      engine: {
        idleRpm: null,                     // a track recording never idles - pick by hand
        maxRpm: redline + 300,
        redlineRpm: redline,
        shiftUpRpm: rep.shifts.upshiftRpm,
        _gearRatioStep: rep.shifts.medianRatioStep,
        _note: 'gearRatios: apply the measured step between gears, scaled to taste.'
      },
      formants: rep.formants.map((f) => ({ freq: f.freq, q: f.q, gain: f.gain })),
      intake: rep.intake
        ? { freq: { base: rep.intake.freqBase, rpm: rep.intake.freqPerRpm },
            _onOverOverrun: rep.intake.onOverOverrun }
        : null,
      whine: rep.whine.length ? { order: rep.whine[0].order } : null,
      layers: rep.bands.filter((b) => b.fit).map((b) => ({
        baseRpm: b.baseRpm, frames: b.covered,
        generate: b.fitted || g(b.fit, { baseRpm: b.baseRpm })
      })),
      overrunGenerate: rep.overrunFitted || g(rep.overrun)
    }
  };
}

/* ============================ closed-loop fit =========================== */

/* Measuring a recording gives numbers. Turning those into GENERATOR settings
 * is a second, separate problem, and inverting the generator's formulas by
 * hand does not survive contact with the measurement: every estimator here
 * carries some bias, and for the quieter parameters that bias is larger than
 * the parameter.
 *
 * So do not invert anything. Render a candidate, measure it with the SAME
 * instrument, and move the setting until the two readings agree. Whatever the
 * instrument gets wrong, it gets wrong identically on both sides and cancels.
 * The cost is a few dozen renders per band, which is why it is opt-in.
 */

const FIT_SECONDS = 3;

// The synth's `noise` is the engine's own combustion hash. The shipped
// profiles sit at 0.2-0.42; anything past this needs the between-harmonic
// floor of a clean engine recording to be higher than a real engine's is,
// which in practice means the floor being measured is wind and road noise
// instead. Matching that would put the wind inside the engine voice.
const NOISE_MAX = 1.2;

/** The instrument's reading of a generated spec - the same fields it reports
 *  for a recording, so the two are directly comparable. */
export function measureSpec(spec, sr = 48000) {
  const { samples } = render(spec, sr);
  const reps = Math.max(1, Math.ceil((FIT_SECONDS * sr) / samples.length));
  const long = new Float32Array(samples.length * reps);
  for (let i = 0; i < reps; i++) long.set(samples, i * samples.length);
  // Bracket the search around the rpm we just generated. Without it a spec
  // with strong crank-order content gets tracked an octave low - the gap
  // partials genuinely are as loud as the firing ones, so the tracker is not
  // wrong, it just has no way to know which reading was intended. Here we do
  // know. (On a real recording that lever is --order with --rpm-min/--rpm-max.)
  const rpm = spec.baseRpm || 3000;
  const fit = analyse(long, sr, {
    order: spec.order, rpmMin: rpm * 0.75, rpmMax: rpm * 1.35, bands: 1
  }).onThrottle;
  return fit && { tilt: fit.tilt, half: fit.half, floorDb: fit.floorDb, harmonics: fit.harmonics };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Damped fixed-point iteration: nudge every setting by its own reading
 *  error, all three together, and re-measure.
 *
 *  Not bisection per setting. The settings are coupled - `half` moves the
 *  measured tilt, `tilt` moves where the floor is measured - and coordinate
 *  descent over coupled axes walked two of three test cases straight into
 *  the bracket edge. Updating them together converges, and costs one render
 *  per iteration instead of one per bisection step.
 */
export function fitGenerator(target, base, sr = 48000, onStep) {
  let spec = { ...base };
  let best = null, bestErr = Infinity;
  for (let i = 0; i < 8; i++) {
    const got = measureSpec(spec, sr);
    if (!got) break;
    const dTilt = target.tilt - got.tilt;
    const dHalf = target.half - got.half;
    const dFloor = target.floorDb - got.floorDb;
    const err = Math.abs(dTilt) / 0.05 + Math.abs(dHalf) / 0.05 + Math.abs(dFloor) / 1.0;
    if (err < bestErr) { bestErr = err; best = { ...spec }; }
    if (onStep) onStep(i, spec, got);
    if (Math.abs(dTilt) < 0.02 && Math.abs(dHalf) < 0.02 && Math.abs(dFloor) < 0.5) break;
    spec = {
      ...spec,
      tilt: clamp(spec.tilt + 0.8 * dTilt, -2.2, -0.35),
      half: clamp(spec.half + 0.8 * dHalf, 0, 1.4),
      noise: clamp(spec.noise * Math.pow(10, clamp(dFloor, -12, 12) / 20), 0.005, NOISE_MAX)
    };
  }
  const r3v = (v) => Math.round(v * 1000) / 1000;
  if (!best) return null;
  const out = { ...best, tilt: r3v(best.tilt), half: r3v(best.half), noise: r3v(best.noise) };
  if (out.noise >= NOISE_MAX - 1e-6) out._noiseCapped = true;
  return out;
}

/* ============================== loop cutting ============================ */

/** A whole number of firing cycles at the measured f0, crossfaded. Derived
 *  from the source recording, so keep the output out of git. */
function emitLoops(samples, sr, rep, dir) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const band of rep.bands) {
    if (!band.covered) continue;
    const hit = rep._track.find(([, rpm, st]) =>
      st !== 'shift' && Math.abs(rpm - band.baseRpm) < band.baseRpm * 0.04);
    if (!hit) continue;
    const f0 = (band.baseRpm / 60) * rep.input.order;
    const len = Math.round(Math.max(8, Math.round(0.6 * f0)) * (sr / f0));
    const start = Math.max(0, Math.round(hit[0] * sr) - (len >> 1));
    if (start + len + 512 > samples.length) continue;
    const seg = samples.slice(start, start + len);
    const fade = Math.min(256, len >> 3);                     // hide the residual seam
    for (let i = 0; i < fade; i++) {
      const w = i / fade;
      seg[i] = seg[i] * w + samples[start + len + i] * (1 - w);
    }
    const path = join(dir, `band_${band.baseRpm}.wav`);
    writeWav(path, seg, sr);
    written.push({ path, baseRpm: band.baseRpm, samples: len });
  }
  return written;
}

/* ================================ selftest ============================== */

/** Render the app's own loops and check the analyser gets back what they were
 *  generated with. An instrument that has not been checked against a known
 *  input is just a more confident guess. */
function selftest() {
  const sr = 48000;
  const cases = [
    ['hot-hatch-i4', 'low_mid'], ['hot-hatch-i4', 'top'],
    ['hot-hatch-i4', 'overrun_high'], ['muscle-v8', 'mid'],
    ['e-sound-synth', 'high_mid']
  ];
  let fails = 0;
  console.log("rendering the app's own layers and measuring them back:\n");
  for (const [prof, id] of cases) {
    const spec = layerSpec(prof, id);
    const { samples, baseRpm } = render(spec, sr);
    // One loop is around a second; repeat it so there are frames to average.
    const reps = Math.ceil((6 * sr) / samples.length);
    const long = new Float32Array(samples.length * reps);
    for (let i = 0; i < reps; i++) long.set(samples, i * samples.length);

    const rep = analyse(long, sr, { order: spec.order, rpmMin: 400, rpmMax: 10000, bands: 3 });
    const fit = rep.onThrottle;
    // Only harmonics below the 8 kHz analysis ceiling can be seen at all.
    const visible = Math.floor(8000 / ((baseRpm / 60) * spec.order));
    const wantHarm = Math.min(spec.harmonics, visible);
    const err = {
      rpm: Math.abs(rep.rpm.median - baseRpm) / baseRpm,
      tilt: Math.abs(fit.tilt - spec.tilt),
      half: Math.abs(fit.half - spec.half),
      harm: Math.abs(fit.harmonics - wantHarm) / wantHarm
    };
    const ok = err.rpm < 0.02 && err.tilt < 0.25 && err.half < 0.3 && err.harm < 0.2;
    if (!ok) fails++;
    const line = (k, want, got, e) => `    ${k.padEnd(10)} want ${String(want).padStart(6)}`
      + `   got ${String(got).padStart(6)}   err ${e}`;
    console.log(`  ${prof}/${id}   order ${spec.order}`);
    console.log(line('rpm', baseRpm.toFixed(0), rep.rpm.median, (err.rpm * 100).toFixed(2) + '%'));
    console.log(line('tilt', spec.tilt, fit.tilt, err.tilt.toFixed(2)));
    console.log(line('half', spec.half, fit.half, err.half.toFixed(2)));
    console.log(line('harmonics', wantHarm + (wantHarm < spec.harmonics ? '*' : ''),
      fit.harmonics, (err.harm * 100).toFixed(0) + '%')
      + (wantHarm < spec.harmonics ? `   (* ${spec.harmonics} generated, rest above 8 kHz)` : ''));
    console.log(`    -> ${ok ? 'OK' : 'FAIL'}\n`);
  }
  // The closed loop is the part that actually produces settings, so it gets
  // its own check: hide a spec, measure it as if it were a recording, fit
  // from a deliberately wrong start, and see if the settings come back.
  console.log('closed-loop fit - recovering hidden settings:\n');
  const hidden = [
    { type: 'engine', order: 2, baseRpm: 3300, duration: 1.12, harmonics: 24, tilt: -1.05,
      half: 0.45, noise: 0.33, noiseTilt: -0.82, shimmer: 0.23, grit: 0.33, seed: 13 },
    { type: 'engine', order: 4, baseRpm: 2650, duration: 1.0, harmonics: 20, tilt: -1.35,
      half: 0.7, noise: 0.18, noiseTilt: -0.9, shimmer: 0.15, grit: 0.2, seed: 77 },
    { type: 'engine', order: 2, baseRpm: 6200, duration: 1.4, harmonics: 30, tilt: -0.78,
      half: 0.24, noise: 0.42, noiseTilt: -0.7, shimmer: 0.3, grit: 0.48, seed: 15 }
  ];
  for (const truth of hidden) {
    const target = measureSpec(truth, sr);
    const got = fitGenerator(target, { ...truth, tilt: -1.2, half: 0.4, noise: 0.25 }, sr);
    const e = {
      tilt: Math.abs(got.tilt - truth.tilt),
      half: Math.abs(got.half - truth.half),
      noise: Math.abs(got.noise - truth.noise)
    };
    const ok = e.tilt < 0.1 && e.half < 0.12 && e.noise < 0.06;
    if (!ok) fails++;
    console.log(`  order ${truth.order} @ ${truth.baseRpm} rpm`);
    console.log(`    tilt  ${String(truth.tilt).padStart(6)} -> ${String(got.tilt).padStart(6)}`
      + `   half ${String(truth.half).padStart(5)} -> ${String(got.half).padStart(5)}`
      + `   noise ${String(truth.noise).padStart(5)} -> ${String(got.noise).padStart(5)}`);
    console.log(`    -> ${ok ? 'OK' : 'FAIL'}\n`);
  }

  console.log(fails ? `${fails} case(s) failed` : 'all spectral cases within tolerance');
  return fails;
}

/* ================================= CLI ================================== */

const USAGE = `usage: node tools/analyse-sample.mjs <audio-or-video-file> [options]

  --from <t> --to <t>   analyse only this section  (12.5 or 1:20 or 1:02:03).
                        Repeat the pair to join several sections - a lap
                        recording is mostly not the car you want.
  --order <n>           firing events per rev; 2 = four-cylinder four-stroke,
                        3 = V6, 4 = V8/eight-cylinder   [2]
  --rpm-min/--rpm-max   search range for the RPM track  [800 10000]
  --bands <n>           how many rev bands to fit       [6]
  --json <path>         write the full report
  --profile <key>       also print a soundconfig-shaped block
  --track               print the RPM track
  --fit                 solve for the generator settings that make the synth
                        measure the same as the recording (slower; this is
                        what --profile needs to emit real numbers)
  --emit-wav <dir>      cut seamless loops (see sounds/README.md - keep local)
  --selftest            measure the app's own generated loops and check the
                        analyser recovers their known parameters

You supply the file. This never downloads anything.`;

function parseArgs(argv) {
  const o = { order: 2, rpmMin: 800, rpmMax: 10000, bands: 6, sr: 48000, file: null, segments: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--selftest') o.selftest = true;
    else if (a === '--from') o.segments.push([parseTime(next()), null]);
    else if (a === '--to') {
      const t = parseTime(next());
      if (!o.segments.length) o.segments.push([null, t]);
      else o.segments[o.segments.length - 1][1] = t;
    }
    else if (a === '--order') o.order = Number(next());
    else if (a === '--rpm-min') o.rpmMin = Number(next());
    else if (a === '--rpm-max') o.rpmMax = Number(next());
    else if (a === '--bands') o.bands = Number(next());
    else if (a === '--json') o.json = next();
    else if (a === '--emit-wav') o.emitWav = next();
    else if (a === '--profile') o.profile = next();
    else if (a === '--track') o.track = true;
    else if (a === '--fit') o.fit = true;
    else if (a.startsWith('-')) throw new Error('unknown option ' + a);
    else o.file = a;
  }
  return o;
}

function summary(rep) {
  const L = [];
  const row = (k, v) => L.push('  ' + k.padEnd(22) + v);
  L.push(`\n=== ${rep.input.seconds} s @ ${rep.input.sampleRate} Hz, firing order ${rep.input.order} ===\n`);
  L.push('RPM');
  row('range', `${rep.rpm.min} - ${rep.rpm.max}`);
  row('median', rep.rpm.median);
  row('limiter hint', `${rep.rpm.limiterHint}  (firing ${rep.rpm.firingHzAtMax} Hz)`);

  L.push('\nFrames by state');
  row('on throttle', rep.states.throttle);
  row('overrun', rep.states.overrun);
  row('steady', rep.states.steady);
  row('shift', rep.states.shift);

  L.push('\nUpshifts');
  row('detected', rep.shifts.count);
  row('median rpm at cut', rep.shifts.upshiftRpm ?? '-');
  row('median ratio step', rep.shifts.medianRatioStep ?? '-');
  if (rep.shifts.ratioSteps.length) row('all steps', rep.shifts.ratioSteps.join(' '));

  const fitRows = (name, f) => {
    if (!f) { L.push(`\n${name}: not enough frames`); return; }
    L.push(`\n${name}  (${f.frames} frames)`);
    row('harmonics', f.harmonics);
    row('tilt', f.tilt);
    row('half (crank order)', f.half);
    row('oddBias', f.oddBias);
    row('floor between harm.', f.floorDb + ' dB below h1');
    row('floor tilt', f.noiseTilt);
  };
  fitRows('On-throttle spectrum', rep.onThrottle);
  fitRows('Overrun spectrum', rep.overrun);

  L.push('\nRev bands (on throttle)');
  for (const b of rep.bands) {
    L.push('  ' + String(b.baseRpm).padStart(5) + ' rpm  ' + String(b.covered).padStart(4) + ' frames  '
      + (b.fit ? `harm ${String(b.fit.harmonics).padStart(2)}  tilt ${String(b.fit.tilt).padStart(6)}  half ${b.fit.half}`
        : '(too few)'));
  }

  L.push('\nFormants (fixed resonances the rev sweep uncovered)');
  if (!rep.formants.length) L.push('  none found');
  for (const f of rep.formants) {
    L.push(`  ${String(f.freq).padStart(5)} Hz   Q ${String(f.q).padStart(4)}   gain +${f.gain} dB`);
  }

  L.push('\nInduction');
  if (!rep.intake) L.push('  no resonant bulge found in the between-harmonic floor');
  else {
    L.push(`  centre ${rep.intake.centreHz} Hz at ${rep.rpm.median} rpm`);
    L.push(`  tracks rpm as ${rep.intake.freqBase} + ${rep.intake.freqPerRpm} x rpm`
      + '        <- intake.freq { base, rpm }');
    L.push(rep.intake.onOverOverrun
      ? `  x${rep.intake.onOverOverrun} louder on throttle than on overrun`
      : '  (no overrun frames to compare against)');
    L.push('  per rev band: ' + rep.intake.perBand.map((b) => `${b[0]}rpm/${b[1]}Hz`).join('  '));
  }

  L.push('\nNon-integer orders (straight-cut gear whine, one per gear)');
  if (!rep.whine.length) L.push('  none found');
  for (const w of rep.whine) L.push(`  order ${String(w.order).padStart(6)}   ${w.hits} hits`);

  return L.join('\n');
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }

  if (opts.selftest) {
    const spectral = selftest();
    console.log('\n' + '='.repeat(64));
    process.exit((spectral + runOnboardSelftest()) ? 1 : 0);
  }
  if (!opts.file) { console.log(USAGE); process.exit(0); }
  if (!existsSync(opts.file)) { console.error('no such file: ' + opts.file); process.exit(1); }

  process.stderr.write('decoding...\n');
  const samples = decodeSegments(opts.file, opts.sr, opts.segments);
  if (opts.segments.length > 1) {
    process.stderr.write('  ' + opts.segments.length + ' sections joined\n');
  }
  process.stderr.write(`  ${(samples.length / opts.sr).toFixed(1)} s\nanalysing...\n`);
  const rep = analyse(samples, opts.sr, opts);

  const track = rep._track;
  if (!opts.track) delete rep._track;
  console.log(summary(rep));

  if (opts.fit) {
    process.stderr.write('solving for generator settings (closed loop)...\n');
    // Fitting a band the car barely drove through just launches the solver at
    // a bad target; it walks into the clamp and reports that as an answer.
    const MIN_FRAMES = 100, MIN_HARMONICS = 4;
    const weak = rep.bands.filter((b) => b.fit
      && (b.covered < MIN_FRAMES || b.fit.harmonics < MIN_HARMONICS));
    for (const b of weak) {
      process.stderr.write(`  ${String(b.baseRpm).padStart(5)} rpm  skipped`
        + ` (${b.covered} frames, ${b.fit.harmonics} harmonics - too little to fit)\n`);
    }
    const targets = rep.bands.filter((b) => b.fit && weak.indexOf(b) < 0)
      .map((b) => [b, b.fit, b.baseRpm])
      .concat(rep.overrun ? [[null, rep.overrun, rep.rpm.median]] : []);
    for (const [band, fit, baseRpm] of targets) {
      const base = {
        type: 'engine', order: rep.input.order, baseRpm,
        duration: r2(0.7 + 0.7 * Math.min(1, baseRpm / 6000)),
        harmonics: fit.harmonics, tilt: fit.tilt, half: fit.half,
        noise: 0.3, noiseTilt: fit.noiseTilt, shimmer: 0.22, grit: 0.25,
        seed: 200 + Math.round(baseRpm / 100)
      };
      const solved = fitGenerator(
        { tilt: fit.tilt, half: fit.half, floorDb: fit.floorDb }, base, opts.sr);
      if (band) band.fitted = solved; else rep.overrunFitted = solved;
      process.stderr.write(`  ${String(baseRpm).padStart(5)} rpm  tilt ${solved.tilt}`
        + `  half ${solved.half}  noise ${solved.noise}`
        + (solved._noiseCapped
          ? '   <- capped; the floor in this recording is louder than an engine'
            + ' makes, so the rest of it is wind and road'
          : '') + '\n');
    }
  }

  if (opts.profile) {
    console.log('\n--- soundconfig fragment -------------------------------------\n');
    console.log(JSON.stringify(suggestProfile(rep, opts.profile), null, 2));
  }
  if (opts.track) {
    console.log('\n--- rpm track (t, rpm, state) --------------------------------\n');
    for (const r of track) console.log(r.join('\t'));
  }
  if (opts.emitWav) {
    rep._track = track;
    const w = emitLoops(samples, opts.sr, rep, opts.emitWav);
    delete rep._track;
    console.log('\nwrote ' + w.length + ' loop(s) to ' + opts.emitWav);
    for (const x of w) console.log('  ' + x.path + '  ' + x.samples + ' samples');
  }
  if (opts.json) {
    rep._track = track;
    writeFileSync(opts.json, JSON.stringify(rep, null, 2));
    console.log('\nfull report -> ' + opts.json);
  }
}

// Importable as a module (the calibration harness does); only self-executing
// when run straight from the command line.
if (process.argv[1] && /analyse-sample\.mjs$/.test(process.argv[1])) main();
