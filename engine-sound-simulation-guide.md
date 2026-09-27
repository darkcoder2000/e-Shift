# Project: EV Engine Sound Simulation (like Hyundai N e-Shift / e-Sound)

## Goal

A web app that simulates the driving feel of a combustion engine — including engine sound, a rev counter, and virtual gear shifting — even though there's no real engine behind it. Inspired by: Hyundai N e-Shift / N Active Sound in the Ioniq 5 N.

**Phase 1:** Get the basic framework running with existing/placeholder sounds.
**Phase 2:** Integrate custom sound samples and fine-tune.

---

## Tech Stack

- **Plain HTML/JS + Web Audio API** (no framework needed, runs in the browser, platform-independent on Windows)
- No backend required — everything runs client-side
- Controls initially via keyboard (later optionally Gamepad API for a real gas pedal/controller)

---

## Core Principle

No real engine is calculated. Instead:

1. A **virtual RPM value** (engine speed) is driven up and down via throttle input, with inertia (acceleration/deceleration instead of jumps).
2. Multiple **loop samples** of the same engine at different load states (e.g. idle / partial load / full load) are pitch-shifted via `playbackRate` depending on current RPM and cross-faded together.
3. A **virtual gear system** limits RPM per gear (e.g. shift point at 6500 RPM) and simulates a brief RPM drop + sound jolt when shifting.

---

## Step-by-Step Plan for Claude Code

### Step 1: Basic Framework
- Create an `index.html` with a canvas or simple UI: rev counter (needle or bar), current gear, speed (fictional).
- Create `engine.js`: state machine for RPM, gear, throttle position (0–100%).
- Controls: holding a key = giving gas (RPM rises), releasing = RPM drops (engine braking simulation).

### Step 2: Audio Engine with One Sample
- Web Audio API: `AudioContext`, one looping `AudioBufferSourceNode`.
- Load a placeholder loop sample (e.g. a generic engine loop, mono, a few seconds, seamlessly loopable).
- Couple `playbackRate` linearly/exponentially to the RPM value (e.g. `playbackRate = rpm / baseRpm`).
- Couple volume (`GainNode`) to throttle position.

### Step 3: Mixing Multiple Load States
- Load 2–3 samples: e.g. `idle.wav` (idle), `mid_load.wav` (partial load), `full_load.wav` (full load).
- Loop all three simultaneously, but cross-fade their `Gain` values against each other based on throttle position (0% throttle = only idle audible, 100% throttle = only full_load audible).
- All three samples get the same `playbackRate`, coupled to RPM, so they stay in sync.

### Step 4: Simulating Gear Shifts
- Define e.g. 6–8 virtual gears, each with its own RPM range (e.g. Gear 1: 0–7000 RPM maps to 0–30 km/h, Gear 2: 0–7000 RPM maps to 30–60 km/h, etc. — purely fictional, no real physics needed).
- When the shift RPM is reached (e.g. 6500 RPM):
  - RPM briefly drops (e.g. to 3500 RPM),
  - play a short sound cut or "clunk" sample,
  - increment the gear counter.
- Optional: manual shifting via keys (e.g. arrow up/down) in addition to automatic shifting.

### Step 5: Refine the UI
- Analog or digital rev counter with redline display.
- Gear indicator.
- Optional: a simple "speed" counter that ticks up, purely cosmetic.

### Step 6: Integrate Custom Sounds (Phase 2)
- Create a `/sounds/` folder with swappable WAV files.
- Create a config file (e.g. `soundconfig.json`) that defines, per "sound profile," the paths to the idle/mid/full samples plus base values (base pitch, loop points).
- Goal: sound profiles should be swappable without touching the code — just drop in new WAV files and adjust the config.

---

## Important Technical Notes for Claude Code

- **Seamless loops are essential:** samples must loop click-free (loop points exactly at zero crossings). Simple test loops are fine for Phase 1.
- **Keep `playbackRate` within a sensible range:** overly extreme pitch shifts (e.g. >2x or <0.5x) sound unrealistic — consider using multiple samples for different RPM bands instead of pitching a single sample across the whole range.
- **Only start the Web Audio Context after user interaction** (browser autoplay policy — e.g. call `AudioContext.resume()` on first keypress).
- **Don't forget inertia/smoothing:** RPM changes shouldn't be abrupt, but smoothly interpolated (e.g. via `requestAnimationFrame`), otherwise it feels unnatural.

---

## Ideas for Later Extension

- Gamepad support for a real gas-pedal feel (analog input instead of binary)
- Multiple selectable sound profiles (e.g. "turbo hot hatch," "V8," "sci-fi e-sound" like Hyundai's)
- Export/import custom sound profiles as JSON
- Simple 2D visualization (a car that moves) as a bonus

---

## Initial Prompt for Claude Code

> Build me a web app (HTML/JS, Web Audio API) that simulates an engine sound with virtual gear shifting, like in the Hyundai Ioniq 5 N (N e-Shift / N Active Sound). First implement Steps 1–5 from the guide, using placeholder audio files (short, self-generated sine/sawtooth loops are fine for testing). After that, let's prepare Step 6 so I can integrate my own sound samples.
