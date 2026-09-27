# e-Shift — Virtual Engine Sound Simulation

A browser app that fakes the feel of a combustion drivetrain — engine note, rev
counter and virtual gearshifts — with no engine anywhere in sight. Inspired by
Hyundai's N e-Shift / N Active Sound in the Ioniq 5 N.

Plain HTML + JS + Web Audio API. No build step, no dependencies, no backend.

## Running it

```
serve.cmd            # or: python -m http.server 8777
```

then open <http://127.0.0.1:8777/>.

Double-clicking `index.html` also works. `fetch()` is blocked on `file://`, so
the app falls back to the copy of the config baked into `js/fallback-config.js`
and says so in the *Sound profile* panel. Serve it over HTTP if you want to edit
`soundconfig.json` and just hit reload.

Audio only starts after the first click — browser autoplay policy.

## Controls

| Key | |
|---|---|
| `W` / `↑` | throttle |
| `S` / `↓` | brake |
| `E` / `→` | shift up (switches to manual) |
| `Q` / `←` | shift down (switches to manual) |
| `N` | neutral — free-rev the engine |
| `M` | toggle automatic / manual |
| `R` | reset |

## How it works

**`js/engine.js` — the virtual drivetrain.** Road speed is the integrated state;
RPM is derived from it:

```
rpm = speed_kmh · gearRatio · finalDrive
```

That one relation gives correct shift behaviour for free — changing gear at a
given speed drops the engine to exactly `rpm · ratio_new / ratio_old`. Below idle
a slipping-clutch model takes over so the car can pull away from rest, and in
neutral the engine free-revs. Acceleration comes from a normalised torque curve
times the gear ratio, minus engine braking, aero drag and rolling resistance. It
is tuned for feel, not for physical accuracy.

**`js/audio.js` — the Web Audio graph.** Each layer of a profile is one looping
`AudioBufferSourceNode` that is started once and never stopped (stopping clicks).
Per frame we only move `playbackRate` (`rpm / layer.baseRpm`) and the layer gains:

```
weight = layer.gain · loadCurve(throttle) · rpmCurve(rpm) · rateFit
gain   = weight / √Σweight²  ·  loudnessCurve(rpm) · throttleLoudnessCurve(throttle)
```

The equal-power normalisation keeps the total level steady while the blend moves.
`rateFit` fades a layer out as its required playback rate leaves
`playbackRateRange`, so no layer ever sits droning at a wrongly clamped pitch —
the guide's "don't pitch one sample across the whole range" note, enforced in
code. A lowpass on the bus opens with load and revs (airbox/muffler), and a
compressor catches the peaks.

```
layer[i] -> gain -> pan -\
whine osc -> gain --------> bus -> lowpass -> master -> comp -> out
shift clunk / pops ----------------------------------/
```

One-shots deliberately sit *after* the master gain so the shift dip doesn't
swallow the clunk that marks the shift.

**`js/synth.js` — the placeholder sounds.** Rather than shipping WAVs, Phase 1
builds the loops in the frequency domain: the buffer is a power of two long, the
firing frequency is snapped onto its FFT bin grid, and every partial is an
integer multiple of that grid. The loop is therefore seamless *by construction* —
no zero-crossing hunting, no click. Measured: the sample step across the join is
smaller than the largest step inside the waveform.

Spectrum knobs per layer: firing harmonics with a spectral `tilt`, `half`-order
content for the lumpy/burbly character, `oddBias` for cross-plane V8 unevenness,
periodic broadband `noise`, a resonant `formant`, and `grit` (tanh saturation,
with the DC it introduces removed again). Content is capped at ~12 kHz so
pitching up to ~2× doesn't alias.

Because the firing frequency gets snapped, the generator reports the base RPM it
*actually* landed on, and the audio engine uses that value.

**`js/ui.js`** draws the tachometer; **`js/main.js`** wires config, input and the
frame loop.

## Sound profiles (Phase 2)

`soundconfig.json` is the source of truth. Three profiles ship: a turbo I4, a
cross-plane V8 and a synthetic "e-Sound". Switch them in the header; each one
brings its own gearbox, rev range, torque curve and mix.

### Dropping in your own samples

1. Put seamless mono loops in `sounds/` (see `sounds/README.md`).
2. Point a layer at one and tell it what RPM the recording was made at:

```json
{
  "id": "full_load",
  "file": "sounds/i4/full_load.wav",
  "baseRpm": 5600,
  "gain": 1.05,
  "loadCurve": [[0, 0.2], [0.3, 0.55], [0.7, 1], [1, 1]],
  "rpmCurve":  [[2400, 0], [3600, 0.5], [5000, 1], [7600, 1]],
  "generate":  { "...": "used only if the file is missing" }
}
```

A layer tries its `file` first and silently falls back to `generate`, listing
what it substituted in the *Sound profile* panel. That means you can replace one
layer at a time and hear the result immediately.

There is no fixed layer count — add a fourth "overrun" layer, or split the rev
range into five bands, and the mixer picks it up.

3. Reload. No code changes.

You can also load a config file from disk with **Load config…** (handy on
`file://`), and **Download config** writes the current one back out.

### Config reference

Profile level: `engine` (any `js/engine.js` default can be overridden —
`idleRpm`, `maxRpm`, `redlineRpm`, `shiftUpRpm`, `shiftDownRpm`, `shiftTime`,
`gearRatios`, `finalDrive`, `enginePower`, `engineBrake`, `brakePower`, `dragC`,
`rollC`, `launchRpm`, `torqueCurve`), `playbackRateRange`, `shiftDip`,
`loudnessCurve`, `throttleLoudnessCurve`, `tone` (`base`/`throttle`/`rpm` terms
of the bus lowpass), `layers`, `whine`, `shift`, `pop`.

Layer level: `id`, `file`, `baseRpm`, `gain`, `pan`, `glide`, `loopStart`,
`loopEnd`, `startOffset`, `loadCurve`, `rpmCurve`, `generate`.

Every `*Curve` is a list of `[x, y]` breakpoints, linearly interpolated and
clamped at both ends.

### After editing soundconfig.json

Regenerate the `file://` fallback copy:

```
node tools/build-fallback.mjs
```

## Status

Steps 1–5 of the guide are implemented and Step 6 is in place. Not done yet:
gamepad/analog throttle (the input layer already goes through
`engine.setThrottle(0..1)`, so an axis drops straight in), and the 2D car
visualisation.
