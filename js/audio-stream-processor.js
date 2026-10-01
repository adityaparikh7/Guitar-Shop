/**
 * AudioStreamProcessor — AudioWorklet that receives PCM audio from the main thread
 * and outputs it to the Web Audio graph.
 *
 * Supports two transport modes:
 *   1. **SharedArrayBuffer** (primary) — Lock-free ring buffer using Atomics.
 *      Main thread writes directly into shared memory; zero-copy, zero-GC.
 *   2. **postMessage** (fallback) — Copies Float32Array per message.
 *      Used when SharedArrayBuffer is unavailable (missing COOP/COEP headers).
 *
 * Ring buffer is sized to ~42ms @ 48kHz (2048 samples) for low latency.
 * Audio output starts only after a pre-fill threshold is reached (~10ms).
 */

// ─── Shared Constants (must match audio-engine.js) ──────────────────────────
// Control block layout (Int32Array indices into the control SAB):
//   [0] = writePos   (updated by main thread)
//   [1] = readPos    (updated by worklet)
//   [2] = capacity   (set once at init)
const CTRL_WRITE_POS = 0;
const CTRL_READ_POS = 1;
const CTRL_CAPACITY = 2;

// Fallback ring buffer size (also used as default SAB size)
const RING_BUFFER_SIZE = 2048;

// Don't start outputting until we have this many samples buffered.
// ~10ms @ 48kHz — enough to absorb jitter without adding perceptible latency.
const PRE_FILL_THRESHOLD = 512;

class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this._useSAB = false;
    this._preFilled = false;
    this._underrunCount = 0;
    this._totalFrames = 0;

    // ── Always initialize postMessage fallback ring buffer ──
    this._ringBuffer = new Float32Array(RING_BUFFER_SIZE);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._capacity = RING_BUFFER_SIZE;

    // ── Try to upgrade to SharedArrayBuffer mode ──
    const processorOptions = options?.processorOptions;
    if (typeof SharedArrayBuffer !== 'undefined' &&
        processorOptions?.ringBufferSAB instanceof SharedArrayBuffer &&
        processorOptions?.controlSAB instanceof SharedArrayBuffer) {
      const control = new Int32Array(processorOptions.controlSAB);
      const capacity = Atomics.load(control, CTRL_CAPACITY);
      if (capacity > 0) {
        this._ringBuffer = new Float32Array(processorOptions.ringBufferSAB);
        this._control = control;
        this._capacity = capacity;
        this._useSAB = true;
      }
    }

    // Receive audio data from main thread (fallback mode / reset commands)
    this._postMsgCount = 0;
    this.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        if (!this._useSAB) {
          this._postMsgCount++;
          this._writeToRing(event.data);
        }
        // In SAB mode, main thread writes directly — ignore postMessage audio
      } else if (event.data === 'reset') {
        this._reset();
      }
    };
  }

  _reset() {
    this._preFilled = false;
    this._underrunCount = 0;
    if (this._useSAB) {
      Atomics.store(this._control, CTRL_READ_POS, Atomics.load(this._control, CTRL_WRITE_POS));
    } else {
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
    }
  }

  // ── Fallback: postMessage ring buffer write ──
  _writeToRing(samples) {
    let len = samples.length;
    if (len === 0) return;

    const buf = this._ringBuffer;
    const size = this._capacity;

    if (len > size) {
      samples = samples.subarray(len - size);
      len = size;
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
    }

    // Discard oldest data if overflow
    if (this._bufferedSamples + len > size) {
      const discard = (this._bufferedSamples + len) - size;
      this._readPos = (this._readPos + discard) % size;
      this._bufferedSamples = Math.max(0, this._bufferedSamples - discard);
    }

    const wp = this._writePos;
    const spaceToEnd = size - wp;

    if (len <= spaceToEnd) {
      buf.set(samples, wp);
    } else {
      buf.set(samples.subarray(0, spaceToEnd), wp);
      buf.set(samples.subarray(spaceToEnd), 0);
    }

    this._writePos = (wp + len) % size;
    this._bufferedSamples += len;
  }

  // ── Compute available samples ──
  _available() {
    if (this._useSAB) {
      const wp = Atomics.load(this._control, CTRL_WRITE_POS);
      const rp = Atomics.load(this._control, CTRL_READ_POS);
      return (wp - rp + this._capacity) % this._capacity;
    } else {
      return this._bufferedSamples;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const needed = channel.length; // 128 samples
    const buf = this._ringBuffer;
    const size = this._capacity;

    this._totalFrames++;

    const available = this._available();

    // Wait for pre-fill before starting output (reduces initial latency jitter)
    if (!this._preFilled) {
      if (available >= PRE_FILL_THRESHOLD) {
        this._preFilled = true;
      } else {
        channel.fill(0);
        for (let ch = 1; ch < output.length; ch++) output[ch].fill(0);
        return true;
      }
    }

    if (available >= needed) {
      let rp;
      if (this._useSAB) {
        rp = Atomics.load(this._control, CTRL_READ_POS);
      } else {
        rp = this._readPos;
      }

      const spaceToEnd = size - rp;

      if (needed <= spaceToEnd) {
        channel.set(buf.subarray(rp, rp + needed));
      } else {
        channel.set(buf.subarray(rp, rp + spaceToEnd));
        channel.set(buf.subarray(0, needed - spaceToEnd), spaceToEnd);
      }

      const newRp = (rp + needed) % size;
      if (this._useSAB) {
        Atomics.store(this._control, CTRL_READ_POS, newRp);
      } else {
        this._readPos = newRp;
        this._bufferedSamples -= needed;
      }
    } else {
      // Buffer underrun — output silence, request re-fill
      channel.fill(0);
      this._underrunCount++;
      this._preFilled = false; // wait for pre-fill again
    }

    // Copy mono to all output channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    // Report buffer health every ~2 seconds
    if (this._totalFrames % 750 === 0) {
      this.port.postMessage({
        type: 'health',
        buffered: available,
        capacity: size,
        underruns: this._underrunCount,
        fillPercent: Math.round((available / size) * 100),
        mode: this._useSAB ? 'sab' : 'postMessage',
        preFilled: this._preFilled,
        postMsgCount: this._postMsgCount,
      });
    }

    return true;
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
