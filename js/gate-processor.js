/**
 * GateProcessor — AudioWorklet-based noise gate.
 *
 * Runs at audio rate (128 samples per quantum = ~2.6ms @ 48kHz) instead of
 * the previous requestAnimationFrame approach (~16ms). This eliminates the
 * main-thread polling overhead and provides 6x faster gate response.
 *
 * Parameters (AudioParam):
 *   threshold: Gate threshold in dB (default: -50)
 *
 * The gate uses a simple RMS measurement over each 128-sample quantum,
 * with smooth attack/release to avoid clicks.
 */

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._gain = 1.0;
    this._attackCoeff = 0.0;
    this._releaseCoeff = 0.0;
    this._sampleRate = sampleRate; // global in AudioWorklet scope
    // Smooth attack: ~1ms, release: ~5ms
    this._attackCoeff = 1.0 - Math.exp(-1.0 / (this._sampleRate * 0.001));
    this._releaseCoeff = 1.0 - Math.exp(-1.0 / (this._sampleRate * 0.005));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const inChannel = input[0];
    const outChannel = output[0];
    const threshold = parameters.threshold[0];
    const frameCount = inChannel.length;

    // Compute RMS of this quantum
    let sum = 0;
    for (let i = 0; i < frameCount; i++) {
      sum += inChannel[i] * inChannel[i];
    }
    const rms = Math.sqrt(sum / frameCount);
    const db = 20 * Math.log10(rms + 1e-10);

    // Target gain: 1 if above threshold, 0 if below
    const target = db > threshold ? 1.0 : 0.0;

    // Smooth the gain transition per-sample
    const coeff = target > this._gain ? this._attackCoeff : this._releaseCoeff;

    for (let i = 0; i < frameCount; i++) {
      this._gain += (target - this._gain) * coeff;
      outChannel[i] = inChannel[i] * this._gain;
    }

    // Copy to other channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(outChannel);
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
