/* audio.js - the Web Audio side.
 *
 * Every layer of a sound profile is one looping AudioBufferSourceNode that runs
 * for the whole session. We never start/stop them (that would click); we only
 * move their playbackRate with the RPM and cross-fade their gains against
 * throttle and RPM windows.
 *
 * Signal flow:
 *   layer[i] -> gain -> pan -\
 *   whine osc -> gain -------> bus -> tone (lowpass) -> master -> comp -> out
 *   clunk/pop one-shots ----/
 */
(function (ES) {
  'use strict';

  var clamp = ES.clamp;
  var lerpCurve = ES.lerpCurve;

  function EngineAudio(ctx) {
    this.ctx = ctx;
    this.layers = [];
    this.profile = null;
    this.ready = false;
    this.notes = [];

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
  }

  EngineAudio.prototype.setVolume = function (v) {
    this._volume = clamp(v, 0, 1.5);
    var now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this._volume * this._shiftDip, now, 0.02);
    this.oneShotBus.gain.setTargetAtTime(this._volume, now, 0.02);
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
        self.notes.push('"' + spec.file + '" not found - using the generated placeholder.');
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
    this.profile = profile;

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
          level: 0
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
    var weights = [], sumSq = 0;

    for (i = 0; i < this.layers.length; i++) {
      l = this.layers[i];
      var raw = st.rpm / l.baseRpm;
      var rate = clamp(raw, rr[0], rr[1]);
      // Fade a layer out rather than letting it sit at a wrong, clamped pitch.
      var fit = 1;
      if (raw > rr[1]) fit = clamp(1 - (raw / rr[1] - 1) / 0.3, 0, 1);
      else if (raw < rr[0]) fit = clamp(1 - (rr[0] / raw - 1) / 0.3, 0, 1);

      var w = (l.cfg.gain == null ? 1 : l.cfg.gain) * fit;
      w *= lerpCurve(l.cfg.loadCurve, st.throttle);
      w *= lerpCurve(l.cfg.rpmCurve, st.rpm);
      w = Math.max(0, w);
      weights.push(w);
      sumSq += w * w;

      l.source.playbackRate.setTargetAtTime(rate, now, l.cfg.glide == null ? 0.03 : l.cfg.glide);
    }

    var norm = sumSq > 1e-9 ? 1 / Math.sqrt(sumSq) : 0;
    var loud = lerpCurve(p.loudnessCurve, st.rpm) * lerpCurve(p.throttleLoudnessCurve, st.throttle);
    var overall = loud * st.limiterGate;

    for (i = 0; i < this.layers.length; i++) {
      l = this.layers[i];
      var g = weights[i] * norm * overall;
      l.level = g;
      l.gain.gain.setTargetAtTime(g, now, 0.02);
    }

    // airbox / muffler: opens up with load and revs
    var toneCfg = p.tone || {};
    var fc = clamp((toneCfg.base || 700) + st.throttle * (toneCfg.throttle || 6500) + st.rpm * (toneCfg.rpm || 0.45),
      300, ctx.sampleRate * 0.45);
    this.tone.frequency.setTargetAtTime(fc, now, 0.05);

    if (this.whine) {
      var w2 = this.whine.cfg;
      var f = clamp((st.rpm / 60) * (w2.order || 12), 20, ctx.sampleRate * 0.45);
      this.whine.osc.frequency.setTargetAtTime(f, now, 0.02);
      this.whine.filter.frequency.setTargetAtTime(clamp(f * 3.5, 200, 16000), now, 0.05);
      var wg = w2.gain * lerpCurve(w2.loadCurve, st.throttle) * lerpCurve(w2.rpmCurve, st.rpm) * overall;
      this.whine.gain.gain.setTargetAtTime(wg, now, 0.03);
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
  };

  EngineAudio.prototype.playPop = function (info) {
    var p = this.profile || {};
    if (!p.pop || p.pop.enabled === false) return;
    var now = this.ctx.currentTime;
    if (now - this._lastPop < 0.35) return;
    this._lastPop = now;
    var self = this;
    var n = 2 + Math.floor(Math.random() * 4);
    for (var i = 0; i < n; i++) {
      (function (delay) {
        setTimeout(function () {
          self._oneShot(self.popBuf, ((p.pop.gain == null ? 0.5 : p.pop.gain)) * (0.4 + Math.random() * 0.6),
            0.8 + Math.random() * 0.6);
        }, delay);
      })(i * (40 + Math.random() * 90));
    }
  };

  ES.EngineAudio = EngineAudio;
})(window.ES = window.ES || {});
