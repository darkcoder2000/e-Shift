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

While the clutch is open for a shift the engine is **rev-matched**: it glides,
on a smoothstep over the shift's progress, onto the RPM the clutch will actually
close at. So a downshift blips *up* and an upshift falls to exactly the right
place, and the RPM is continuous when the clutch bites. Interpolating on
progress rather than chasing at a fixed rate is what guarantees that — dropping
2300 rpm in 0.2 s needs 11 500 rpm/s, and whatever a rate limit fails to cover
arrives as a step.

Braking also holds the box low: upshifts are blocked outright, and the
downshift point climbs with pedal pressure from `shiftDownRpm` toward
`shiftDownBrakingRpm`.

Alongside `throttle` — a *pedal position* — the state carries three signals
describing what the engine is actually doing. The audio side needs the
difference, because coasting in gear at 5000 rpm and free-revving down through
5000 rpm in neutral are the same pedal and completely different noises:

| | |
|---|---|
| `overrun` | 0..1, closed throttle with the clutch locked — the wheels driving the engine. Zero in neutral, during a shift, and near idle. Smoothed, so it does not step when the clutch bites. |
| `blip` | 0..1, the rev-match during a downshift. Shaped `4·p·(1−p)`, so it is zero at both ends of the shift and peaks where the glide accelerates hardest. |
| `load` | signed, `torque + blip − overrun`: −1 is full engine braking, +1 full drive. |

**`js/audio.js` — the Web Audio graph.** Each layer of a profile is one looping
`AudioBufferSourceNode` that is started once and never stopped (stopping clicks).
Per frame we only move `playbackRate` (`rpm / layer.baseRpm`) and the layer gains:

```
weight = layer.gain · loadCurve(thr) · overrunCurve(overrun) · rpmCurve(rpm) · rateFit
gain   = weight / √Σweight²  ·  loudnessCurve(rpm) · throttleLoudnessCurve(thr)
                              · overrunLoudnessCurve(overrun)
```

The equal-power normalisation keeps the total level steady while the blend moves.

`thr` is an *effective* throttle, `max(throttle, blip)`. The driver's foot is
off during a rev-match but the engine is making noise as though it were on
throttle, and that substitution is what makes a downshift audible as one.

`overrunCurve` is the second load axis, and it is optional — a layer without
one behaves exactly as before. It keys on `st.overrun`, so the off-throttle
layers can be silent in neutral and full when the wheels are driving the
engine, which `loadCurve` alone cannot express: both are zero throttle.

`rateFit` is the guard against the worst thing this mixer can do: a layer whose
required rate is outside `playbackRateRange` gets clamped, which means it plays
*out of tune* against the correctly pitched layers. So the fade is driven by the
actual detune in cents, not by the rate ratio, and anything sour is silent well
before it is audible. It is a safety net rather than the crossfade — it collapses
over about 2% of RPM — so each layer's `rpmCurve` should already reach 0 before
its rate limit. When a profile gets that wrong the app says so in the *Sound
profile* panel.

```
layer[i] -> gain -> pan -\
whine osc -> gain --------> bus -> formants -> drive -> rasp -> lowpass -> master -> comp -> out
intake noise -> bp -> gain /                                                          |
shift clunk / pops -------------------------------------------------------------------
```

Everything from the bus to the lowpass is rebuilt per profile:

- **formants** — a chain of fixed peaking filters. A resonance baked into a
  sample transposes with it (the "sped-up tape" artifact); a real exhaust or
  airbox resonance is fixed by geometry and stays put as the engine revs.
  Keeping them here is the single biggest reason high RPM sounds like an engine
  rather than a transposed loop.
- **drive** — a pre-gain into a fixed soft clipper, with a compensating
  post-gain. Modulating the pre-gain gives variable saturation: clean off
  throttle, gritty under load.
- **rasp** — a high shelf that opens with load and revs.
- **intake** — a long noise loop through a bandpass whose centre tracks RPM.
  Above roughly 5000 rpm a real engine is largely broadband roar, which no
  pitched layer can produce. Its playback rate stays at 1.0 on purpose, so its
  loop point never becomes audible.

`drive`, `rasp` and `intake` each take an optional `overrunCurve` as well, and
`tone` an `overrun` term. Without them the whole graph collapses to its floors
the instant you lift, which is wrong: a closed throttle at 5000 rpm in gear is
hard and hollow, not muffled and quiet. Note the multiplier has to evaluate to
1 at `overrun = 0` to leave on-throttle behaviour untouched, so a stage that
should gain on the overrun needs a `loadCurve` floor above zero for the boost
to have something to act on.

A lowpass then opens with load and revs (airbox/muffler) and a compressor catches
the peaks. One-shots deliberately sit *after* the master gain so the shift dip
doesn't swallow the clunk that marks the shift.

**Overrun crackle** is a continuous process, not a one-shot. Each frame it
accumulates `pop.rateMax · rpmCurve(rpm) · overrunCurve(overrun)` events per
second and fires with jittered spacing, so a deceleration cracks the whole way
down. Bursts sit on top of that at the lift and at every coasting downshift.
Pops are scheduled on the **audio clock** rather than with `setTimeout` — a pop
is a 90 ms transient and timer jitter is a large fraction of that — and each
gets its own bandpass so the crackle sits in the exhaust band and follows the
revs instead of being the same white tick every time.

**`js/synth.js` — the placeholder sounds.** Rather than shipping WAVs, Phase 1
builds the loops in the frequency domain: the buffer is a power of two long, the
firing frequency is snapped onto its FFT bin grid, and every partial is an
integer multiple of that grid. The loop is therefore seamless *by construction* —
no zero-crossing hunting, no click. Measured: the sample step across the join is
smaller than the largest step inside the waveform.

Spectrum knobs per layer: firing `order` (cylinders ÷ 2 on a four-stroke),
harmonics with a spectral `tilt`, `half`-order content for the lumpy/burbly
character, `oddBias` for cross-plane V8 unevenness, periodic broadband `noise`,
and `grit` (tanh saturation, with the DC it introduces removed again). Content
is capped at ~12 kHz so pitching up doesn't alias.

`shimmer` is what stops the loops sounding frozen. A stationary loop repeats
bit-identically — pitched up, a 0.7 s buffer can repeat twice a second, which
reads as a stutter. Shimmer seeds small sidebands one and two bins either side
of each partial; they beat against it at ~1.5 Hz, so every harmonic's level and
phase drift over the buffer. They sit on the bin grid like everything else, so
the loop stays seamless.

Because the firing frequency gets snapped, the generator reports the base RPM it
*actually* landed on, and the audio engine uses that value.

**`js/ui.js`** draws the tachometer; **`js/main.js`** wires config, input and the
frame loop.

## Sound profiles (Phase 2)

`soundconfig.json` is the source of truth. Three profiles ship: a turbo I4, a
cross-plane V8 and a synthetic "e-Sound". Switch them in the header; each one
brings its own gearbox, rev range, torque curve and mix.

Each profile has eight layers: six pitched bands (`idle`, `low`, `low_mid`,
`mid`, `high_mid`, `top`) plus `overrun_low` and `overrun_high` for the
off-throttle voice.

Two overrun layers, not one, for the same reason there are six pitched bands
rather than three. A stop runs from the limiter down to idle, and stretching a
single off-throttle loop over roughly 1400–6900 rpm means transposing it by
×4.6 — straight back into the detuned-layer problem. The same ×0.5…×1.25
budget applies, so the range needs two. Their windows are placed to reach down
to where the `overrun` signal itself dies out near idle; below that the pitched
`idle` and `low` layers take over, which is correct, because an engine barely
brakes at 1200 rpm.

Six bands rather than three is the other half of the high-RPM fix — it keeps
every audible layer inside roughly ×0.75…×1.25 of its recorded pitch, where
sample transposition still sounds like an engine. The bands are deliberately
asymmetric: a layer may be pulled well *below* its base (it just gets darker)
but only slightly above (thin and chipmunk-ish), so the dominant layer at any
RPM is always one being transposed *down*.

The *Layer mix* panel shows each layer's live playback rate. If you are tuning
a profile, that column is the one to watch — keep whatever is loud near ×1.

### Dropping in your own samples

1. Put seamless mono loops in `sounds/` (see `sounds/README.md`).
2. Point a layer at one and tell it what RPM the recording was made at:

```json
{
  "id": "high_mid",
  "file": "sounds/i4/high_mid.wav",
  "baseRpm": 4600,
  "gain": 1.06,
  "loadCurve": [[0, 0.51], [0.3, 0.8], [1, 1]],
  "rpmCurve":  [[2392, 0], [2944, 0.6], [3680, 0.95], [4370, 1], [4876, 1], [5244, 0.62], [5612, 0.15], [5980, 0]],
  "generate":  { "...": "used only if the file is missing" }
}
```

A layer tries its `file` first and silently falls back to `generate`, and the
*Sound profile* panel says how many layers were substituted. That means you can
replace one layer at a time and hear the result immediately.

There is no fixed layer count — drop back to three bands, or split the range
into ten, and the mixer picks it up. Two things to keep right if you do:

- `baseRpm` must match what the recording actually was, or the whole layer is
  transposed.
- A layer's `rpmCurve` should reach 0 before `rpm / baseRpm` leaves
  `playbackRateRange`. Otherwise the detune guard mutes it for you and the panel
  tells you which layer and at what RPM.

3. Reload. No code changes.

You can also load a config file from disk with **Load config…** (handy on
`file://`), and **Download config** writes the current one back out.

### Config reference

Profile level: `engine` (any `js/engine.js` default can be overridden —
`idleRpm`, `maxRpm`, `redlineRpm`, `shiftUpRpm`, `shiftDownRpm`,
`shiftDownBrakingRpm`, `overrunRefRpm`, `shiftTime`, `gearRatios`, `finalDrive`,
`enginePower`, `engineBrake`, `brakePower`, `dragC`, `rollC`, `launchRpm`,
`torqueCurve`), `playbackRateRange`, `maxDetuneCents`, `shiftDip`,
`loudnessCurve`, `throttleLoudnessCurve`, `overrunLoudnessCurve`, `tone`
(`base`/`throttle`/`overrun`/`rpm` terms of the bus lowpass), `formants`,
`drive`, `rasp`, `intake`, `layers`, `whine`, `shift`, `pop`.

| Profile key | |
|---|---|
| `formants` | `[{ freq, q, gain }]`, gain in dB. Fixed peaking filters — the body of the car. Never modulated. |
| `drive` | `{ amount, rpmCurve, loadCurve }`. Soft-clip saturation that rises with load. |
| `rasp` | `{ freq, maxGain, rpmCurve, loadCurve }`. High shelf, gain in dB. |
| `intake` | `{ gain, q, freq: { base, rpm }, rpmCurve, loadCurve, generate }`. Broadband bed; `freq.base + rpm · freq.rpm` sets the bandpass centre. |
| `maxDetuneCents` | How far out of tune a layer may be before it is muted. Default 35. |
| `pop` | `{ gain, enabled, rateMax, rpmCurve, overrunCurve, freq, freqRpm, burstCount, generate }`. `rateMax` is events per second at full crackle; `freq + rpm · freqRpm` sets each pop's bandpass centre. |
| `overrunLoudnessCurve` | Multiplies the overall level by `f(overrun)`. Engine braking at high revs is loud, not quiet. |
| `shiftDownBrakingRpm` | The downshift point at full brake; scales up from `shiftDownRpm` with pedal pressure. |
| `overrunRefRpm` | The RPM by which engine braking counts as "full" for the `overrun` signal. |

Layer level: `id`, `file`, `baseRpm`, `gain`, `pan`, `glide`, `loopStart`,
`loopEnd`, `startOffset`, `loadCurve`, `overrunCurve`, `rpmCurve`, `generate`.

Generator (`generate`) keys: `type` (`engine`, `noise`, `clunk`, `pop`),
`order` or `cylinders`, `baseRpm`, `duration`, `harmonics`, `tilt`, `half`,
`oddBias`, `noise`, `noiseTilt`, `shimmer`, `grit`, `formant`/`formantQ`/
`formantGain`, `maxFreq`, `peak`, `seed`. Prefer the profile-level `formants`
over the per-layer `formant`: a baked resonance transposes with the sample.

Every `*Curve` is a list of `[x, y]` breakpoints, linearly interpolated and
clamped at both ends.

### After editing soundconfig.json

Regenerate the `file://` fallback copy:

```
node tools/build-fallback.mjs
```

## Tuning notes

Two measurements worth re-running after changing a profile (both are quick
scripts over `soundconfig.json` plus `js/synth.js`):

- **No audible layer should be off-pitch.** Sweep RPM × throttle, and for every
  layer at ≥0.2 normalised gain check that `rpm / baseRpm` is inside
  `playbackRateRange`. The shipped profiles are at 0% of operating points.
- **Nothing loud should be transposed more than about ×1.25.** The shipped
  profiles peak at ×1.24–×1.25.
- **The RPM must be continuous when the clutch closes.** Drive a stop and
  compare the last rev-matched frame with the first locked one; the shipped
  profiles step by 0 rpm.
- **An overrun layer must still be audible wherever the `overrun` signal is.**
  The signal reaches 0.3 at `idleRpm + 0.3 · (overrunRefRpm − idleRpm)`, so an
  `overrun_low` layer's window has to reach below that — otherwise the bottom
  of every stop falls back to the on-throttle loops.

Or just drive it and watch the `×` column in the *Layer mix* panel, and the
`OVERRUN` lamp, which should light while coasting in gear and stay dark in
neutral.

## Status

Steps 1–5 of the guide are implemented and Step 6 is in place. Not done yet:
gamepad/analog throttle (the input layer already goes through
`engine.setThrottle(0..1)`, so an axis drops straight in), and the 2D car
visualisation.
