/**
 * EnvelopeFollowerProcessor — the whole envelope filter, at audio rate.
 *
 * It used to track the envelope here and post a target frequency to the main
 * thread every ~10ms, which then nudged a BiquadFilterNode — so the sweep
 * lagged the pick and moved in steps. Now the follower drives the cutoff of a
 * resonant state-variable low-pass (Zavalishin's TPT form, stable under
 * audio-rate modulation) sample by sample, and the output is the filtered,
 * wet signal. EnvelopeFilter mixes it with the dry signal outside.
 *
 * Parameters (AudioParam, k-rate):
 *   sensitivity: how far a given pick level opens the filter (0–1)
 *   q:           resonance (0–1, mapped to Q ≈ 0.7–12)
 */

const MIN_FREQ = 250;
const MAX_FREQ = 3200;
const LOG_SPAN = Math.log(MAX_FREQ / MIN_FREQ);

class EnvelopeFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sensitivity', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'q', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._envelope = 0;
    this._ic1 = 0;
    this._ic2 = 0;
    this._k = null;
    this._flip = 1e-20;
    // Attack/release tuned for guitar dynamics: quick to open, a vocal "wow" closing.
    this._attackCoeff = 1 - Math.exp(-1 / (sampleRate * 0.003));
    this._releaseCoeff = 1 - Math.exp(-1 / (sampleRate * 0.09));
    this._smooth = 1 - Math.exp(-1 / (sampleRate * 0.02));
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      output.fill(0);
      return true;
    }

    const sensitivity = parameters.sensitivity[0];
    // A higher sensitivity needs less signal to sweep the filter open.
    const reach = 2 + sensitivity * 40;
    const kTarget = 1 / (0.7 + parameters.q[0] * 11.3);
    if (this._k === null) this._k = kTarget;
    const piOverRate = Math.PI / sampleRate;
    this._flip = -this._flip;

    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const a = x < 0 ? -x : x;
      this._envelope += (a - this._envelope) * (a > this._envelope ? this._attackCoeff : this._releaseCoeff);
      this._k += (kTarget - this._k) * this._smooth;

      // Exponential sweep: the envelope opens the filter by octaves, not hertz.
      const amount = 1 - Math.exp(-this._envelope * reach);
      const g = Math.tan(piOverRate * MIN_FREQ * Math.exp(LOG_SPAN * amount));
      const k = this._k;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v3 = x - this._ic2 + this._flip;
      const v1 = a1 * this._ic1 + a2 * v3;
      const v2 = this._ic2 + a2 * this._ic1 + a3 * v3;
      this._ic1 = 2 * v1 - this._ic1;
      this._ic2 = 2 * v2 - this._ic2;
      // Resonance piles energy up at the cutoff; pull the level back with it
      // so turning Q up does not also turn the pedal up.
      output[i] = v2 / (1 + 0.1 * (1 / k - 0.7));
    }

    return true;
  }
}

registerProcessor('envelope-follower-processor', EnvelopeFollowerProcessor);
