/**
 * CompressorProcessor — a zero-latency feed-forward compressor.
 *
 * Not an ES module: it lives in the AudioWorkletGlobalScope and only calls
 * registerProcessor(). It replaces DynamicsCompressorNode, which in Chromium
 * delays the signal by a fixed 6ms of lookahead — far too much in front of an
 * amp you are playing through live.
 *
 * Gain reduction is computed per sample from the peak level through a soft
 * knee, then smoothed in the dB domain with separate attack and release (a
 * branching smoother, after Giannoulis, Massberg & Reiss). The detector hears
 * a high-passed copy of the input, so the low E does not pump the whole chord.
 * Makeup gain follows Chromium's own rule — (1 / gain at full scale)^0.6 — so
 * presets written for the old node keep roughly their loudness.
 *
 * Parameters (AudioParam, k-rate):
 *   threshold  dB
 *   ratio      n:1
 *   attack     seconds
 *   release    seconds
 */

const KNEE_DB = 12;
const SIDECHAIN_HP = 80;
const MAKEUP_EXPONENT = 0.6;
const LN10_OVER_20 = Math.LN10 / 20;

class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -24, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.003, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.25, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._hpA = Math.exp(-2 * Math.PI * SIDECHAIN_HP / sampleRate);
    this._hpX = 0;
    this._hpY = 0;
    this._reduction = 0; // smoothed gain reduction, dB (≥ 0)
    this._makeup = 0;    // dB, eased towards its target so a knob move does not step
    this._key = '';
  }

  /** Static curve: output level for an input level, both in dB. */
  _curve(level, threshold, ratio) {
    const over = level - threshold;
    if (2 * over < -KNEE_DB) return level;
    if (2 * over > KNEE_DB) return threshold + over / ratio;
    const k = over + KNEE_DB / 2;
    return level + (1 / ratio - 1) * k * k / (2 * KNEE_DB);
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      output.fill(0);
      return true;
    }

    const threshold = parameters.threshold[0];
    const ratio = Math.max(1, parameters.ratio[0]);
    const attack = Math.exp(-1 / (Math.max(0.0001, parameters.attack[0]) * sampleRate));
    const release = Math.exp(-1 / (Math.max(0.005, parameters.release[0]) * sampleRate));
    // Makeup only moves with threshold and ratio, so it is worked out per quantum.
    const makeupTarget = -MAKEUP_EXPONENT * this._curve(0, threshold, ratio);
    const ease = 1 - Math.exp(-input.length / (0.02 * sampleRate));
    this._makeup += (makeupTarget - this._makeup) * ease;
    const makeup = this._makeup;

    const hpA = this._hpA;
    let reduction = this._reduction;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const sc = hpA * (this._hpY + x - this._hpX);
      this._hpX = x;
      this._hpY = sc;
      const level = 20 * Math.log10(Math.abs(sc) + 1e-9);
      const target = level - this._curve(level, threshold, ratio);
      const coef = target > reduction ? attack : release;
      reduction = coef * reduction + (1 - coef) * target;
      output[i] = x * Math.exp((makeup - reduction) * LN10_OVER_20);
    }
    this._reduction = reduction;
    return true;
  }
}

registerProcessor('compressor-processor', CompressorProcessor);
