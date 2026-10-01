/**
 * EnvelopeFollowerProcessor — AudioWorklet-based envelope filter.
 *
 * Runs the envelope follower at audio rate (128 samples per quantum = ~2.6ms
 * @ 48kHz) instead of the previous requestAnimationFrame approach (~16ms).
 *
 * The processor tracks the input envelope and modulates a filter frequency
 * parameter that is sent back to the main thread via port.postMessage.
 * The main thread applies this to a BiquadFilterNode's frequency AudioParam.
 *
 * Parameters (AudioParam):
 *   sensitivity: Envelope sensitivity multiplier (default: 0.5, range 0–1)
 *
 * Output messages:
 *   { type: 'envelope', frequency: <number> } — target filter frequency in Hz
 */

class EnvelopeFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sensitivity', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._envelope = 0;
    this._lastFreq = 0;
    this._frameCounter = 0;
    // Attack/release coefficients tuned for guitar dynamics
    this._attackCoeff = 1.0 - Math.exp(-1.0 / (sampleRate * 0.002));  // 2ms attack
    this._releaseCoeff = 1.0 - Math.exp(-1.0 / (sampleRate * 0.020)); // 20ms release
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const inChannel = input[0];
    const outChannel = output?.[0];
    const sensitivity = parameters.sensitivity[0];
    const frameCount = inChannel.length;

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < frameCount; i++) {
      sum += inChannel[i] * inChannel[i];
    }
    const rms = Math.sqrt(sum / frameCount);

    // Smooth envelope follower
    const coeff = rms > this._envelope ? this._attackCoeff : this._releaseCoeff;
    this._envelope += (rms - this._envelope) * coeff;

    // Map envelope to filter frequency
    const baseFreq = 300;
    const maxFreq = 3500;
    const envVal = Math.min(1, this._envelope * (sensitivity * 10 + 1));
    const targetFreq = baseFreq + envVal * (maxFreq - baseFreq);

    // Pass audio through (dry path — the main thread handles wet/dry mixing)
    if (outChannel) {
      outChannel.set(inChannel);
      for (let ch = 1; ch < output.length; ch++) {
        output[ch].set(inChannel);
      }
    }

    // Send frequency update to main thread every 4 quanta (~10ms) to avoid flooding
    this._frameCounter++;
    if (this._frameCounter >= 4) {
      this._frameCounter = 0;
      // Only send if frequency changed significantly (>5Hz)
      if (Math.abs(targetFreq - this._lastFreq) > 5) {
        this.port.postMessage({ type: 'envelope', frequency: targetFreq });
        this._lastFreq = targetFreq;
      }
    }

    return true;
  }
}

registerProcessor('envelope-follower-processor', EnvelopeFollowerProcessor);
