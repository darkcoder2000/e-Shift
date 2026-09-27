/* main.js - config loading, input, the frame loop and the DOM wiring. */
(function (ES) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var clamp = ES.clamp;

  var config = null;
  var profileKey = null;
  var ctx = null;
  var audio = null;
  var engine = new ES.Engine();
  var tach = null;
  var running = false;
  var lastT = 0;

  /* ---------------- config ---------------- */

  function loadConfig() {
    // Served over http(s) the JSON file is authoritative. Opened straight from
    // disk (file://) fetch is blocked, so we fall back to the baked-in copy.
    return fetch('soundconfig.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .catch(function () {
        note('soundconfig.json could not be fetched (file:// ?) - using the built-in copy. '
          + 'Run a local web server to edit the JSON live.');
        return JSON.parse(JSON.stringify(ES.FALLBACK_CONFIG));
      });
  }

  function applyConfig(cfg, preferKey) {
    config = cfg;
    var sel = $('profile');
    sel.innerHTML = '';
    Object.keys(config.profiles).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = config.profiles[k].name || k;
      sel.appendChild(o);
    });
    var key = (preferKey && config.profiles[preferKey]) ? preferKey
      : (config.profiles[config.defaultProfile] ? config.defaultProfile : Object.keys(config.profiles)[0]);
    sel.value = key;
    return selectProfile(key);
  }

  function selectProfile(key) {
    profileKey = key;
    var p = config.profiles[key];
    $('profile-desc').textContent = p.description || '';
    engine.configure(p.engine || {});
    engine.reset();
    buildMixRows(p);
    if (!audio) return Promise.resolve();
    return audio.load(p, config.basePath || '').then(function (notes) {
      audio.setVolume($('volume').value / 100);
      clearNotes();
      notes.forEach(note);
    });
  }

  /* ---------------- notes / mix panel ---------------- */

  var pendingNotes = [];
  function note(text) {
    pendingNotes.push(text);
    var ul = $('notes');
    if (!ul) return;
    var li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
  function clearNotes() { pendingNotes = []; if ($('notes')) $('notes').innerHTML = ''; }

  var mixRows = [];
  function buildMixRows(p) {
    var host = $('mix');
    host.innerHTML = '';
    mixRows = [];
    (p.layers || []).forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'mix-row';
      row.innerHTML = '<b></b><div class="m"><i></i></div><u>0%</u>';
      row.querySelector('b').textContent = l.id || 'layer';
      host.appendChild(row);
      mixRows.push({ bar: row.querySelector('i'), val: row.querySelector('u') });
    });
    $('mix-note').textContent = p.whine && p.whine.gain > 0
      ? 'Plus a synthesised motor whine at order ' + p.whine.order + '.'
      : '';
  }

  /* ---------------- start ---------------- */

  function start() {
    if (running) return;
    var btn = $('start-btn');
    btn.disabled = true;
    btn.textContent = 'Building sounds…';

    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    audio = new ES.EngineAudio(ctx);

    var resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    resume
      .then(function () { return audio.load(config.profiles[profileKey], config.basePath || ''); })
      .then(function (notes) {
        audio.setVolume($('volume').value / 100);
        notes.forEach(note);
        $('start').classList.add('hidden');
        document.querySelector('.app').setAttribute('aria-hidden', 'false');
        running = true;
        lastT = performance.now();
        requestAnimationFrame(frame);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Start engine';
        note('Audio failed to start: ' + err.message);
      });
  }

  /* ---------------- input ---------------- */

  var held = {};

  function keyDown(e) {
    if (e.repeat) return;
    var k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) e.preventDefault();
    held[k] = true;

    if (!running) { if (k !== 'tab') start(); return; }

    if (k === 'e' || k === 'arrowright') { engine.setAuto(false); syncAuto(); engine.shiftUp(); }
    if (k === 'q' || k === 'arrowleft') { engine.setAuto(false); syncAuto(); engine.shiftDown(); }
    if (k === 'n') { engine.setAuto(false); syncAuto(); engine.toNeutral(); }
    if (k === 'm') { engine.setAuto(!engine.auto); syncAuto(); }
    if (k === 'r') { engine.reset(); }
  }

  function keyUp(e) { held[e.key.toLowerCase()] = false; }

  function readInput() {
    // Binary for now; an analog source (gamepad axis) can drive the same setters.
    var thr = held.w || held.arrowup ? 1 : 0;
    var brk = held.s || held.arrowdown ? 1 : 0;
    engine.setThrottle(thr);
    engine.setBrake(brk);
  }

  function syncAuto() { $('auto').checked = engine.auto; }

  /* ---------------- frame loop ---------------- */

  function frame(now) {
    var dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;

    readInput();
    var st = engine.update(dt);
    audio.update(st);
    tach.draw(st, dt);
    render(st);

    requestAnimationFrame(frame);
  }

  var prevGear = null;
  function render(st) {
    var gearEl = $('gear');
    if (st.gear !== prevGear) {
      gearEl.textContent = st.gear === 0 ? 'N' : st.gear;
      gearEl.classList.toggle('neutral', st.gear === 0);
      prevGear = st.gear;
    }
    $('mode').textContent = st.auto ? 'AUTO' : 'MANUAL';
    $('speed').textContent = Math.round(st.speed);
    $('odo').textContent = st.distance.toFixed(2);
    $('bar-throttle').style.width = (st.throttle * 100).toFixed(1) + '%';
    $('bar-brake').style.width = (st.brake * 100).toFixed(1) + '%';

    flag('flag-shift', st.shifting, false);
    flag('flag-limiter', st.limiter, true);
    flag('flag-clutch', st.clutchSlip, false);

    for (var i = 0; i < mixRows.length && i < audio.layers.length; i++) {
      var lvl = clamp(audio.layers[i].level, 0, 1);
      mixRows[i].bar.style.width = (lvl * 100).toFixed(1) + '%';
      mixRows[i].val.textContent = Math.round(lvl * 100) + '%';
    }
  }

  function flag(id, on, warn) {
    var el = $(id);
    el.classList.toggle('on', !!on);
    el.classList.toggle('warn', !!on && !!warn);
  }

  /* ---------------- boot ---------------- */

  function boot() {
    tach = new ES.Tach($('tach'));
    tach.draw(engine.state(), 1);

    engine.on('shift', function (info) { if (audio) audio.playShift(info); });
    engine.on('overrun', function (info) { if (audio) audio.playPop(info); });

    $('start-btn').addEventListener('click', start);
    $('start').addEventListener('click', function (e) { if (e.target.id === 'start') start(); });
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', function () { held = {}; });

    $('volume').addEventListener('input', function () {
      if (audio) audio.setVolume(this.value / 100);
    });
    $('profile').addEventListener('change', function () { selectProfile(this.value); });
    $('auto').addEventListener('change', function () { engine.setAuto(this.checked); });

    $('cfg-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      f.text().then(function (txt) {
        try {
          var cfg = JSON.parse(txt);
          if (!cfg.profiles) throw new Error('no "profiles" key');
          clearNotes();
          applyConfig(cfg, profileKey);
          note('Loaded config from ' + f.name + '.');
        } catch (err) {
          note('Could not read that config: ' + err.message);
        }
      });
      this.value = '';
    });

    $('cfg-save').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'soundconfig.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    loadConfig().then(function (cfg) {
      applyConfig(cfg);
      tach.draw(engine.state(), 1);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.ES = window.ES || {});
