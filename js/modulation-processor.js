/**
 * Modulation Processors — chorus, flanger and phaser at sample level.
 *
 * Not an ES module: it lives in the AudioWorkletGlobalScope and only calls
 * registerProcessor(). All three were native-node graphs once, and all three
 * suffered for it: a DelayNode or biquad inside a feedback cycle is given a
 * forced 128-sample (2.7ms) delay, so the flanger could never sweep below
 * 2.7ms and the phaser's "feedback" was really a comb filter at ~375Hz. Here
 * the feedback is one sample, delays are read with 4-point Hermite
 * interpolation, and sweeps are exponential, the way the ear hears pitch.
 *
 * Each processor is mono in, mono out, mixes dry and wet itself, and smooths
 * its k-rate parameters internally. The mix is equal-power: a straight
 * (1 − mix, mix) blend lost ~5dB on a chorus, whose wet signal is largely
 * decorrelated from the dry, and both laws give the equal amplitudes at the
 * midpoint that a flanger or phaser needs for full-depth notches.
 *
 * Parameters (AudioParam, k-rate):
 *   rate      LFO rate, Hz
 *   depth     sweep depth, 0–1
 *   feedback  0–1 (flanger, phaser)
 *   mix       wet share, 0–1 (equal-power)
 */

const TWO_PI = 2 * Math.PI;

// Keeps recursive filter state away from denormals when the input is silent.
// It alternates sign, so it adds no DC.
const ANTI_DENORMAL = 1e-20;

// Parameter changes glide over ~20ms.
const PARAM_SMOOTH = 1 - Math.exp(-1 / (0.02 * sampleRate));

const onePoleLP = (hz) => 1 - Math.exp(-TWO_PI * hz / sampleRate);
const onePoleHP = (hz) => Math.exp(-TWO_PI * hz / sampleRate);

/** A power-of-two circular delay line read with 4-point Hermite interpolation. */
class DelayLine {
  constructor(maxSeconds) {
    let size = 1;
    while (size < maxSeconds * sampleRate + 8) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.w = 0;
  }

  /** The signal `d` samples ago (d ≥ 3), read before this sample is written. */
  read(d) {
    const pos = this.w - d;
    const i = Math.floor(pos);
    const f = pos - i;
    const b = this.buf, m = this.mask;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  write(x) {
    this.buf[this.w & this.mask] = x;
    this.w++;
  }

  clear() { this.buf.fill(0); }
}

/** Shared parameter plumbing: smoothed copies of the k-rate params. */
class ModulationProcessor extends AudioWorkletProcessor {
  constructor(names) {
    super();
    this._names = names;
    this._smoothed = null;
    this._phase = 0;
    // Whether the last quantum had no input — the pedal was bypassed, so the
    // delay lines hold stale audio that must not leak out on the next press.
    this._idle = true;
    this._flip = ANTI_DENORMAL;
  }

  /** Snap the smoothed values to the params on the first quantum. */
  _targets(parameters) {
    if (!this._smoothed) {
      this._smoothed = {};
      for (const n of this._names) this._smoothed[n] = parameters[n][0];
    }
  }

  /** Equal-power dry and wet gains for a mix position, into this._dry / this._wet. */
  _mixGains(mix) {
    this._dry = Math.cos(mix * Math.PI / 2);
    this._wet = Math.sin(mix * Math.PI / 2);
  }

  _glide(name, target) {
    const s = this._smoothed;
    s[name] += (target - s[name]) * PARAM_SMOOTH;
    return s[name];
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      output.fill(0);
      this._idle = true;
      return true;
    }
    if (this._idle) {
      this.reset();
      this._idle = false;
    }
    this._flip = -this._flip;
    this._targets(parameters);
    this.render(input, output, parameters);
    return true;
  }
}

/**
 * Chorus — two BBD-style voices on LFOs half a cycle apart, at slightly
 * different base delays so they never settle into one static comb. The wet
 * signal is high-passed (no bass warble) and darkened like a bucket brigade.
 */
class ChorusProcessor extends ModulationProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 1.5, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super(['rate', 'depth', 'mix']);
    this._line = new DelayLine(0.05);
    this._baseA = 0.0068 * sampleRate;
    this._baseB = 0.0084 * sampleRate;
    this._sweep = 0.0026 * sampleRate; // ±2.6ms at full depth
    this._lpA = onePoleLP(7000);
    this._hpA = onePoleHP(120);
    this.reset();
  }

  reset() {
    this._line.clear();
    this._lp1 = 0; this._lp2 = 0;
    this._hpX = 0; this._hpY = 0;
  }

  render(input, output, parameters) {
    const line = this._line, lpA = this._lpA, hpA = this._hpA;
    const inc = Math.max(0, parameters.rate[0]) / sampleRate;
    const depthT = parameters.depth[0], mixT = parameters.mix[0];
    for (let i = 0; i < input.length; i++) {
      const depth = this._glide('depth', depthT);
      const mix = this._glide('mix', mixT);
      this._phase += inc;
      if (this._phase >= 1) this._phase -= 1;
      const swing = this._sweep * depth;
      const a = line.read(this._baseA + swing * Math.sin(TWO_PI * this._phase));
      const b = line.read(this._baseB + swing * Math.sin(TWO_PI * (this._phase + 0.5)));
      const x = input[i];
      line.write(x);
      // Bucket-brigade darkening (two poles), then the bass cut.
      this._lp1 += (0.5 * (a + b) + this._flip - this._lp1) * lpA;
      this._lp2 += (this._lp1 - this._lp2) * lpA;
      const hp = hpA * (this._hpY + this._lp2 - this._hpX);
      this._hpX = this._lp2;
      this._hpY = hp;
      this._mixGains(mix);
      output[i] = x * this._dry + hp * this._wet;
    }
  }
}

/**
 * Flanger — a short delay swept exponentially from ~0.2ms up to ~7ms by a
 * softened triangle, with sample-level feedback. The feedback term goes
 * through tanh, so the loop is linear at playing levels and saturates rather
 * than running away when Feedback is maxed.
 */
class FlangerProcessor extends ModulationProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.5, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.97, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super(['rate', 'depth', 'feedback', 'mix']);
    this._line = new DelayLine(0.02);
    this._minDelay = Math.max(3, 0.0002 * sampleRate);
    this._maxDelay = 0.007 * sampleRate;
    this.reset();
  }

  reset() {
    this._line.clear();
  }

  render(input, output, parameters) {
    const line = this._line, lo = this._minDelay;
    const inc = Math.max(0, parameters.rate[0]) / sampleRate;
    const depthT = parameters.depth[0], fbT = parameters.feedback[0], mixT = parameters.mix[0];
    for (let i = 0; i < input.length; i++) {
      const depth = this._glide('depth', depthT);
      const fb = this._glide('feedback', fbT);
      const mix = this._glide('mix', mixT);
      this._phase += inc;
      if (this._phase >= 1) this._phase -= 1;
      // Triangle, rounded at the turnarounds so the sweep never "bounces".
      const tri = 1 - 4 * Math.abs(this._phase - 0.5);
      const lfo = 0.5 + 0.5 * Math.sin(0.5 * Math.PI * tri);
      const hi = lo + (this._maxDelay - lo) * depth;
      const wet = line.read(lo * Math.pow(hi / lo, lfo));
      const x = input[i];
      line.write(x + Math.tanh(fb * wet));
      this._mixGains(mix);
      output[i] = x * this._dry + wet * this._wet;
    }
  }
}

/**
 * Phaser — four first-order allpass stages, all at the same frequency like a
 * four-JFET Phase 90, swept exponentially around ~700Hz (about 140Hz–3.5kHz at
 * full depth). Feedback comes back from the last stage one sample later, which
 * gives the resonant "colour" of a Small Stone rather than a comb.
 */
class PhaserProcessor extends ModulationProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.5, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.9, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super(['rate', 'depth', 'feedback', 'mix']);
    this._x = new Float64Array(4);
    this._y = new Float64Array(4);
    this._centre = 700;
    this._span = Math.log(5);
    this.reset();
  }

  reset() {
    this._x.fill(0);
    this._y.fill(0);
    this._last = 0;
  }

  render(input, output, parameters) {
    const xs = this._x, ys = this._y;
    const inc = Math.max(0, parameters.rate[0]) / sampleRate;
    const depthT = parameters.depth[0], fbT = parameters.feedback[0], mixT = parameters.mix[0];
    const k = Math.PI / sampleRate;
    for (let i = 0; i < input.length; i++) {
      const depth = this._glide('depth', depthT);
      const fb = this._glide('feedback', fbT);
      const mix = this._glide('mix', mixT);
      this._phase += inc;
      if (this._phase >= 1) this._phase -= 1;
      const freq = this._centre * Math.exp(this._span * depth * Math.sin(TWO_PI * this._phase));
      const t = Math.tan(k * freq);
      const a = (t - 1) / (t + 1);
      const x = input[i];
      let s = x + fb * this._last + this._flip;
      for (let n = 0; n < 4; n++) {
        const y = a * s + xs[n] - a * ys[n];
        xs[n] = s;
        ys[n] = y;
        s = y;
      }
      this._last = s;
      this._mixGains(mix);
      output[i] = x * this._dry + s * this._wet;
    }
  }
}

registerProcessor('chorus-processor', ChorusProcessor);
registerProcessor('flanger-processor', FlangerProcessor);
registerProcessor('phaser-processor', PhaserProcessor);
