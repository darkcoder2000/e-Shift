# sounds/

Drop your own engine loops here. Nothing in this folder is required — every
layer falls back to a generated placeholder when its file is missing.

Suggested layout, matching the paths the `hot-hatch-i4` profile already looks
for:

```
sounds/
  i4/
    idle.wav        recorded around  950 rpm
    mid_load.wav    recorded around 3000 rpm
    full_load.wav   recorded around 5600 rpm
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
- **Space the layers about an octave apart** in RPM (e.g. 950 / 3000 / 5600).
  Each one then only ever gets pitched roughly ±1 octave, which is where sample
  pitch-shifting still sounds like an engine.
- Anything the browser can decode works: `.wav`, `.flac`, `.ogg`, `.mp3`.
  Prefer uncompressed — MP3 adds encoder padding that breaks the loop.

Then point `soundconfig.json` at the files and reload. See the config reference
in the top-level `README.md`.
