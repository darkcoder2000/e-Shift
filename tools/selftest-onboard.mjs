/* A synthetic onboard lap with known answers, for the parts of
 * tools/analyse-sample.mjs that a steady loop cannot exercise: tracking RPM
 * through a sweep, finding the ignition cuts, telling throttle from overrun,
 * and pulling the resonances, the induction band and the gearbox whine back
 * out of the mix.
 *
 *     node tools/selftest-onboard.mjs [out.wav]
 *
 * It is also run by `analyse-sample.mjs --selftest`.
 *
 * The clip is built to look like real onboard audio rather than a clean test
 * tone, because the difference matters. An early version had nothing above
 * the last harmonic but dither: the spectrum fell off a cliff, and the
 * induction search locked onto that cliff edge every time. Every recording
 * of a car has wind and road noise up there, so the fixture has it too.
 */
import { analyse } from './analyse-sample.mjs';
import { writeWav } from './synth-node.mjs';

const SR = 48000;
const ORDER = 2;                               // four-cylinder four-stroke

export const TRUTH = {
  redline: 8400,
  ratioStep: 1.28,
  shifts: 5,
  formants: [240, 1150, 3100],
  intakeBase: 500, intakeRpm: 0.12,
  // Deliberately not a half-integer. A straight-cut gear runs at a shaft
  // speed unrelated to the crank, and that is the only reason it can be told
  // apart from the engine's own half-order content; an order of 11.5 would
  // be indistinguishable from it, and the analyser is right to reject one.
  whineOrder: 13.27
};

const RES = [
  { f: 240, q: 2.0, g: 2.5 }, { f: 1150, q: 3.0, g: 3.2 }, { f: 3100, q: 2.0, g: 2.0 }
];
function resonance(f) {
  let m = 1;
  for (const r of RES) {
    const x = f / r.f;
    m *= 1 + (r.g - 1) / (1 + Math.pow(r.q * (x - 1 / x) * 2, 2));
  }
  return m;
}

export function renderOnboard() {
  const DT = 1 / SR, LIFT_T = 15, END = 22;
  const rpmAt = [], cutAt = [], thrAt = [];
  let rpm = 3500, gear = 1, cut = 0;
  for (let t = 0; t < END; t += DT) {
    let onThrottle = t < LIFT_T;
    if (cut > 0) { cut -= DT; onThrottle = false; }
    else if (onThrottle && rpm >= TRUTH.redline && gear < 6) {
      rpm /= TRUTH.ratioStep; gear++; cut = 0.06;
    }
    if (cut > 0) rpm -= 900 * DT;
    else if (onThrottle) rpm = Math.min(TRUTH.redline, rpm + 2100 * DT);
    else rpm = Math.max(2600, rpm - 1250 * DT);
    rpmAt.push(rpm); cutAt.push(cut > 0 ? 0.12 : 1); thrAt.push(onThrottle ? 1 : 0);
  }

  const N = rpmAt.length, H = 22;
  const out = new Float32Array(N);
  const phase = new Float64Array(H + 1);
  let whinePhase = 0, lp = 0, bp = 0, pink = 0, pink2 = 0, rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

  for (let i = 0; i < N; i++) {
    const f0 = (rpmAt[i] / 60) * ORDER;
    let v = 0;
    for (let h = 1; h <= H; h++) {
      phase[h] += 2 * Math.PI * h * f0 * DT;
      const f = h * f0;
      if (f > 9000) continue;
      v += Math.pow(h, -1.1) * resonance(f) * Math.sin(phase[h]);
    }
    v *= cutAt[i];                                          // ignition cut

    whinePhase += 2 * Math.PI * (rpmAt[i] / 60) * TRUTH.whineOrder * DT;
    v += 0.1 * Math.sin(whinePhase) * resonance((rpmAt[i] / 60) * TRUTH.whineOrder);

    const fc = TRUTH.intakeBase + rpmAt[i] * TRUTH.intakeRpm;   // induction, on throttle only
    const n = rand(), k = 2 * Math.sin((Math.PI * fc) / SR);
    lp += k * bp; bp += k * (n - lp - 0.18 * bp);
    v += 2.2 * bp * thrAt[i] * cutAt[i];

    const wn = rand();                                      // wind and road, always present
    pink = 0.94 * pink + 0.06 * wn;
    pink2 = 0.7 * pink2 + 0.3 * wn;
    v += 0.55 * (pink * 2.2 + pink2 * 0.8 + wn * 0.35);

    out[i] = v * 0.04;
  }
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < N; i++) out[i] /= peak * 1.05;
  return { samples: out, sampleRate: SR };
}

export function runOnboardSelftest() {
  const { samples } = renderOnboard();
  const rep = analyse(samples, SR, { order: ORDER, rpmMin: 1500, rpmMax: 10000, bands: 6 });

  const results = [];
  const chk = (name, ok, detail) => {
    results.push(ok);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(24)} ${detail}`);
  };
  const near = (got, want, tol) => Math.abs(got - want) <= tol;

  console.log(`\nsynthetic onboard lap: ${rep.input.seconds} s, ${rep.input.analysed} frames\n`);
  chk('peak rpm', near(rep.rpm.max, TRUTH.redline, 250), `want ${TRUTH.redline}  got ${rep.rpm.max}`);
  chk('upshifts found', near(rep.shifts.count, TRUTH.shifts, 1), `want ${TRUTH.shifts}  got ${rep.shifts.count}`);
  chk('rpm at cut', near(rep.shifts.upshiftRpm ?? 0, TRUTH.redline, 400),
    `want ${TRUTH.redline}  got ${rep.shifts.upshiftRpm}`);
  chk('gear ratio step', near(rep.shifts.medianRatioStep ?? 0, TRUTH.ratioStep, 0.08),
    `want ${TRUTH.ratioStep}  got ${rep.shifts.medianRatioStep}`);
  chk('overrun section', rep.states.overrun > 30,
    `${rep.states.throttle} throttle / ${rep.states.overrun} overrun / ${rep.states.shift} shift`);

  for (const want of TRUTH.formants) {
    const hit = rep.formants.find((f) => Math.abs(Math.log2(f.freq / want)) < 0.25);
    chk(`formant ${want} Hz`, !!hit, hit ? `found at ${hit.freq} Hz (+${hit.gain} dB, Q ${hit.q})` : 'not found');
  }

  const wantIntake = TRUTH.intakeBase + rep.rpm.median * TRUTH.intakeRpm;
  chk('induction band', !!rep.intake && Math.abs(Math.log2(rep.intake.centreHz / wantIntake)) < 0.45,
    rep.intake
      ? `want ~${Math.round(wantIntake)} Hz at ${rep.rpm.median} rpm  got ${rep.intake.centreHz} Hz`
        + `  (x${rep.intake.onOverOverrun} on throttle)`
      : 'none found');
  if (rep.intake) {
    console.log('        per rev band: '
      + rep.intake.perBand.map((b) => `${b[0]}rpm/${b[1]}Hz`).join('  ')
      + `   (true ${TRUTH.intakeBase} + ${TRUTH.intakeRpm} x rpm)`);
  }

  const w = rep.whine.find((x) => Math.abs(x.order - TRUTH.whineOrder) < 0.6);
  chk('gear whine order', !!w, `want ${TRUTH.whineOrder}  got ${w ? w.order : 'none'}`);

  const fails = results.filter((x) => !x).length;
  console.log(`\n${fails ? fails + ' check(s) failed' : 'all onboard checks passed'}`
    + `  (${results.length} total)`);
  return fails;
}

if (process.argv[1] && /selftest-onboard\.mjs$/.test(process.argv[1])) {
  const out = process.argv[2];
  if (out) {
    const { samples, sampleRate } = renderOnboard();
    console.log('wrote ' + writeWav(out, samples, sampleRate));
  }
  process.exit(runOnboardSelftest() ? 1 : 0);
}
