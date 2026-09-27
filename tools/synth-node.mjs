/* Runs js/synth.js outside the browser.
 *
 * The generator only ever needs two things from an AudioContext - a sample
 * rate and somewhere to put the samples - so a six-line shim is enough. That
 * lets the analyser render the app's own loops and check itself against a
 * known input, and lets you audition a layer without opening the page:
 *
 *     node tools/synth-node.mjs hot-hatch-i4 top out.wav
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { window: {}, Math: Math, Float64Array, Float32Array, Uint8Array };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'js', 'synth.js'), 'utf8'), sandbox);
const synth = sandbox.window.ES.synth;

/** Minimal stand-in for the parts of AudioContext the generator touches. */
export function fakeCtx(sampleRate = 48000) {
  return {
    sampleRate,
    createBuffer(channels, length, sr) {
      const data = [];
      for (let i = 0; i < channels; i++) data.push(new Float32Array(length));
      return { length, sampleRate: sr, numberOfChannels: channels, getChannelData: (i) => data[i] };
    }
  };
}

/** -> { samples: Float32Array, sampleRate, baseRpm } ("baseRpm" only for engine loops). */
export function render(spec, sampleRate = 48000) {
  const out = synth.make(fakeCtx(sampleRate), spec);
  const buffer = out.buffer || out;
  return {
    samples: buffer.getChannelData(0),
    sampleRate,
    baseRpm: out.baseRpm == null ? null : out.baseRpm
  };
}

/** 16-bit mono PCM WAV. */
export function writeWav(path, samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
  return path;
}

export function layerSpec(profileKey, layerId) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'soundconfig.json'), 'utf8'));
  const p = cfg.profiles[profileKey];
  if (!p) throw new Error('no such profile: ' + profileKey);
  const l = (p.layers || []).find((x) => x.id === layerId);
  if (!l) throw new Error('no such layer: ' + layerId);
  return l.generate;
}

if (process.argv[1] && process.argv[1].endsWith('synth-node.mjs')) {
  const [key, id, out] = process.argv.slice(2);
  if (!key || !id) {
    console.error('usage: node tools/synth-node.mjs <profile> <layer> [out.wav]');
    process.exit(1);
  }
  const r = render(layerSpec(key, id));
  console.log(`${key}/${id}: ${r.samples.length} samples @ ${r.sampleRate} Hz, baseRpm ${r.baseRpm?.toFixed(1)}`);
  if (out) console.log('wrote ' + writeWav(out, r.samples, r.sampleRate));
}
