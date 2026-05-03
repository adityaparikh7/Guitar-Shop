/**
 * AudioStreamProcessor — AudioWorklet that receives PCM audio from the main thread
 * and outputs it to the Web Audio graph.
 *
 * Uses a pre-allocated ring buffer for low-latency, glitch-free playback.
 */

// Buffer must be large enough to hold the largest chunk Core Audio might send
// (typically up to 4096 samples) plus some headroom for jitter.
const RING_BUFFER_SIZE = 8192;

class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Pre-allocated ring buffer
    this._ringBuffer = new Float32Array(RING_BUFFER_SIZE);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._underrunCount = 0;
    this._totalFrames = 0;

    // Receive audio data from main thread
    this.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        this._writeToRing(event.data);
      } else if (event.data === 'reset') {
        this._writePos = 0;
        this._readPos = 0;
        this._bufferedSamples = 0;
      }
    };
  }

  _writeToRing(samples) {
    let len = samples.length;
    if (len === 0) return;

    const buf = this._ringBuffer;
    const size = RING_BUFFER_SIZE;

    // If incoming chunk is bigger than the entire buffer, only keep the tail
    if (len > size) {
      samples = samples.subarray(len - size);
      len = size;
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
    }

    // If adding this chunk would overflow, discard oldest data
    if (this._bufferedSamples + len > size) {
      const discard = (this._bufferedSamples + len) - size;
      this._readPos = (this._readPos + discard) % size;
      this._bufferedSamples = Math.max(0, this._bufferedSamples - discard);
    }

    // Write into ring buffer, handling wrap-around
    const wp = this._writePos;
    const spaceToEnd = size - wp;

    if (len <= spaceToEnd) {
      // Fits without wrapping
      buf.set(samples, wp);
    } else {
      // Wraps around: write what fits, then the rest at the start
      buf.set(samples.subarray(0, spaceToEnd), wp);
      buf.set(samples.subarray(spaceToEnd), 0);
    }

    this._writePos = (wp + len) % size;
    this._bufferedSamples += len;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const needed = channel.length; // 128 samples
    const buf = this._ringBuffer;
    const size = RING_BUFFER_SIZE;

    this._totalFrames++;

    if (this._bufferedSamples >= needed) {
      // Read from ring buffer
      const rp = this._readPos;
      const spaceToEnd = size - rp;

      if (needed <= spaceToEnd) {
        channel.set(buf.subarray(rp, rp + needed));
      } else {
        // Wraps around
        channel.set(buf.subarray(rp, rp + spaceToEnd));
        channel.set(buf.subarray(0, needed - spaceToEnd), spaceToEnd);
      }

      this._readPos = (rp + needed) % size;
      this._bufferedSamples -= needed;
    } else {
      // Buffer underrun — output silence
      channel.fill(0);
      this._underrunCount++;
    }

    // Copy mono to all output channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    // Report buffer health every ~2 seconds
    if (this._totalFrames % 750 === 0) {
      this.port.postMessage({
        type: 'health',
        buffered: this._bufferedSamples,
        capacity: RING_BUFFER_SIZE,
        underruns: this._underrunCount,
        fillPercent: Math.round((this._bufferedSamples / RING_BUFFER_SIZE) * 100)
      });
    }

    return true;
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
