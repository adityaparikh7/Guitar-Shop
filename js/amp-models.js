/**
 * Amp voicings and cabinet models for the built-in amp, plus the small DSP
 * helpers that turn a cabinet description into an impulse response.
 *
 * Adding a built-in amp or cab is one entry here — the UI lists both tables.
 */

/**
 * Built-in amp voices. Each describes the whole amp around the two
 * tube-stage-processor instances (js/amp-processor.js):
 *
 *   tight     high-pass ahead of the first stage, Hz — less flub into the gain
 *   hump      optional mid boost ahead of the first stage ({ freq, gain, q })
 *   bright    bright-cap shelf { freq, db } — full strength with Gain at 0,
 *             fading out as Gain comes up, as the real capacitor does
 *   pre       preamp stages (see createStage() in amp-processor.js)
 *   stack     tone-stack centres; mid sits at `midBase` dB with the knob at noon
 *   power     the power-amp stage
 *   depth     low resonance bump after the power amp { freq, gain, q }
 *   makeup    output trim, so the voices sit at roughly the same loudness
 *   defaultCab  cabinet a preset gets when it does not name one
 */
export const AMP_VOICES = {
  clean: {
    label: 'Clean — blackface',
    tight: 40,
    hump: null,
    bright: { freq: 2400, db: 4 },
    pre: [
      { type: 'triode', gain: [1.2, 7], bias: 0.18, neg: 1.8, block: 0.15, hp: 25, lp: 14000 },
      { type: 'triode', gain: [0.9, 2.2], bias: 0.12, neg: 1.6, block: 0.1, hp: 20, lp: 12000 },
    ],
    stack: { bass: 110, mid: 450, midQ: 0.7, midBase: -4.5, treble: 2600, range: 10 },
    power: { type: 'pushpull', gain: [1.1, 1.1], sag: 0.35, attack: 0.01, release: 0.15, hp: 35, lp: 14000 },
    depth: { freq: 100, gain: 1.5, q: 0.9 },
    makeup: 1.4,
    defaultCab: '2x12',
  },
  crunch: {
    label: 'Crunch — plexi',
    tight: 70,
    hump: null,
    bright: { freq: 2000, db: 3 },
    pre: [
      { type: 'triode', gain: [2, 14], bias: 0.22, neg: 1.6, block: 0.3, hp: 45, lp: 11000 },
      { type: 'triode', gain: [1.6, 7], bias: 0.15, neg: 1.5, block: 0.25, hp: 80, lp: 9000 },
    ],
    stack: { bass: 100, mid: 700, midQ: 0.8, midBase: -1.5, treble: 2200, range: 10 },
    power: { type: 'pushpull', gain: [1.6, 1.6], sag: 0.6, attack: 0.008, release: 0.2, hp: 45, lp: 12000 },
    depth: { freq: 95, gain: 2, q: 0.9 },
    makeup: 0.6,
    defaultCab: '4x12',
  },
  highgain: {
    label: 'High Gain — modern',
    tight: 140,
    hump: { freq: 850, gain: 6, q: 0.7 },
    bright: { freq: 2500, db: 1.5 },
    pre: [
      { type: 'triode', gain: [4, 24], bias: 0.25, neg: 1.5, block: 0.35, hp: 90, lp: 9000 },
      { type: 'triode', gain: [3, 12], bias: 0.18, neg: 1.4, block: 0.3, hp: 150, lp: 7000 },
      { type: 'triode', gain: [2, 5], bias: 0.12, neg: 1.4, block: 0.25, hp: 120, lp: 6500 },
    ],
    stack: { bass: 110, mid: 600, midQ: 0.8, midBase: -3, treble: 2400, range: 10 },
    power: { type: 'pushpull', gain: [1.4, 1.4], sag: 0.25, attack: 0.005, release: 0.1, hp: 60, lp: 12000 },
    depth: { freq: 90, gain: 3, q: 1.0 },
    makeup: 0.45,
    defaultCab: '4x12',
  },
};

export const DEFAULT_VOICE = 'clean';
export const DEFAULT_CAB = '4x12';

/**
 * Built-in cabinets as RBJ biquad cascades: a resonant low cut where the
 * speaker stops moving air, a low-mid box dip, the cone's upper-mid presence
 * peak, a breakup notch, and the steep roll-off above it. `reflection` is a
 * close mic's first bounce off the baffle — a faint comb in the top end.
 */
export const CAB_MODELS = {
  '4x12': {
    label: '4x12 Closed — V30',
    filters: [
      { type: 'highpass', freq: 72, q: 1.1 },
      { type: 'peaking', freq: 115, gain: 2.5, q: 1.2 },
      { type: 'peaking', freq: 450, gain: -2, q: 1.0 },
      { type: 'peaking', freq: 1500, gain: 1, q: 1.0 },
      { type: 'peaking', freq: 2600, gain: 3.5, q: 1.5 },
      { type: 'peaking', freq: 3900, gain: -4, q: 4 },
      { type: 'lowpass', freq: 4800, q: 0.8 },
      { type: 'lowpass', freq: 5800, q: 1.0 },
      { type: 'lowpass', freq: 7500, q: 0.7 },
    ],
    reflection: { delay: 0.00011, gain: 0.18 },
  },
  '2x12': {
    label: '2x12 Open — alnico blue',
    filters: [
      { type: 'highpass', freq: 85, q: 0.8 },
      { type: 'peaking', freq: 130, gain: 1.5, q: 1.0 },
      { type: 'peaking', freq: 600, gain: -1.5, q: 1.0 },
      { type: 'peaking', freq: 1800, gain: 2.5, q: 1.2 },
      { type: 'peaking', freq: 3200, gain: 1.5, q: 2 },
      { type: 'peaking', freq: 4400, gain: -4, q: 4 },
      { type: 'lowpass', freq: 5400, q: 0.8 },
      { type: 'lowpass', freq: 6400, q: 0.9 },
      { type: 'lowpass', freq: 8000, q: 0.7 },
    ],
    reflection: { delay: 0.00009, gain: 0.15 },
  },
  '1x12': {
    label: '1x12 Open — jensen',
    filters: [
      { type: 'highpass', freq: 95, q: 0.85 },
      { type: 'peaking', freq: 150, gain: 2, q: 1.2 },
      { type: 'peaking', freq: 700, gain: -2, q: 0.9 },
      { type: 'peaking', freq: 2200, gain: 2.5, q: 1.3 },
      { type: 'peaking', freq: 3600, gain: -3, q: 3 },
      { type: 'lowpass', freq: 5000, q: 0.8 },
      { type: 'lowpass', freq: 6000, q: 0.9 },
      { type: 'lowpass', freq: 7500, q: 0.7 },
    ],
    reflection: { delay: 0.0001, gain: 0.15 },
  },
};

// ─── DSP helpers ─────────────────────────────────────────────────────────────

/** RBJ Audio EQ Cookbook coefficients, normalized so a0 = 1. */
export function biquadCoefs({ type, freq, q = Math.SQRT1_2, gain = 0 }, sampleRate) {
  const w0 = 2 * Math.PI * Math.min(freq, sampleRate * 0.49) / sampleRate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const A = Math.pow(10, gain / 40);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
      b0 = A * ((A + 1) - (A - 1) * cos + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
      b0 = A * ((A + 1) + (A - 1) * cos + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - s;
      break;
    }
    default:
      return [1, 0, 0, 0, 0];
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Magnitude of a sampled impulse response at one frequency (direct DFT). */
export function irMagnitudeAt(samples, sampleRate, freq) {
  const w = 2 * Math.PI * freq / sampleRate;
  // Rotate a phasor rather than calling sin/cos per sample.
  const cw = Math.cos(w), sw = Math.sin(w);
  let re = 0, im = 0, pr = 1, pi = 0;
  for (let n = 0; n < samples.length; n++) {
    const x = samples[n];
    re += x * pr;
    im -= x * pi;
    const t = pr * cw - pi * sw;
    pi = pr * sw + pi * cw;
    pr = t;
  }
  return Math.hypot(re, im);
}

/**
 * Scale an impulse response so its average gain across the guitar's core
 * range (150Hz–3kHz, log-spaced) is 0dB. Swapping cabs then changes the tone
 * but not the volume. Works in place on the first channel's data.
 */
export function normalizeIR(samples, sampleRate) {
  const points = 24, lo = Math.log(150), hi = Math.log(3000);
  let sumDb = 0;
  for (let i = 0; i < points; i++) {
    const f = Math.exp(lo + (hi - lo) * i / (points - 1));
    sumDb += 20 * Math.log10(irMagnitudeAt(samples, sampleRate, f) + 1e-12);
  }
  const scale = Math.pow(10, -(sumDb / points) / 20);
  if (Number.isFinite(scale)) {
    for (let n = 0; n < samples.length; n++) samples[n] *= scale;
  }
  return samples;
}

/**
 * Render a built-in cabinet to an impulse response. Deterministic: the same
 * cab always produces the same buffer.
 * @returns {Float32Array}
 */
export function renderCabIR(sampleRate, spec, length = 4096) {
  const out = new Float64Array(length);
  out[0] = 1;
  for (const f of spec.filters) {
    const [b0, b1, b2, a1, a2] = biquadCoefs(f, sampleRate);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < length; n++) {
      const x = out[n];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[n] = y;
    }
  }
  if (spec.reflection) {
    const d = Math.max(1, Math.round(spec.reflection.delay * sampleRate));
    for (let n = length - 1; n >= d; n--) out[n] += spec.reflection.gain * out[n - d];
  }
  // Short raised-cosine fade so the truncation does not ring.
  const fade = Math.min(512, length >> 2);
  for (let i = 0; i < fade; i++) {
    out[length - fade + i] *= 0.5 * (1 + Math.cos(Math.PI * (i + 1) / fade));
  }
  return normalizeIR(Float32Array.from(out), sampleRate);
}
