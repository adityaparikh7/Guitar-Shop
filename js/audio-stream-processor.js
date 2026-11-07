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
 * The ring is sized generously (~340ms) so a large capture buffer can never
 * overrun it; latency is governed by MAX_BUFFERED_SAMPLES instead, which the
 * reader trims down to. That split matters: an undersized ring silently loses
 * audio, whereas trimming on the reader side is race-free because the reader
 * owns the read cursor.
 *
 * If the capture device runs at a different rate than the AudioContext, the
 * stream is resampled here with linear interpolation.
 */

// ─── Shared Constants (must match audio-engine.js) ──────────────────────────
// Control block layout (Int32Array indices into the control SAB):
//   [0] = writePos   (updated by main thread)
//   [1] = readPos    (updated by worklet)
//   [2] = capacity   (set once at init)
const CTRL_WRITE_POS = 0;
const CTRL_READ_POS = 1;
const CTRL_CAPACITY = 2;

// Ring capacity — headroom, not latency. ~340ms @ 48kHz.
const RING_BUFFER_SIZE = 16384;

// Starting defaults, used until the main thread reports how big the capture
// callbacks actually are. Both are then sized from that, because the real
// constraint is the capture cadence: audio that arrives in bursts of N samples
// cannot be played back continuously from a buffer smaller than N, no matter
// how low you would like the latency to be.
const PRE_FILL_THRESHOLD = 512;

// Upper bound on buffered audio. Anything beyond this is pure latency, so the
// reader skips ahead rather than letting it accumulate — which is what keeps a
// slightly fast capture clock from drifting into a long delay. Too small and it
// fights the capture burst size, trimming audio away and then starving.
const MAX_BUFFERED_SAMPLES = 2048;

class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this._useSAB = false;
    this._preFilled = false;
    this._underrunCount = 0;
    this._trimCount = 0;
    this._totalFrames = 0;

    // Resampling state — ratio of input samples consumed per output sample.
    this._ratio = 1;
    this._fracPos = 0;

    // Sized from the observed capture chunk once the main thread measures it.
    this._preFill = PRE_FILL_THRESHOLD;
    this._maxBuffered = MAX_BUFFERED_SAMPLES;

    // ── Always initialize postMessage fallback ring buffer ──
    this._ringBuffer = new Float32Array(RING_BUFFER_SIZE);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._capacity = RING_BUFFER_SIZE;

    const processorOptions = options?.processorOptions;
    this._debug = !!processorOptions?.debug;

    // ── Try to upgrade to SharedArrayBuffer mode ──
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

    if (processorOptions?.inputSampleRate) {
      this._setInputSampleRate(processorOptions.inputSampleRate);
    }

    // Receive audio data from main thread (fallback mode / control commands)
    this._postMsgCount = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data instanceof Float32Array) {
        if (!this._useSAB) {
          this._postMsgCount++;
          this._writeToRing(data);
        }
        // In SAB mode, main thread writes directly — ignore postMessage audio
      } else if (data === 'reset') {
        this._reset();
      } else if (data && data.type === 'config') {
        if (data.inputSampleRate) this._setInputSampleRate(data.inputSampleRate);
        if (typeof data.debug === 'boolean') this._debug = data.debug;
        if (data.preFill > 0) this._preFill = Math.min(data.preFill, this._capacity >> 2);
        if (data.maxBuffered > 0) this._maxBuffered = Math.min(data.maxBuffered, this._capacity >> 1);
      }
    };
  }

  _setInputSampleRate(rate) {
    // sampleRate is the AudioContext rate, a global in the AudioWorklet scope.
    const ratio = rate / sampleRate;
    // Ignore absurd values rather than destroying playback.
    this._ratio = (ratio > 0.25 && ratio < 4) ? ratio : 1;
    this._fracPos = 0;
  }

  _reset() {
    this._preFilled = false;
    this._underrunCount = 0;
    this._trimCount = 0;
    this._fracPos = 0;
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

  _readPosition() {
    return this._useSAB ? Atomics.load(this._control, CTRL_READ_POS) : this._readPos;
  }

  /** Move the read cursor forward by `count` samples. The reader owns it. */
  _advanceRead(count) {
    const rp = this._readPosition();
    const newRp = (rp + count) % this._capacity;
    if (this._useSAB) {
      Atomics.store(this._control, CTRL_READ_POS, newRp);
    } else {
      this._readPos = newRp;
      this._bufferedSamples -= count;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    const needed = channel.length; // 128 samples
    const buf = this._ringBuffer;
    const size = this._capacity;
    const ratio = this._ratio;
    const resampling = ratio !== 1;

    // Interpolation reads one sample past the last consumed one.
    const required = resampling ? Math.ceil(needed * ratio) + 2 : needed;

    this._totalFrames++;

    let available = this._available();

    // Wait for pre-fill before starting output (reduces initial latency jitter)
    if (!this._preFilled) {
      if (available >= Math.max(this._preFill, required)) {
        this._preFilled = true;
        this._fracPos = 0;
      } else {
        channel.fill(0);
        for (let ch = 1; ch < output.length; ch++) output[ch].fill(0);
        return true;
      }
    }

    // Keep latency bounded: drop the oldest audio rather than let the backlog grow.
    if (available > this._maxBuffered) {
      const skip = available - this._maxBuffered;
      this._advanceRead(skip);
      this._fracPos = 0;
      available -= skip;
      this._trimCount++;
    }

    if (available >= required) {
      const rp = this._readPosition();

      if (!resampling) {
        const spaceToEnd = size - rp;
        if (needed <= spaceToEnd) {
          channel.set(buf.subarray(rp, rp + needed));
        } else {
          channel.set(buf.subarray(rp, rp + spaceToEnd));
          channel.set(buf.subarray(0, needed - spaceToEnd), spaceToEnd);
        }
        this._advanceRead(needed);
      } else {
        // Linear interpolation resample from the capture rate to the context rate.
        let pos = this._fracPos;
        for (let i = 0; i < needed; i++) {
          const whole = Math.floor(pos);
          const t = pos - whole;
          const a = buf[(rp + whole) % size];
          const b = buf[(rp + whole + 1) % size];
          channel[i] = a + (b - a) * t;
          pos += ratio;
        }
        const consumed = Math.floor(pos);
        this._fracPos = pos - consumed;
        this._advanceRead(consumed);
      }
    } else {
      // Buffer underrun — output silence, request re-fill
      channel.fill(0);
      this._underrunCount++;
      this._preFilled = false; // wait for pre-fill again
      this._fracPos = 0;
    }

    // Copy mono to all output channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    // Report buffer health every ~2 seconds (debug builds only)
    if (this._debug && this._totalFrames % 750 === 0) {
      this.port.postMessage({
        type: 'health',
        buffered: available,
        capacity: size,
        underruns: this._underrunCount,
        trims: this._trimCount,
        fillPercent: Math.round((available / size) * 100),
        mode: this._useSAB ? 'sab' : 'postMessage',
        preFilled: this._preFilled,
        postMsgCount: this._postMsgCount,
        ratio: ratio,
        preFill: this._preFill,
        maxBuffered: this._maxBuffered,
      });
    }

    return true;
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
