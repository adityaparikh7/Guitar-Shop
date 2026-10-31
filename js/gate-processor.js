/**
 * GateProcessor — AudioWorklet-based noise gate.
 *
 * Runs per sample, so it opens within a millisecond of the pick rather than at
 * the next render quantum. A gate that opens and shuts on the same level, with
 * a short release, chatters on every decaying note and chops the tail off; so
 * this one has:
 *
 *   - a peak detector with a short (10ms) release, so the level it sees is
 *     smooth but still catches the attack;
 *   - hysteresis: it opens at the threshold and only closes 6dB below it;
 *   - a hold of 50ms after the level drops below the close point;
 *   - a fast (~0.5ms) open and a gentle (~100ms) exponential fade when it closes.
 *
 * Parameters (AudioParam):
 *   threshold: Gate threshold in dB (default: -50)
 */

const HYSTERESIS_DB = 6;
const HOLD_SECONDS = 0.05;

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._gain = 0;
    this._env = 0;
    this._open = false;
    this._hold = 0;
    this._holdSamples = Math.round(HOLD_SECONDS * sampleRate);
    this._detectorRelease = Math.exp(-1 / (0.01 * sampleRate));
    this._attackCoeff = 1 - Math.exp(-1 / (0.0005 * sampleRate));
    this._releaseCoeff = 1 - Math.exp(-1 / (0.1 * sampleRate));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const inChannel = input[0];
    const outChannel = output[0];
    const threshold = parameters.threshold[0];
    const openLevel = Math.pow(10, threshold / 20);
    const closeLevel = Math.pow(10, (threshold - HYSTERESIS_DB) / 20);
    const frameCount = inChannel.length;

    for (let i = 0; i < frameCount; i++) {
      const x = inChannel[i];
      const a = x < 0 ? -x : x;
      this._env = a > this._env ? a : this._env * this._detectorRelease;

      if (this._env >= openLevel) {
        this._open = true;
        this._hold = this._holdSamples;
      } else if (this._open) {
        if (this._env >= closeLevel) {
          this._hold = this._holdSamples;
        } else if (this._hold > 0) {
          this._hold--;
        } else {
          this._open = false;
        }
      }

      const target = this._open ? 1 : 0;
      this._gain += (target - this._gain) * (this._open ? this._attackCoeff : this._releaseCoeff);
      outChannel[i] = x * this._gain;
    }

    // Copy to other channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(outChannel);
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
