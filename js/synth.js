/* synth.js - procedural placeholder sound generation.
 *
 * Phase 1 needs engine loops that are *perfectly* seamless. Instead of shipping
 * WAV files we build them in the frequency domain: every partial sits exactly on
 * the FFT bin grid of the buffer, so the last sample joins the first one without
 * a click, by construction.
 *
 * Because the buffer length is a power of two the firing frequency gets snapped
 * to the nearest bin. The generator therefore reports back the *actual* base RPM
 * of the buffer it produced - the audio engine uses that for playbackRate.
 */
(function (ES) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---- in-place iterative radix-2 FFT (n must be a power of two) ---- */
  function fft(re, im, inverse) {
    var n = re.length, i, j, bit, t, len, ang, wr, wi, k, cr, ci, ur, ui, vr, vi, nr;
    for (i = 1, j = 0; i < n; i++) {
      for (bit = n >> 1; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (len = 2; len <= n; len <<= 1) {
      ang = (inverse ? 2 : -2) * Math.PI / len;
      wr = Math.cos(ang); wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        cr = 1; ci = 0;
        for (k = 0; k < len / 2; k++) {
          ur = re[i + k]; ui = im[i + k];
          vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  function normalize(data, peak) {
    var max = 0, i, g;
    for (i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
    if (max < 1e-9) return;
    g = peak / max;
    for (i = 0; i < data.length; i++) data[i] *= g;
  }

  /**
   * Build a seamlessly looping engine tone.
   *
   * spec:
   *   cylinders / order  - firing order (order = cylinders / 2 on a 4-stroke)
   *   baseRpm            - RPM the loop represents (requested; actual is returned)
   *   duration           - target length in seconds (rounded up to a power of two)
   *   harmonics          - number of firing harmonics
   *   tilt               - spectral slope exponent (more negative = darker)
   *   half               - amount of half-order content (lumpy / burbly character)
   *   oddBias            - relative level of even harmonics (1 = neutral)
   *   noise, noiseTilt   - broadband intake / exhaust hiss
   *   formant, formantQ, formantGain - a resonant "body" peak
   *   grit               - tanh saturation amount
   *   seed               - deterministic RNG seed
   *
   * returns { buffer, baseRpm }
   */
  function makeEngineLoop(ctx, spec) {
    var sr = ctx.sampleRate;
    var order = spec.order || (spec.cylinders ? spec.cylinders / 2 : 2);
    var wantRpm = spec.baseRpm || 1000;
    var wantFire = (wantRpm / 60) * order;

    var n = 1 << Math.max(12, Math.ceil(Math.log2((spec.duration || 0.6) * sr)));
    var f0 = sr / n;

    // Snap the firing frequency onto the bin grid. An even bin index keeps the
    // half-order (crank rotation) partials on the grid as well.
    var kFire = Math.max(2, Math.round(wantFire / f0));
    if (kFire % 2) kFire++;
    var kHalf = kFire / 2;
    var actualRpm = (kFire * f0 * 60) / order;

    var half = n / 2;
    // Cap the bandwidth well below Nyquist: these loops get played back at up to
    // ~2x, and anything above sr/2 after that speed-up folds back as aliasing.
    var maxHz = Math.min(sr * 0.45, spec.maxFreq || 12000);
    var maxK = Math.min(half - 1, Math.floor(maxHz / f0));
    var mag = new Float64Array(half);

    var rnd = mulberry32(spec.seed == null ? 1234 : spec.seed);
    var tilt = spec.tilt == null ? -1.2 : spec.tilt;
    var nHarm = spec.harmonics || 22;
    var halfAmt = spec.half == null ? 0.45 : spec.half;
    var oddBias = spec.oddBias == null ? 1 : spec.oddBias;
    var noiseAmt = spec.noise == null ? 0.2 : spec.noise;
    var noiseTilt = spec.noiseTilt == null ? -0.9 : spec.noiseTilt;
    var h, k, f, a, ph, r, im2, x;

    for (h = 1; h <= nHarm; h++) {
      k = h * kFire;
      if (k > maxK) break;
      mag[k] += Math.pow(h, tilt) * (h % 2 === 0 ? oddBias : 1);
    }
    if (halfAmt > 0) {
      for (h = 1; h <= nHarm * 2; h++) {
        k = h * kHalf;
        if (k > maxK) break;
        if (k % kFire === 0) continue; // already covered by the firing harmonics
        mag[k] += halfAmt * Math.pow(h / 2, tilt - 0.15);
      }
    }
    if (noiseAmt > 0) {
      for (k = 1; k <= maxK; k++) {
        f = Math.max(k * f0, 30);
        mag[k] += noiseAmt * rnd() * 0.06 * Math.pow(f / 250, noiseTilt);
      }
    }
    if (spec.formant) {
      var fc = spec.formant;
      var q = spec.formantQ || 1.6;
      var fg = spec.formantGain || 2.2;
      for (k = 1; k <= maxK; k++) {
        x = (k * f0) / fc;
        mag[k] *= 1 + (fg - 1) / (1 + Math.pow(q * (x - 1 / x) * 2, 2));
      }
    }

    var re = new Float64Array(n), im = new Float64Array(n);
    for (k = 1; k <= maxK; k++) {
      a = mag[k];
      if (a < 1e-6) continue;
      ph = rnd() * Math.PI * 2;
      r = a * Math.cos(ph); im2 = a * Math.sin(ph);
      re[k] = r; im[k] = im2;
      re[n - k] = r; im[n - k] = -im2; // Hermitian symmetry -> real output
    }
    fft(re, im, true);

    var buffer = ctx.createBuffer(1, n, sr);
    var out = buffer.getChannelData(0);
    for (k = 0; k < n; k++) out[k] = re[k];
    normalize(out, 1);

    var grit = spec.grit || 0;
    if (grit > 0) {
      var kk = 1 + grit * 6, norm = Math.tanh(kk);
      for (k = 0; k < n; k++) out[k] = Math.tanh(out[k] * kk) / norm;
      // saturating an asymmetric waveform introduces DC; a constant offset is
      // still seamless but it eats headroom, so take it back out
      var mean = 0;
      for (k = 0; k < n; k++) mean += out[k];
      mean /= n;
      for (k = 0; k < n; k++) out[k] -= mean;
    }
    normalize(out, spec.peak == null ? 0.9 : spec.peak);

    return { buffer: buffer, baseRpm: actualRpm };
  }

  /** Short percussive "clunk" for gear changes. Not looped, so no seam rules. */
  function makeClunk(ctx, spec) {
    spec = spec || {};
    var sr = ctx.sampleRate;
    var n = Math.floor(sr * (spec.duration || 0.16));
    var buffer = ctx.createBuffer(1, n, sr);
    var out = buffer.getChannelData(0);
    var rnd = mulberry32(spec.seed == null ? 99 : spec.seed);
    var thumpF = spec.thump || 95;
    var noiseAmt = spec.noise == null ? 0.55 : spec.noise;
    var tone = spec.tone == null ? 0.45 : spec.tone;
    var decay = spec.decay || 34;
    var lp = 0, i, t, e, thump, raw;
    for (i = 0; i < n; i++) {
      t = i / sr;
      e = Math.exp(-t * decay);
      thump = Math.sin(2 * Math.PI * thumpF * t * Math.exp(-t * 6)) * Math.exp(-t * 18);
      raw = rnd() * 2 - 1;
      lp += (raw - lp) * tone;
      out[i] = (thump * 0.9 + lp * noiseAmt) * e;
    }
    normalize(out, spec.peak == null ? 0.95 : spec.peak);
    return { buffer: buffer, baseRpm: 0 };
  }

  /** Overrun crackle / exhaust pop. */
  function makePop(ctx, spec) {
    spec = spec || {};
    var sr = ctx.sampleRate;
    var n = Math.floor(sr * (spec.duration || 0.09));
    var buffer = ctx.createBuffer(1, n, sr);
    var out = buffer.getChannelData(0);
    var rnd = mulberry32(spec.seed == null ? 7 : spec.seed);
    var decay = spec.decay || 55;
    var hp = 0, prev = 0, i, raw;
    for (i = 0; i < n; i++) {
      raw = rnd() * 2 - 1;
      hp = 0.85 * (hp + raw - prev);
      prev = raw;
      out[i] = hp * Math.exp(-(i / sr) * decay);
    }
    normalize(out, spec.peak == null ? 0.9 : spec.peak);
    return { buffer: buffer, baseRpm: 0 };
  }

  ES.synth = {
    make: function (ctx, spec) {
      switch ((spec && spec.type) || 'engine') {
        case 'clunk': return makeClunk(ctx, spec);
        case 'pop': return makePop(ctx, spec);
        default: return makeEngineLoop(ctx, spec);
      }
    },
    makeEngineLoop: makeEngineLoop,
    makeClunk: makeClunk,
    makePop: makePop
  };
})(window.ES = window.ES || {});
