/* engine.js - the virtual drivetrain.
 *
 * Pure state machine, no DOM and no audio. Speed is the integrated state and
 * RPM is derived from it through the current gear ratio:
 *
 *     rpm = speed_kmh * gearRatio * finalDrive
 *
 * That single relation buys us the correct shift behaviour for free: changing
 * gear at a given road speed lands the engine exactly on
 * rpm * ratio_new / ratio_old, i.e. the familiar RPM drop, without any special
 * casing. Below idle a slipping-clutch model takes over so the car can pull
 * away from standstill.
 *
 * While the clutch is open for a shift the engine is rev-matched onto the RPM
 * it will land on, so a downshift blips up instead of sagging toward idle and
 * then jumping when the clutch bites.
 *
 * Alongside `throttle` (a pedal position) the state carries `load`, `overrun`
 * and `blip`, which describe what the engine is actually doing. The audio side
 * needs the difference: coasting in gear at 5000 rpm and free-revving down
 * through 5000 rpm in neutral are the same pedal and completely different
 * noises.
 *
 * None of this pretends to be real physics - it is tuned for feel.
 */
(function (ES) {
  'use strict';

  var DEFAULTS = {
    idleRpm: 850,
    maxRpm: 7600,          // hard rev limiter
    redlineRpm: 6900,      // where the dial turns red
    shiftUpRpm: 6500,
    shiftDownRpm: 2400,
    shiftDownBrakingRpm: 3900,  // downshift point under full brake
    shiftTime: 0.22,       // seconds of open clutch
    overrunRefRpm: 3000,   // rpm by which engine braking counts as "full"
    gearRatios: [3.45, 2.20, 1.55, 1.18, 0.95, 0.78, 0.65, 0.55],
    finalDrive: 41,        // rpm per (km/h * ratio)
    enginePower: 11.5,     // km/h per second, per unit of gear ratio, at peak torque
    engineBrake: 1.7,
    brakePower: 30,
    dragC: 7e-5,           // aero drag, quadratic in km/h
    rollC: 0.35,
    launchRpm: 3300,       // RPM the slipping clutch holds at full throttle
    freeRevUp: 9000,       // rpm/s in neutral
    freeRevDown: 6500,
    throttleRise: 7.0,     // pedal smoothing, 1/s
    throttleFall: 10.0,
    torqueCurve: [[0, 0.55], [1500, 0.82], [2600, 0.97], [4200, 1.0], [5600, 0.95], [6800, 0.82], [7600, 0.5]]
  };

  function lerpCurve(curve, x) {
    if (!curve || !curve.length) return 1;
    if (x <= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (x <= curve[i][0]) {
        var a = curve[i - 1], b = curve[i];
        var span = b[0] - a[0];
        var t = span <= 0 ? 0 : (x - a[0]) / span;
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return curve[curve.length - 1][1];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function Engine(cfg) {
    this.cfg = {};
    this.configure(cfg);

    this.throttleInput = 0;
    this.brakeInput = 0;
    this.throttle = 0;
    this.brake = 0;

    this.gear = 1;              // 0 = neutral
    this.rpm = this.cfg.idleRpm;
    this.speed = 0;             // km/h
    this.auto = true;

    this.shiftTimer = 0;
    this.shiftDir = 0;
    this.limiter = false;
    this.clutchSlip = true;
    this.distance = 0;          // km, cosmetic

    // Load signals the audio side needs. `throttle` is a pedal position; these
    // describe what the engine is actually doing, which is a different thing
    // whenever the wheels are driving the engine rather than the other way up.
    this.blip = 0;              // 0..1, rev-match during a downshift
    this.overrun = 0;           // 0..1, closed throttle with the clutch locked
    this.load = 0;              // -1 (full engine braking) .. +1 (full drive)

    this._limiterPhase = 0;
    this._listeners = {};
    this._shiftLock = 0;
    this._shiftFrom = this.rpm;
    this._overrunHold = 0;
  }

  Engine.prototype.configure = function (cfg) {
    var k;
    for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) this.cfg[k] = DEFAULTS[k];
    if (cfg) for (k in cfg) if (cfg.hasOwnProperty(k) && cfg[k] != null) this.cfg[k] = cfg[k];
    this.gearCount = this.cfg.gearRatios.length;
    if (this.gear > this.gearCount) this.gear = this.gearCount;
    return this;
  };

  Engine.prototype.on = function (evt, fn) {
    (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
    return this;
  };

  Engine.prototype._emit = function (evt, data) {
    var l = this._listeners[evt];
    if (!l) return;
    for (var i = 0; i < l.length; i++) l[i](data);
  };

  Engine.prototype.ratio = function (gear) {
    var g = gear == null ? this.gear : gear;
    return g === 0 ? 0 : this.cfg.gearRatios[g - 1];
  };

  Engine.prototype.torqueAt = function (rpm) {
    return clamp(lerpCurve(this.cfg.torqueCurve, rpm), 0, 1.5);
  };

  /* ---- driver inputs ---- */
  Engine.prototype.setThrottle = function (v) { this.throttleInput = clamp(v, 0, 1); };
  Engine.prototype.setBrake = function (v) { this.brakeInput = clamp(v, 0, 1); };
  Engine.prototype.setAuto = function (on) { this.auto = !!on; if (on && this.gear === 0) this.selectGear(1); };

  Engine.prototype.selectGear = function (g, silent) {
    g = clamp(Math.round(g), 0, this.gearCount);
    if (g === this.gear) return false;
    var dir = g > this.gear ? 1 : -1;
    var before = this.rpm;
    this.gear = g;
    this.shiftTimer = this.cfg.shiftTime;
    this.shiftDir = dir;
    this._shiftLock = 0.25;
    this._shiftFrom = before;   // where the rev-match glide starts
    var after = g === 0 ? this.cfg.idleRpm : Math.max(this.cfg.idleRpm, this.speed * this.ratio() * this.cfg.finalDrive);
    if (!silent) {
      this._emit('shift', {
        dir: dir, gear: g, rpmBefore: before, rpmAfter: after, overrun: this.overrun,
        intensity: clamp(Math.abs(before - after) / 2500, 0.25, 1) * (0.55 + 0.45 * this.throttle)
      });
    }
    return true;
  };

  Engine.prototype.shiftUp = function () {
    if (this.gear < this.gearCount) return this.selectGear(this.gear + 1);
    return false;
  };
  Engine.prototype.shiftDown = function () {
    if (this.gear > 0) return this.selectGear(this.gear - 1);
    return false;
  };
  Engine.prototype.toNeutral = function () { return this.selectGear(0); };

  Engine.prototype.reset = function () {
    this.speed = 0;
    this.rpm = this.cfg.idleRpm;
    this.gear = 1;
    this.distance = 0;
    this.shiftTimer = 0;
    this.limiter = false;
    this.blip = 0;
    this.overrun = 0;
    this.load = 0;
    this._shiftFrom = this.rpm;
    this._overrunHold = 0;
  };

  /* ---- simulation step ---- */
  Engine.prototype.update = function (dt) {
    dt = clamp(dt, 0, 0.1);
    var c = this.cfg;

    // pedal smoothing (an analog input can simply drive throttleInput directly)
    var rate = this.throttleInput > this.throttle ? c.throttleRise : c.throttleFall;
    this.throttle += (this.throttleInput - this.throttle) * (1 - Math.exp(-rate * dt));
    this.brake += (this.brakeInput - this.brake) * (1 - Math.exp(-14 * dt));

    var wasThrottle = this.throttle;
    var shifting = this.shiftTimer > 0;
    if (shifting) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this._shiftLock > 0) this._shiftLock = Math.max(0, this._shiftLock - dt);

    var ratio = this.ratio();
    var lockedRpm = this.gear === 0 ? 0 : this.speed * ratio * c.finalDrive;
    var driveScale = 1;
    var landing = 0, prog = 0;

    if (shifting && this.gear !== 0) {
      // Clutch open during a gear change, and the engine is rev-matched: it
      // glides onto the RPM the clutch will actually close at, so a downshift
      // blips *up* and an upshift falls to exactly the right place.
      //
      // Interpolating on the shift's progress rather than chasing at a fixed
      // rate is what guarantees arrival. A rate limit cannot: dropping 2300 rpm
      // in 0.2 s needs 11500 rpm/s, and whatever the chase fails to cover shows
      // up as a step the moment the clutch bites.
      this.clutchSlip = true;
      landing = Math.max(c.idleRpm, this.speed * ratio * c.finalDrive);
      prog = c.shiftTime > 0 ? clamp(1 - this.shiftTimer / c.shiftTime, 0, 1) : 1;
      var ease = prog * prog * (3 - 2 * prog);
      this.rpm = this._shiftFrom + (landing - this._shiftFrom) * ease;
      driveScale = 0;
    } else if (this.gear === 0 || shifting) {
      // neutral: the engine spins freely
      this.clutchSlip = true;
      var target = c.idleRpm + this.throttle * (c.maxRpm - c.idleRpm) * 0.97;
      if (target > this.rpm) this.rpm = Math.min(target, this.rpm + c.freeRevUp * this.torqueAt(this.rpm) * dt);
      else this.rpm = Math.max(target, this.rpm - c.freeRevDown * dt);
      driveScale = 0;
    } else if (lockedRpm < c.idleRpm + 40) {
      // slipping clutch: pulling away / crawling
      this.clutchSlip = true;
      var hold = c.idleRpm + this.throttle * (c.launchRpm - c.idleRpm);
      var want = Math.max(hold, lockedRpm);
      this.rpm += (want - this.rpm) * (1 - Math.exp(-7 * dt));
      driveScale = clamp((this.rpm - c.idleRpm) / Math.max(1, c.launchRpm - c.idleRpm), 0, 1);
    } else {
      this.clutchSlip = false;
      this.rpm = lockedRpm;
      driveScale = 1;
    }

    // rev limiter
    this.limiter = this.rpm >= c.maxRpm - 5;
    if (this.limiter) {
      this.rpm = c.maxRpm;
      this._limiterPhase += dt * 17;
    }

    var torque = (shifting || this.limiter) ? 0 : this.throttle * this.torqueAt(this.rpm) * driveScale;
    var drive = torque * ratio * c.enginePower;

    // What the engine is actually doing, as opposed to where the pedal is. A
    // rev-match with the foot off is still the engine making power, and a
    // closed throttle only sounds like overrun when the wheels are driving it -
    // free-revving down in neutral is a completely different noise.
    // The blip envelope is 4*prog*(1-prog): zero at both ends of the shift and
    // peaking in the middle, where the smoothstep glide is accelerating the
    // engine hardest. It has to reach zero at the edges - a blip that switches
    // on at full value steps the mix by a quarter of its level in one frame,
    // which is an audible click at the start of every downshift.
    this.blip = (shifting && this.gear !== 0 && landing > this._shiftFrom + 50)
      ? clamp((landing - this._shiftFrom) / 1500, 0, 1) * 4 * prog * (1 - prog)
      : 0;
    var rpmDrag = clamp((this.rpm - c.idleRpm) / Math.max(1, c.overrunRefRpm - c.idleRpm), 0, 1);
    var overrunTarget = (this.gear !== 0 && !shifting && !this.clutchSlip)
      ? (1 - this.throttle) * rpmDrag
      : 0;
    // Smoothed for the same reason, and because a clutch takes a moment to bite.
    this.overrun += (overrunTarget - this.overrun) * (1 - Math.exp(-12 * dt));
    this.load = clamp(torque + this.blip - this.overrun, -1, 1);

    var brakeDecel = this.brake * c.brakePower;
    var engBrake = (this.gear === 0 || shifting || this.clutchSlip)
      ? 0
      : (1 - this.throttle) * ratio * c.engineBrake;
    var drag = c.dragC * this.speed * this.speed + (this.speed > 0.3 ? c.rollC : 0);

    this.speed = Math.max(0, this.speed + (drive - brakeDecel - engBrake - drag) * dt);
    this.distance += (this.speed / 3600) * dt;

    // when the clutch re-engages after a shift, snap onto the new locked RPM
    if (shifting && this.shiftTimer === 0 && this.gear !== 0) {
      this.rpm = Math.max(c.idleRpm, this.speed * this.ratio() * c.finalDrive);
    }

    if (this.auto) this._autoShift();

    // Lift-off burst. A cooldown re-arms it instead of the old latch, which
    // only cleared when the throttle was reopened and so gave a whole
    // deceleration exactly one burst. The continuous crackle lives in
    // audio.js; this event is just the transient that marks the lift.
    if (this._overrunHold > 0) this._overrunHold = Math.max(0, this._overrunHold - dt);
    if (wasThrottle > 0.25 && this.throttleInput < 0.05 && this.rpm > 3800
        && !shifting && this._overrunHold === 0) {
      this._overrunHold = 1.5;
      this._emit('overrun', { rpm: this.rpm, intensity: clamp(wasThrottle, 0.4, 1) });
    }

    return this.state();
  };

  Engine.prototype._autoShift = function () {
    var c = this.cfg;
    if (this.shiftTimer > 0 || this._shiftLock > 0) return;
    if (this.gear === 0) { this.selectGear(1); return; }

    // Braking holds the box low: upshifts are blocked outright, and the
    // downshift point climbs with pedal pressure. Without this the box shifts
    // down at a fixed 2400 rpm whatever you are doing, so the whole stop
    // drones just above that - below every overrun layer's window.
    var braking = clamp(this.brake, 0, 1);
    if (this.gear < this.gearCount && this.rpm >= c.shiftUpRpm && braking < 0.15) {
      this.shiftUp();
      return;
    }
    var downRpm = c.shiftDownRpm
      + braking * ((c.shiftDownBrakingRpm || c.shiftDownRpm) - c.shiftDownRpm);
    if (this.gear > 1 && this.rpm <= downRpm) {
      // only downshift if we would not immediately bounce back up
      var next = this.speed * this.cfg.gearRatios[this.gear - 2] * c.finalDrive;
      if (next < c.shiftUpRpm - 500 && next < c.maxRpm * 0.92) this.shiftDown();
    }
  };

  Engine.prototype.limiterGate = function () {
    if (!this.limiter) return 1;
    return Math.sin(this._limiterPhase * Math.PI * 2) > 0 ? 1 : 0.25;
  };

  Engine.prototype.state = function () {
    return {
      rpm: this.rpm,
      speed: this.speed,
      gear: this.gear,
      gearCount: this.gearCount,
      throttle: this.throttle,
      brake: this.brake,
      blip: this.blip,
      overrun: this.overrun,
      load: this.load,
      shifting: this.shiftTimer > 0,
      shiftProgress: this.shiftTimer > 0 ? 1 - this.shiftTimer / this.cfg.shiftTime : 1,
      shiftDir: this.shiftDir,
      limiter: this.limiter,
      limiterGate: this.limiterGate(),
      clutchSlip: this.clutchSlip,
      auto: this.auto,
      distance: this.distance,
      idleRpm: this.cfg.idleRpm,
      maxRpm: this.cfg.maxRpm,
      redlineRpm: this.cfg.redlineRpm
    };
  };

  ES.Engine = Engine;
  ES.lerpCurve = lerpCurve;
  ES.clamp = clamp;
})(window.ES = window.ES || {});
