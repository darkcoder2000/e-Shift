/* audio.js - the Web Audio side.
 *
 * Every layer of a sound profile is one looping AudioBufferSourceNode that runs
 * for the whole session. We never start/stop them (that would click); we only
 * move their playbackRate with the RPM and cross-fade their gains against
 * throttle and RPM windows.
 *
 * Signal flow:
 *   layer[i] -> gain -> pan -\
 *   whine osc -> gain --------> bus -> formants -> drive -> rasp -> tone
 *   intake noise -> bp -> gain /                                      |
 *                                     master -> comp -> out <---------+
 *   clunk/pop one-shots -------------------------> comp
 *
 * Everything from `bus` to `tone` is rebuilt per profile, because the formant
 * count varies. The formants are deliberately *static*: a resonance baked into
 * a sample transposes with it (the "sped-up tape" artifact), whereas a real
 * exhaust or airbox resonance is fixed by geometry and stays put as the engine
 * revs. Keeping them in the graph is what makes high RPM sound like an engine
 * rather than a transposed loop.
 *
 * Two load signals drive the mix, not one. `loadCurve` keys on an *effective*
 * throttle (the pedal, or the rev-match blip during a downshift), while the
 * optional `overrunCurve` keys on `st.overrun` - non-zero only when the wheels
 * are driving a closed-throttle engine. That separation is what lets coasting
 * in gear sound different from free-revving down in neutral, which are the
 * same pedal position.
 */
(function (ES) {
  'use strict';

  var clamp = ES.clamp;
  var lerpCurve = ES.lerpCurve;

  // Soft-clip curve for the drive stage. Slope at the origin is D/tanh(D), so a
  // pre-gain of g plus a post-gain of 1/(SLOPE*g) leaves quiet signals at unity
  // while loud ones get progressively squashed and harmonically enriched.
  var SHAPER_D = 2.5;
  var SHAPER_SLOPE = SHAPER_D / Math.tanh(SHAPER_D);
  var shaperCurve = null;

  function getShaperCurve() {
    if (shaperCurve) return shaperCurve;
    var n = 2048;
    shaperCurve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      shaperCurve[i] = Math.tanh(x * SHAPER_D) / Math.tanh(SHAPER_D);
    }
    return shaperCurve;
  }

  function EngineAudio(ctx) {
    this.ctx = ctx;
    this.layers = [];
    this.profile = null;
    this.ready = false;
    this.notes = [];
    this._missing = [];
    this.onNote = null;   // main.js hooks this up to the notes panel

    this.bus = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 6000;
    this.tone.Q.value = 0.6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.15;

    // bus -> ...per-profile chain... -> tone, wired by _buildChain()
    this.chainNodes = [];
    this.drive = null;
    this.rasp = null;
    this.intake = null;
    this.bus.connect(this.tone);
    this.tone.connect(this.master);
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    // One-shots (shift clunk, overrun pops) sit after the master gain so the
    // shift dip does not swallow the very sound that marks the shift.
    this.oneShotBus = ctx.createGain();
    this.oneShotBus.gain.value = 0.8;
    this.oneShotBus.connect(this.comp);

    this._shiftDip = 1;
    this._volume = 0.8;
    this._lastPop = 0;
    this._lastT = null;
    this._popAccum = 0;
    this._popNext = 1;
  }

  EngineAudio.prototype.setVolume = function (v) {
    this._volume = clamp(v, 0, 1.5);
    var now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this._volume * this._shiftDip, now, 0.02);
    this.oneShotBus.gain.setTargetAtTime(this._volume, now, 0.02);
  };

  /* ---- per-profile bus chain: formants -> drive -> rasp ---- */
  EngineAudio.prototype._buildChain = function (p) {
    var ctx = this.ctx, i;

    this.bus.disconnect();
    for (i = 0; i < this.chainNodes.length; i++) this.chainNodes[i].disconnect();
    this.chainNodes = [];
    this.drive = null;
    this.rasp = null;

    var node = this.bus;
    var fs = p.formants || [];
    for (i = 0; i < fs.length; i++) {
      var b = ctx.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = clamp(fs[i].freq || 500, 20, ctx.sampleRate * 0.45);
      b.Q.value = fs[i].q || 1.4;
      b.gain.value = clamp(fs[i].gain || 0, -24, 24);
      node.connect(b);
      node = b;
      this.chainNodes.push(b);
    }

    if (p.drive && p.drive.amount > 0) {
      var pre = ctx.createGain();
      var ws = ctx.createWaveShaper();
      ws.curve = getShaperCurve();
      ws.oversample = '4x';
      var post = ctx.createGain();
      pre.gain.value = 1;
      post.gain.value = 1 / SHAPER_SLOPE;
      node.connect(pre); pre.connect(ws); ws.connect(post);
      node = post;
      this.chainNodes.push(pre, ws, post);
      this.drive = { pre: pre, post: post, cfg: p.drive };
    }

    if (p.rasp && p.rasp.maxGain) {
      var hs = ctx.createBiquadFilter();
      hs.type = 'highshelf';
      hs.frequency.value = clamp(p.rasp.freq || 2500, 200, ctx.sampleRate * 0.45);
      hs.gain.value = 0;
      node.connect(hs);
      node = hs;
      this.chainNodes.push(hs);
      this.rasp = { node: hs, cfg: p.rasp };
    }

    node.connect(this.tone);
  };

  EngineAudio.prototype._note = function (text) {
    this.notes.push(text);
    if (this.onNote) this.onNote(text);
  };

  /* ---- buffer sourcing: file first, generator as fallback ---- */
  EngineAudio.prototype._obtain = function (spec, basePath) {
    var self = this;
    // A generated loop reports the base RPM it actually landed on (the firing
    // frequency gets snapped onto the FFT grid), so we trust that over the
    // config value. `spec.baseRpm` describes the WAV in `spec.file`.
    var gen = function () {
      var made = ES.synth.make(self.ctx, spec.generate || spec);
      return { buffer: made.buffer, baseRpm: made.baseRpm, generated: true };
    };
    if (!spec.file) return Promise.resolve(gen());
    var url = (basePath || '') + spec.file;
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + url);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        return new Promise(function (res, rej) {
          self.ctx.decodeAudioData(ab, res, rej);
        });
      })
      .then(function (buf) {
        return {
          buffer: buf,
          baseRpm: spec.baseRpm || (spec.generate && spec.generate.baseRpm) || 1000,
          generated: false
        };
      })
      .catch(function () {
        self._missing.push(spec.file);   // summarised once, in load()
        return gen();
      });
  };

  EngineAudio.prototype.dispose = function () {
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      try { l.source.stop(); } catch (e) { /* already stopped */ }
      l.source.disconnect();
      l.gain.disconnect();
      if (l.pan) l.pan.disconnect();
    }
    this.layers = [];
    if (this.intake) {
      try { this.intake.source.stop(); } catch (e3) { /* noop */ }
      this.intake.source.disconnect();
      this.intake.filter.disconnect();
      this.intake.gain.disconnect();
      this.intake = null;
    }
    if (this.whine) {
      try { this.whine.osc.stop(); } catch (e2) { /* noop */ }
      this.whine.osc.disconnect();
      this.whine.filter.disconnect();
      this.whine.gain.disconnect();
      this.whine = null;
    }
    this.ready = false;
  };

  EngineAudio.prototype.load = function (profile, basePath) {
    var self = this;
    this.dispose();
    this.notes = [];
    this._missing = [];
    this.profile = profile;
    this._buildChain(profile);

    var jobs = (profile.layers || []).map(function (spec) {
      return self._obtain(spec, basePath).then(function (res) {
        return { spec: spec, res: res };
      });
    });
    jobs.push(this._obtain(profile.shift || { generate: { type: 'clunk' } }, basePath)
      .then(function (r) { self.shiftBuf = r.buffer; return null; }));
    jobs.push(this._obtain(profile.pop || { generate: { type: 'pop' } }, basePath)
      .then(function (r) { self.popBuf = r.buffer; return null; }));

    return Promise.all(jobs).then(function (items) {
      var ctx = self.ctx, now = ctx.currentTime;
      items.forEach(function (it) {
        if (!it) return;
        var src = ctx.createBufferSource();
        src.buffer = it.res.buffer;
        src.loop = true;
        src.loopStart = it.spec.loopStart || 0;
        src.loopEnd = it.spec.loopEnd || it.res.buffer.duration;
        var g = ctx.createGain();
        g.gain.value = 0;
        var node = g;
        var pan = null;
        if (ctx.createStereoPanner && it.spec.pan) {
          pan = ctx.createStereoPanner();
          pan.pan.value = clamp(it.spec.pan, -1, 1);
          g.connect(pan);
          node = pan;
        }
        src.connect(g);
        node.connect(self.bus);
        src.start(now + 0.02, (it.spec.startOffset || 0) % it.res.buffer.duration);
        self.layers.push({
          id: it.spec.id || 'layer',
          cfg: it.spec,
          source: src,
          gain: g,
          pan: pan,
          baseRpm: it.res.baseRpm || 1000,
          generated: it.res.generated,
          level: 0,
          rate: 1,
          warned: false
        });
      });

      var w = profile.whine;
      if (w && w.gain > 0) {
        var osc = self.ctx.createOscillator();
        osc.type = w.wave || 'sawtooth';
        var wg = self.ctx.createGain();
        wg.gain.value = 0;
        var wf = self.ctx.createBiquadFilter();
        wf.type = 'lowpass';
        wf.frequency.value = 4000;
        osc.connect(wf); wf.connect(wg); wg.connect(self.bus);
        osc.start();
        self.whine = { osc: osc, gain: wg, filter: wf, cfg: w };
      }

      // Intake / turbulence bed. Above roughly 5000 rpm a real engine is largely
      // broadband roar, which none of the pitched layers can produce.
      var ik = profile.intake;
      if (ik && ik.gain > 0) {
        var nb = ES.synth.makeNoiseLoop(self.ctx, ik.generate || {});
        var nsrc = self.ctx.createBufferSource();
        nsrc.buffer = nb.buffer;
        nsrc.loop = true;               // rate stays 1.0 - see makeNoiseLoop
        var bp = self.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = ik.q || 1.2;
        bp.frequency.value = 600;
        var ng = self.ctx.createGain();
        ng.gain.value = 0;
        nsrc.connect(bp); bp.connect(ng); ng.connect(self.bus);
        nsrc.start(self.ctx.currentTime + 0.02);
        self.intake = { source: nsrc, filter: bp, gain: ng, cfg: ik };
      }

      if (self._missing.length) {
        var dir = self._missing[0].replace(/[^/]*$/, '') || './';
        self._note(self._missing.length + ' of ' + (profile.layers || []).length
          + ' layers have no WAV yet - generated placeholders in use. Drop files into '
          + dir + ' to replace them one at a time.');
      }

      self.ready = true;
      return self.notes;
    });
  };

  /* ---- per-frame update ---- */
  EngineAudio.prototype.update = function (st) {
    if (!this.ready) return;
    var ctx = this.ctx, now = ctx.currentTime, i, l;
    var p = this.profile;
    var rr = p.playbackRateRange || [0.5, 2.2];
    var maxCents = p.maxDetuneCents || 35;
    var weights = [], sumSq = 0;
    var dt = clamp(now - (this._lastT == null ? now : this._lastT), 0, 0.1);
    this._lastT = now;

    // A rev-match happens with the driver's foot off, yet the engine is making
    // noise as though it were on throttle. Everything timbral keys off this
    // rather than the raw pedal - it is what makes a downshift audible as one.
    var thr = Math.max(st.throttle, st.blip || 0);
    var ovr = st.overrun || 0;

    for (i = 0; i < this.layers.length; i++) {
      l = this.layers[i];
      var raw = st.rpm / l.baseRpm;
      var rate = clamp(raw, rr[0], rr[1]);

      // Once the rate is clamped the layer is playing at the wrong pitch, and a
      // detuned engine layer beating against a correctly pitched one is the
      // ugliest thing this mixer can do. Fade on the actual detune, so anything
      // sour is silent well before it is audible.
      //
      // This is a safety net, not the crossfade: it collapses over ~2% of RPM,
      // so a layer's rpmCurve should already reach 0 before its rate limit. The
      // diagnostic below says so out loud when a profile gets that wrong.
      var cents = Math.abs(1200 * Math.log2(rate / raw));
      var fit = clamp(1 - cents / maxCents, 0, 1);

      var wBase = (l.cfg.gain == null ? 1 : l.cfg.gain)
        * lerpCurve(l.cfg.loadCurve, thr)
        * (l.cfg.overrunCurve ? lerpCurve(l.cfg.overrunCurve, ovr) : 1)
        * lerpCurve(l.cfg.rpmCurve, st.rpm);
      var w = Math.max(0, wBase * fit);
      weights.push(w);
      sumSq += w * w;

      if (fit < 0.999 && wBase > 0.2 && !l.warned) {
        l.warned = true;
        this._note('layer "' + l.id + '" is range-limited around '
          + Math.round(st.rpm) + ' rpm - tighten its rpmCurve or add a layer.');
      }

      l.rate = rate;
      l.source.playbackRate.setTargetAtTime(rate, now, l.cfg.glide == null ? 0.03 : l.cfg.glide);
    }

    var norm = sumSq > 1e-9 ? 1 / Math.sqrt(sumSq) : 0;
    var loud = lerpCurve(p.loudnessCurve, st.rpm) * lerpCurve(p.throttleLoudnessCurve, thr);
    if (p.overrunLoudnessCurve) loud *= lerpCurve(p.overrunLoudnessCurve, ovr);
    var overall = loud * st.limiterGate;

    for (i = 0; i < this.layers.length; i++) {
      l = this.layers[i];
      var g = weights[i] * norm * overall;
      l.level = g;
      l.gain.gain.setTargetAtTime(g, now, 0.02);
    }

    // Airbox / muffler: opens up with load and revs. The `overrun` term keeps
    // it open off throttle too - a closed throttle at 5000 rpm in gear is hard
    // and hollow, not muffled, and without this the whole graph collapses to
    // its floors the instant you lift.
    var toneCfg = p.tone || {};
    var fc = clamp((toneCfg.base || 700) + thr * (toneCfg.throttle || 6500)
      + ovr * (toneCfg.overrun || 0) + st.rpm * (toneCfg.rpm || 0.45),
      300, ctx.sampleRate * 0.45);
    this.tone.frequency.setTargetAtTime(fc, now, 0.05);

    // Load-dependent grit. Quiet passages stay clean; under load the pre-gain
    // pushes harder into the soft clipper and the engine gains rasp.
    if (this.drive) {
      var dc = this.drive.cfg;
      var dAmt = dc.amount * lerpCurve(dc.rpmCurve, st.rpm) * lerpCurve(dc.loadCurve, thr);
      if (dc.overrunCurve) dAmt *= lerpCurve(dc.overrunCurve, ovr);
      var pre = 1 + clamp(dAmt, 0, 1) * 5;
      this.drive.pre.gain.setTargetAtTime(pre, now, 0.05);
      this.drive.post.gain.setTargetAtTime(1 / (SHAPER_SLOPE * pre), now, 0.05);
    }

    if (this.rasp) {
      var rc = this.rasp.cfg;
      var rg = rc.maxGain * lerpCurve(rc.rpmCurve, st.rpm) * lerpCurve(rc.loadCurve, thr);
      if (rc.overrunCurve) rg *= lerpCurve(rc.overrunCurve, ovr);
      this.rasp.node.gain.setTargetAtTime(clamp(rg, -24, 24), now, 0.05);
    }

    if (this.intake) {
      var ic = this.intake.cfg;
      var icf = ic.freq || {};
      var nf = clamp((icf.base || 400) + st.rpm * (icf.rpm || 0.3), 80, ctx.sampleRate * 0.45);
      this.intake.filter.frequency.setTargetAtTime(nf, now, 0.05);
      var ig = ic.gain * lerpCurve(ic.rpmCurve, st.rpm) * lerpCurve(ic.loadCurve, thr);
      if (ic.overrunCurve) ig *= lerpCurve(ic.overrunCurve, ovr);
      ig *= overall;
      this.intake.gain.gain.setTargetAtTime(ig, now, 0.04);
      this.intake.level = ig;
    }

    if (this.whine) {
      var w2 = this.whine.cfg;
      var f = clamp((st.rpm / 60) * (w2.order || 12), 20, ctx.sampleRate * 0.45);
      this.whine.osc.frequency.setTargetAtTime(f, now, 0.02);
      this.whine.filter.frequency.setTargetAtTime(clamp(f * 3.5, 200, 16000), now, 0.05);
      var wg = w2.gain * lerpCurve(w2.loadCurve, thr) * lerpCurve(w2.rpmCurve, st.rpm);
      if (w2.overrunCurve) wg *= lerpCurve(w2.overrunCurve, ovr);
      this.whine.gain.gain.setTargetAtTime(wg * overall, now, 0.03);
    }

    // Continuous overrun crackle. A decelerating engine cracks and pops the
    // whole way down, not once at the lift - the old code fired a single burst
    // per lift and then went silent for the rest of the stop.
    var pc = p.pop;
    if (pc && pc.enabled !== false && pc.rateMax) {
      var pRate = pc.rateMax * lerpCurve(pc.rpmCurve, st.rpm) * lerpCurve(pc.overrunCurve, ovr);
      this._popAccum += pRate * dt;
      if (this._popAccum >= this._popNext) {
        this._popAccum = 0;
        this._popNext = 0.45 + Math.random() * 1.1;   // Poisson-ish spacing
        this._pop(now + 0.005 + Math.random() * 0.03,
          (pc.gain == null ? 0.5 : pc.gain) * (0.25 + Math.random() * 0.6),
          0.7 + Math.random() * 0.8,
          this._popCentre(pc, st.rpm));
      }
    }

    var dip = st.shifting ? (p.shiftDip == null ? 0.35 : p.shiftDip) : 1;
    if (dip !== this._shiftDip) {
      this._shiftDip = dip;
      this.master.gain.setTargetAtTime(this._volume * dip, now, st.shifting ? 0.01 : 0.05);
    }
  };

  EngineAudio.prototype._oneShot = function (buf, gain, rate) {
    if (!buf) return;
    var src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate || 1;
    var g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.oneShotBus);
    src.start();
    src.onended = function () { src.disconnect(); g.disconnect(); };
  };

  EngineAudio.prototype.playShift = function (info) {
    var p = this.profile || {};
    var base = (p.shift && p.shift.gain) || 0.8;
    this._oneShot(this.shiftBuf, base * (0.5 + 0.5 * (info.intensity || 1)),
      0.9 + Math.random() * 0.2 + (info.dir < 0 ? 0.12 : 0));
    // Coasting downshift: the exhaust cracks as the clutch bites.
    if (info.dir < 0 && (info.overrun || 0) > 0.25) {
      this.popBurst(0.5 + 0.5 * info.overrun, info.rpmAfter);
    }
  };

  /* ---- overrun crackle ----
   * Scheduled on the audio clock rather than with setTimeout: a pop is a 90 ms
   * transient, and setTimeout jitter is a large fraction of that. Each event
   * gets its own bandpass so the crackle sits in the exhaust band and follows
   * the revs instead of being the same white tick every time.
   */
  EngineAudio.prototype._popCentre = function (pc, rpm) {
    return ((pc.freq || 1100) + (rpm || 3000) * (pc.freqRpm || 0.12))
      * (0.7 + Math.random() * 0.6);
  };

  EngineAudio.prototype._pop = function (when, gain, rate, centre) {
    if (!this.popBuf) return;
    var src = this.ctx.createBufferSource();
    src.buffer = this.popBuf;
    src.playbackRate.value = rate;
    var bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clamp(centre, 80, this.ctx.sampleRate * 0.45);
    bp.Q.value = 0.9;
    var g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(bp); bp.connect(g); g.connect(this.oneShotBus);
    src.start(when);
    src.onended = function () { src.disconnect(); bp.disconnect(); g.disconnect(); };
  };

  /** Dense burst - the transient that marks a lift or a coasting downshift. */
  EngineAudio.prototype.popBurst = function (intensity, rpm) {
    var p = this.profile || {};
    var pc = p.pop;
    if (!pc || pc.enabled === false) return;
    var now = this.ctx.currentTime;
    if (now - this._lastPop < 0.12) return;
    this._lastPop = now;
    intensity = clamp(intensity == null ? 1 : intensity, 0.2, 1);
    var base = pc.gain == null ? 0.5 : pc.gain;
    var n = Math.max(2, Math.round((pc.burstCount || 6) * intensity));
    var when = now + 0.01;
    for (var i = 0; i < n; i++) {
      this._pop(when, base * intensity * (0.4 + Math.random() * 0.6),
        0.7 + Math.random() * 0.8, this._popCentre(pc, rpm));
      when += 0.02 + Math.random() * 0.07;
    }
  };

  ES.EngineAudio = EngineAudio;
})(window.ES = window.ES || {});
