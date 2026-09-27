# sounds/

Drop your own engine loops here. Nothing in this folder is required — every
layer falls back to a generated placeholder when its file is missing.

Suggested layout, matching the paths the `hot-hatch-i4` profile already looks
for:

```
sounds/
  i4/
    idle.wav        recorded around  900 rpm   on throttle
    low.wav                         1450 rpm   on throttle
    low_mid.wav                     2250 rpm   on throttle
    mid.wav                         3300 rpm   on throttle
    high_mid.wav                    4600 rpm   on throttle
    top.wav                         6200 rpm   on throttle
    overrun_low.wav                 2600 rpm   OFF throttle, coasting in gear
    overrun_high.wav                5500 rpm   OFF throttle, coasting in gear
```

## What makes a good loop

- **Seamless.** Cut on zero crossings, ideally on a whole number of firing
  cycles. A click in the loop becomes a rhythmic tick that rises with the revs
  and is impossible to ignore.
- **Mono** is fine and halves the memory; the app pans layers itself.
- **Short.** 0.4–1.0 s. Long loops waste memory and drift out of phase with the
  other layers.
- **Steady state only.** No rev-up, no fade in or out — the crossfading needs a
  constant load and a constant RPM.
- **Know the RPM it was recorded at** and put it in the layer's `baseRpm`. That
  value is what `playbackRate = rpm / baseRpm` is measured against, so if it is
  wrong the whole layer is transposed.
- **Space the layers about a factor 1.4–1.6 apart** in RPM, six or so bands
  across the rev range. Three bands means each one gets stretched about ±1
  octave, and above roughly ×1.25 a transposed engine recording stops sounding
  like an engine — it goes thin, and its exhaust resonances slide up with the
  pitch. Tight bands are the single most effective thing you can do for
  high-RPM realism.
- **Record off-throttle too, and at two RPMs.** A coasting engine is a
  different instrument, not a quieter one. That is what the `overrun_low` and
  `overrun_high` layers are for; their `loadCurve` fades them out as soon as
  you touch the throttle, and their `overrunCurve` keeps them silent when the
  engine is free-revving in neutral rather than being driven by the wheels.
  Two of them because a stop spans the whole rev range, and one loop cannot
  cover it inside the ×1.25 budget above. Coast **in gear** for these — lifting
  off in neutral gives you the wrong noise entirely.
- Anything the browser can decode works: `.wav`, `.flac`, `.ogg`, `.mp3`.
  Prefer uncompressed — MP3 adds encoder padding that breaks the loop.

Then point `soundconfig.json` at the files and reload. See the config reference
in the top-level `README.md`.
