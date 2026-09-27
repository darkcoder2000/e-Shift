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
    shiftTime: 0.22,       // seconds of open clutch
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

    this._limiterPhase = 0;
    this._listeners = {};
    this._shiftLock = 0;
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
    var after = g === 0 ? this.cfg.idleRpm : Math.max(this.cfg.idleRpm, this.speed * this.ratio() * this.cfg.finalDrive);
    if (!silent) {
      this._emit('shift', {
        dir: dir, gear: g, rpmBefore: before, rpmAfter: after,
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

    if (this.gear === 0 || shifting) {
      // clutch open: the engine spins freely
      this.clutchSlip = true;
      var target = c.idleRpm + this.throttle * (c.maxRpm - c.idleRpm) * 0.97;
      if (shifting) target = c.idleRpm; // foot-off during the shift
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

    // overrun: sudden lift at high RPM
    if (wasThrottle > 0.25 && this.throttleInput < 0.05 && this.rpm > 3800 && !shifting) {
      if (!this._overrun) { this._overrun = true; this._emit('overrun', { rpm: this.rpm }); }
    } else if (this.throttleInput > 0.15) {
      this._overrun = false;
    }

    return this.state();
  };

  Engine.prototype._autoShift = function () {
    var c = this.cfg;
    if (this.shiftTimer > 0 || this._shiftLock > 0) return;
    if (this.gear === 0) { this.selectGear(1); return; }

    if (this.gear < this.gearCount && this.rpm >= c.shiftUpRpm) {
      this.shiftUp();
      return;
    }
    if (this.gear > 1 && this.rpm <= c.shiftDownRpm) {
      // only downshift if we would not immediately bounce back up
      var next = this.speed * this.cfg.gearRatios[this.gear - 2] * c.finalDrive;
      if (next < c.shiftUpRpm - 500) this.shiftDown();
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
