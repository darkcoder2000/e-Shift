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
   *   shimmer            - cycle-to-cycle wander (see below)
   *   formant, formantQ, formantGain - a resonant "body" peak. Prefer the
   *                        profile-level `formants` chain in audio.js: a baked
   *                        resonance transposes with the sample, a filtered one
   *                        stays where the pipe geometry put it.
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

    // How finely the sub-comb below the firing harmonics is filled in, as a
    // divisor of the firing frequency. 2 is the crank order and was the only
    // option; a V8 needs more. Measured on a Bentley GT3, that engine has
    // content at every HALF engine order, which at firing order 4 is f0/8,
    // and the orders in between are within a few dB of the firing harmonics
    // themselves - so a comb at f0/2 leaves out three quarters of what makes
    // a V8 sound like one.
    var sub = Math.max(2, Math.round(spec.sub || 2));

    // Snap the firing frequency onto the bin grid. A bin index that is a
    // multiple of `sub` keeps the sub-comb on the grid as well, which is what
    // keeps the loop seamless.
    var kFire = Math.max(sub, Math.round(wantFire / f0));
    if (kFire % sub) kFire += sub - (kFire % sub);
    var kHalf = kFire / sub;
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
    var shimmer = spec.shimmer == null ? 0.18 : spec.shimmer;
    var partials = [];
    var h, k, f, a, ph, r, im2, x, d, side, depth;

    for (h = 1; h <= nHarm; h++) {
      k = h * kFire;
      if (k > maxK) break;
      a = Math.pow(h, tilt) * (h % 2 === 0 ? oddBias : 1);
      mag[k] += a;
      partials.push(k, a, h);
    }
    if (halfAmt > 0) {
      for (h = 1; h <= nHarm * sub; h++) {
        k = h * kHalf;
        if (k > maxK) break;
        if (k % kFire === 0) continue; // already covered by the firing harmonics
        // max(0.5, ...) stops the envelope climbing below half the firing
        // frequency. Extrapolating h^tilt that far down predicts a partial at
        // an eighth of f0 some 20 dB louder than the recording has it. At
        // sub=2 nothing sits below 0.5, so this is a no-op and the three
        // profiles that shipped before it are bit-identical.
        a = halfAmt * Math.pow(Math.max(0.5, h / sub), tilt - 0.15);
        mag[k] += a;
        partials.push(k, a, h / sub);
      }
    }

    // Cycle-to-cycle wander. Sidebands one and two bins either side of each
    // partial beat against it at f0 (~1.5 Hz) and 2*f0, so the harmonic's level
    // and phase drift over the buffer instead of repeating identically. They sit
    // on the bin grid like everything else, so the loop stays seamless - this is
    // what stops a looping engine note sounding frozen once it is pitched up.
    if (shimmer > 0) {
      for (var pi = 0; pi < partials.length; pi += 3) {
        k = partials[pi];
        a = partials[pi + 1];
        // upper harmonics wander most: combustion variation hits the top end
        depth = shimmer * Math.min(1.4, 0.4 + 0.2 * partials[pi + 2]);
        for (d = 1; d <= 2; d++) {
          side = a * depth * (d === 1 ? 0.7 : 0.35) * (0.5 + rnd());
          if (k - d >= 1) mag[k - d] += side;
          if (k + d <= maxK) mag[k + d] += side;
        }
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

  /**
   * Seamless noise loop for the intake / turbulence bed. Built the same way as
   * the engine loops - random phase on every bin - so it joins cleanly.
   *
   * Keep this long (a couple of seconds) and play it at rate 1.0: the whole
   * point of the bed is that it does NOT transpose, so its repeat never becomes
   * audible the way a pitched-up engine loop's does. RPM tracking belongs in
   * the filter that follows it, not in the playback rate.
   */
  function makeNoiseLoop(ctx, spec) {
    spec = spec || {};
    var sr = ctx.sampleRate;
    var n = 1 << Math.max(12, Math.ceil(Math.log2((spec.duration || 2.2) * sr)));
    var f0 = sr / n;
    var maxHz = Math.min(sr * 0.45, spec.maxFreq || 16000);
    var maxK = Math.min(n / 2 - 1, Math.floor(maxHz / f0));
    var rnd = mulberry32(spec.seed == null ? 4242 : spec.seed);
    var tilt = spec.tilt == null ? -0.35 : spec.tilt;
    var re = new Float64Array(n), im = new Float64Array(n);
    var k, f, a, ph, r, i2;

    for (k = 1; k <= maxK; k++) {
      f = Math.max(k * f0, 20);
      a = Math.pow(f / 500, tilt) * (0.5 + rnd());
      ph = rnd() * Math.PI * 2;
      r = a * Math.cos(ph); i2 = a * Math.sin(ph);
      re[k] = r; im[k] = i2;
      re[n - k] = r; im[n - k] = -i2;
    }
    fft(re, im, true);

    var buffer = ctx.createBuffer(1, n, sr);
    var out = buffer.getChannelData(0);
    for (k = 0; k < n; k++) out[k] = re[k];
    normalize(out, spec.peak == null ? 0.9 : spec.peak);
    return { buffer: buffer, baseRpm: 0 };
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
        case 'noise': return makeNoiseLoop(ctx, spec);
        default: return makeEngineLoop(ctx, spec);
      }
    },
    makeEngineLoop: makeEngineLoop,
    makeNoiseLoop: makeNoiseLoop,
    makeClunk: makeClunk,
    makePop: makePop
  };
})(window.ES = window.ES || {});
