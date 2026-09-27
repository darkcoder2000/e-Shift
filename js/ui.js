/* ui.js - tachometer canvas plus the readouts around it. */
(function (ES) {
  'use strict';

  var clamp = ES.clamp;
  var TAU = Math.PI * 2;
  var START = Math.PI * 0.75;   // 135 deg
  var SWEEP = Math.PI * 1.5;    // 270 deg sweep

  function Tach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.needle = 0;
    this.resize();
    window.addEventListener('resize', this.resize.bind(this));
  }

  Tach.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var rect = this.canvas.getBoundingClientRect();
    var size = Math.max(160, Math.min(rect.width, rect.height) || 320);
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
  };

  Tach.prototype.draw = function (st, dt) {
    var g = this.ctx, s = this.size, cx = s / 2, cy = s / 2, r = s * 0.42;
    var maxR = Math.ceil(st.maxRpm / 1000) * 1000;

    // needle lag, so the dial still feels mechanical during hard shifts
    var target = clamp(st.rpm / maxR, 0, 1);
    var k = 1 - Math.exp(-18 * Math.min(dt, 0.1));
    this.needle += (target - this.needle) * k;

    g.clearRect(0, 0, s, s);

    // dial face
    var bg = g.createRadialGradient(cx, cy * 0.85, r * 0.15, cx, cy, r * 1.15);
    bg.addColorStop(0, '#16181d');
    bg.addColorStop(1, '#0a0b0e');
    g.fillStyle = bg;
    g.beginPath(); g.arc(cx, cy, r * 1.12, 0, TAU); g.fill();

    g.lineWidth = s * 0.03;
    g.strokeStyle = '#22262e';
    g.beginPath(); g.arc(cx, cy, r, START, START + SWEEP); g.stroke();

    // redline arc
    var rl = clamp(st.redlineRpm / maxR, 0, 1);
    g.strokeStyle = '#ff2d3f';
    g.beginPath(); g.arc(cx, cy, r, START + SWEEP * rl, START + SWEEP); g.stroke();

    // active arc
    var grad = g.createLinearGradient(0, cy + r, 0, cy - r);
    grad.addColorStop(0, '#0ea5e9');
    grad.addColorStop(0.7, '#38e1ff');
    grad.addColorStop(1, '#ff4d5e');
    g.strokeStyle = grad;
    g.lineWidth = s * 0.032;
    g.beginPath(); g.arc(cx, cy, r, START, START + SWEEP * this.needle); g.stroke();

    // ticks + labels
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (var v = 0; v <= maxR; v += 500) {
      var big = v % 1000 === 0;
      var a = START + SWEEP * (v / maxR);
      var r1 = r - s * 0.035, r2 = r1 - s * (big ? 0.055 : 0.028);
      g.strokeStyle = v >= st.redlineRpm ? '#ff5566' : (big ? '#c8d2e0' : '#5b6474');
      g.lineWidth = big ? s * 0.009 : s * 0.005;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.stroke();
      if (big) {
        var lr = r2 - s * 0.055;
        g.fillStyle = v >= st.redlineRpm ? '#ff8892' : '#93a0b4';
        g.font = '600 ' + Math.round(s * 0.058) + 'px ui-monospace, Menlo, Consolas, monospace';
        g.fillText(String(v / 1000), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
      }
    }

    // shift light
    if (st.rpm >= st.redlineRpm) {
      var pulse = st.limiter ? (Math.sin(performance.now() / 45) * 0.5 + 0.5) : 1;
      g.fillStyle = 'rgba(255,45,63,' + (0.25 + 0.55 * pulse) + ')';
      g.beginPath(); g.arc(cx, cy - r * 0.62, s * 0.028, 0, TAU); g.fill();
    }

    // digital readout, below the hub so the needle never crosses it
    g.fillStyle = '#e8eef7';
    g.font = '700 ' + Math.round(s * 0.125) + 'px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(String(Math.round(st.rpm)), cx, cy + s * 0.165);
    g.fillStyle = '#69748a';
    g.font = '600 ' + Math.round(s * 0.042) + 'px system-ui, sans-serif';
    g.fillText('RPM', cx, cy + s * 0.245);

    // needle
    var na = START + SWEEP * this.needle;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    g.fillStyle = '#ff3b4d';
    g.beginPath();
    g.moveTo(-s * 0.02, -s * 0.011);
    g.lineTo(r - s * 0.045, -s * 0.004);
    g.lineTo(r - s * 0.045, s * 0.004);
    g.lineTo(-s * 0.02, s * 0.011);
    g.closePath();
    g.fill();
    g.restore();
    g.fillStyle = '#1c2029';
    g.beginPath(); g.arc(cx, cy, s * 0.035, 0, TAU); g.fill();
    g.strokeStyle = '#39404d';
    g.lineWidth = s * 0.006;
    g.stroke();
  };

  ES.Tach = Tach;
})(window.ES = window.ES || {});
