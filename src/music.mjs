// A soft "music box" backing track generated from scratch: no files, no
// licences, different every time. Used when assets/music/ has no tracks and
// the config asks for generated music. Writes a 16-bit mono WAV.
import fs from "node:fs";

const RATE = 22050;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// C major pentatonic across two octaves for the melody; chords I V vi IV.
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81];
const CHORDS = [
  [48, 52, 55], // C
  [43, 47, 50], // G
  [45, 48, 52], // Am
  [41, 45, 48], // F
];

/** Adds a bell-like note (sine + harmonics, exponential decay) into `buf`. */
function bell(buf, startSec, hz, seconds, gain) {
  const start = Math.floor(startSec * RATE);
  const n = Math.min(buf.length - start, Math.floor(seconds * RATE));
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.exp(-t * 4.5) * Math.min(1, i / 60);
    const v = Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(2 * Math.PI * hz * 2 * t) + 0.12 * Math.sin(2 * Math.PI * hz * 3 * t);
    buf[start + i] += v * env * gain;
  }
}

/** Soft sustained pad note (triangle-ish) with slow attack and release. */
function pad(buf, startSec, hz, seconds, gain) {
  const start = Math.floor(startSec * RATE);
  const n = Math.min(buf.length - start, Math.floor(seconds * RATE));
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const a = Math.min(1, t / 0.25);
    const r = Math.min(1, (seconds - t) / 0.3);
    const ph = (hz * t) % 1;
    const tri = 4 * Math.abs(ph - 0.5) - 1;
    buf[start + i] += tri * a * r * gain;
  }
}

/**
 * Generates `seconds` of music and writes it to `outFile`.
 * tempo: beats per minute. seed: any integer for a different tune.
 */
export function generateMusic(outFile, { seconds = 40, tempo = 104, seed = Date.now() } = {}) {
  const rand = mulberry32(seed);
  const beat = 60 / tempo;
  const total = Math.ceil(seconds + 1);
  const buf = new Float64Array(total * RATE);

  let melodyIdx = 3; // start mid-range
  const bars = Math.ceil(total / (beat * 4));
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[bar % CHORDS.length];
    const barStart = bar * beat * 4;
    // Pad: the chord, quietly, for the bar.
    for (const m of chord) pad(buf, barStart, midiHz(m + 12), beat * 4, 0.045);
    // Bass: root on beats 1 and 3.
    bell(buf, barStart, midiHz(chord[0]), beat * 1.5, 0.16);
    bell(buf, barStart + beat * 2, midiHz(chord[0]), beat * 1.5, 0.12);
    // Melody: eighth notes, random walk on the pentatonic, occasional rests.
    for (let e = 0; e < 8; e++) {
      if (rand() < 0.22) continue;
      const stepChoices = [-2, -1, -1, 0, 1, 1, 2];
      melodyIdx = Math.max(0, Math.min(PENTA.length - 1, melodyIdx + stepChoices[Math.floor(rand() * stepChoices.length)]));
      // On the downbeat, pull towards a chord tone so it sounds "right".
      if (e === 0) {
        const tones = chord.map((m) => (m + 12) % 12);
        let best = melodyIdx;
        for (let k = 0; k < PENTA.length; k++) if (tones.includes(PENTA[k] % 12) && Math.abs(k - melodyIdx) < Math.abs(best - melodyIdx)) best = k;
        melodyIdx = best;
      }
      bell(buf, barStart + e * beat * 0.5, midiHz(PENTA[melodyIdx]), beat * 0.9, 0.22 + rand() * 0.06);
    }
  }

  // Fade out over the last second, then normalise to -3 dBFS.
  const fadeN = RATE;
  for (let i = 0; i < fadeN && i < buf.length; i++) buf[buf.length - 1 - i] *= i / fadeN;
  let peak = 1e-6;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const scale = 0.7 / peak;

  const pcm = Buffer.alloc(44 + buf.length * 2);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(36 + buf.length * 2, 4);
  pcm.write("WAVE", 8);
  pcm.write("fmt ", 12);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(RATE, 24);
  pcm.writeUInt32LE(RATE * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * scale)) * 32767), 44 + i * 2);
  fs.writeFileSync(outFile, pcm);
  return outFile;
}
