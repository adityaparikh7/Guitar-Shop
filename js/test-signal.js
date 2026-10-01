/**
 * TestSignal — Offline signal source for testing the chain without a guitar.
 *
 * Two kinds of material:
 *   1. **Generated** — plucked-string (Karplus-Strong) riffs, chords and
 *      dynamics tests, plus sweeps/noise/clicks for tone and timing work.
 *      Rendered once into an AudioBuffer and cached.
 *   2. **File** — any audio file the user drops in, decoded to an AudioBuffer.
 *
 * The buffer plays through a level GainNode which the engine patches in where
 * a live input would normally sit, so the signal passes through the full
 * pedalboard → amp → cab chain exactly like a real pickup would.
 */

// ─── Note helpers ─────────────────────────────────────────────────────

const SEMITONES = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/**
 * Convert a note name like 'E2' or 'G#3' to its frequency in Hz.
 * @param {string} name
 * @returns {number}
 */
function noteFreq(name) {
  const match = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`Bad note name: ${name}`);
  const midi = (parseInt(match[2], 10) + 1) * 12 + SEMITONES[match[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ─── Signal catalogue ─────────────────────────────────────────────────

/**
 * Each entry: label (for the picker) and hint (what it is useful for).
 * The `render` function writes mono samples into `out` at `sampleRate`.
 */
export const TEST_SIGNALS = {
  'single-notes': {
    label: 'Single Notes — clean plucks',
    hint: 'Open-string plucks low to high. Good first check for delay, reverb and overall tone.',
    duration: 6.6,
  },
  'power-chords': {
    label: 'Power Chords — palm muted',
    hint: 'Palm-muted E5/G5/A5 eighths at 100bpm. Good for drive, distortion, gate and compressor.',
    duration: 6.0,
  },
  'open-chord': {
    label: 'Open Chord — strummed E',
    hint: 'Two slow strums of open E, down then up. Good for chorus, flanger, phaser and reverb.',
    duration: 7.0,
  },
  'arpeggio': {
    label: 'Arpeggio — clean Am',
    hint: 'Sustained Am arpeggio. Good for delay feedback, modulation depth and reverb tails.',
    duration: 6.0,
  },
  'dynamics': {
    label: 'Dynamics — soft to loud',
    hint: 'Plucks ramping from very soft to full force. Good for compressor, gate and envelope filter.',
    duration: 7.0,
  },
  'sweep': {
    label: 'Sine Sweep — 40Hz to 8kHz',
    hint: 'Log sweep across the guitar range. Good for EQ curves, amp tone stack and cabinet IRs.',
    duration: 7.0,
  },
  'pink-noise': {
    label: 'Pink Noise',
    hint: 'Steady broadband noise. Good for EQ shaping, cab voicing and setting the gate threshold.',
    duration: 5.0,
  },
  'clicks': {
    label: 'Clicks — impulse train',
    hint: 'Short impulses with silence between. Makes delay time and reverb decay easy to hear.',
    duration: 6.0,
  },
};

export class TestSignal {
  /**
   * @param {AudioContext} context
   */
  constructor(context) {
    this.context = context;

    // Level control — also the node the engine patches into the chain.
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 0.35;

    this._buffers = new Map();   // kind → AudioBuffer (generated, cached)
    this._fileBuffer = null;     // decoded user file
    this._fileName = null;
    this._source = null;
    this._startTime = 0;
    this._loop = true;

    this.onEnded = null;         // () => void — fires when playback runs out
  }

  getOutputNode() {
    return this.outputNode;
  }

  get isPlaying() {
    return this._source !== null;
  }

  get fileName() {
    return this._fileName;
  }

  get hasFile() {
    return this._fileBuffer !== null;
  }

  /** Length of the buffer currently playing, in seconds (0 when stopped). */
  get duration() {
    return this._source?.buffer?.duration || 0;
  }

  /**
   * Set playback level.
   * @param {number} value - 0 to 1
   */
  setLevel(value) {
    this.outputNode.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  setLoop(loop) {
    this._loop = loop;
    if (this._source) this._source.loop = loop;
  }

  /**
   * Decode an audio file into a playable buffer.
   * @param {File} file
   * @returns {Promise<{name: string, duration: number}>}
   */
  async loadFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    this._fileBuffer = await this.context.decodeAudioData(arrayBuffer);
    this._fileName = file.name;
    return { name: file.name, duration: this._fileBuffer.duration };
  }

  /**
   * Start playback of a generated signal or the loaded file.
   * @param {string} kind - a TEST_SIGNALS key, or 'file'
   */
  play(kind) {
    this.stop();

    const buffer = kind === 'file' ? this._fileBuffer : this._getGenerated(kind);
    if (!buffer) return false;

    const src = this.context.createBufferSource();
    src.buffer = buffer;
    src.loop = this._loop;
    src.connect(this.outputNode);
    src.onended = () => {
      // Only reached when a non-looping buffer runs out.
      this._source = null;
      this.onEnded?.();
    };
    src.start();

    this._source = src;
    this._startTime = this.context.currentTime;
    return true;
  }

  /**
   * Stop playback. Safe to call when already stopped.
   */
  stop() {
    if (!this._source) return;
    const src = this._source;
    this._source = null;
    // Drop the handler first so a programmatic stop does not report as "ended".
    src.onended = null;
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
  }

  /**
   * Playback position as a 0–1 fraction of the current buffer.
   * @returns {number}
   */
  getProgress() {
    if (!this._source || !this._source.buffer) return 0;
    const dur = this._source.buffer.duration;
    if (!dur) return 0;
    const elapsed = this.context.currentTime - this._startTime;
    return this._loop ? (elapsed % dur) / dur : Math.min(1, elapsed / dur);
  }

  /**
   * Discard cached buffers — used when the sample rate changes.
   */
  clearCache() {
    this._buffers.clear();
  }

  // ─── Generation ─────────────────────────────────────────────────────

  _getGenerated(kind) {
    if (this._buffers.has(kind)) return this._buffers.get(kind);

    const spec = TEST_SIGNALS[kind];
    if (!spec) {
      console.warn(`[TestSignal] Unknown signal: ${kind}`);
      return null;
    }

    const sr = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, Math.ceil(spec.duration * sr), sr);
    const out = buffer.getChannelData(0);

    switch (kind) {
      case 'single-notes':  this._renderSingleNotes(out, sr); break;
      case 'power-chords':  this._renderPowerChords(out, sr); break;
      case 'open-chord':    this._renderOpenChord(out, sr); break;
      case 'arpeggio':      this._renderArpeggio(out, sr); break;
      case 'dynamics':      this._renderDynamics(out, sr); break;
      case 'sweep':         this._renderSweep(out, sr); break;
      case 'pink-noise':    this._renderPinkNoise(out, sr); break;
      case 'clicks':        this._renderClicks(out, sr); break;
    }

    this._normalize(out, 0.6);
    this._fadeEdges(out, sr);

    this._buffers.set(kind, buffer);
    console.log(`[TestSignal] Rendered "${kind}" — ${spec.duration}s @ ${sr}Hz`);
    return buffer;
  }

  /**
   * Karplus-Strong plucked string, mixed additively into `out`.
   *
   * A noise burst fills a delay line one period long; averaging adjacent taps
   * on each pass lowpasses the line a little at a time, which is what gives
   * the natural "string dying away brighter-to-darker" decay.
   *
   * @param {Float32Array} out
   * @param {number} sr - sample rate
   * @param {number} at - start time in seconds
   * @param {number} freq - fundamental in Hz
   * @param {number} amp - peak amplitude
   * @param {number} dur - note length in seconds
   * @param {object} [opts]
   * @param {number} [opts.damping] - loop gain, 0.88 muted … 0.998 ringing
   * @param {number} [opts.brightness] - 0 dull pick … 1 bright pick
   */
  _pluck(out, sr, at, freq, amp, dur, opts = {}) {
    const { damping = 0.996, brightness = 0.5 } = opts;
    const start = Math.round(at * sr);
    if (start >= out.length) return;

    const N = Math.max(2, Math.round(sr / freq));
    const line = new Float32Array(N);

    // Excitation: noise through a one-pole lowpass — a softer pick is duller.
    const pickCoef = 0.12 + brightness * 0.85;
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += pickCoef * ((Math.random() * 2 - 1) - lp);
      line[i] = lp;
    }

    // Pick position comb — cancels the harmonic with a node under the pick.
    const pickDelay = Math.max(1, Math.round(N * 0.22));
    for (let i = N - 1; i >= pickDelay; i--) {
      line[i] -= line[i - pickDelay] * 0.6;
    }

    // Keep the burst at unit peak so `amp` means what it says.
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(line[i]));
    if (peak > 0) {
      for (let i = 0; i < N; i++) line[i] /= peak;
    }

    const total = Math.min(Math.round(dur * sr), out.length - start);
    const attack = Math.min(Math.round(0.002 * sr), total);
    const release = Math.min(Math.round(0.02 * sr), total);
    let idx = 0;

    for (let n = 0; n < total; n++) {
      const cur = line[idx];
      const next = line[(idx + 1) % N];
      line[idx] = damping * 0.5 * (cur + next);

      // Short attack, short release — keeps truncated notes click-free.
      let env = 1;
      if (n < attack) env = n / attack;
      else if (n > total - release) env = (total - n) / release;

      out[start + n] += cur * amp * env;
      idx = (idx + 1) % N;
    }
  }

  /** Strum a set of note names with a per-string time offset. */
  _strum(out, sr, at, notes, amp, dur, spread, opts = {}) {
    notes.forEach((note, i) => {
      // Slight per-string variation so it does not sound like one oscillator.
      const jitter = (Math.random() - 0.5) * 0.004;
      this._pluck(out, sr, at + i * spread + jitter, noteFreq(note), amp * (1 - i * 0.04), dur, opts);
    });
  }

  _renderSingleNotes(out, sr) {
    const notes = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
    notes.forEach((note, i) => {
      this._pluck(out, sr, i * 0.85, noteFreq(note), 0.9, 1.8, {
        damping: 0.9965,
        brightness: 0.6,
      });
    });
  }

  _renderPowerChords(out, sr) {
    const eighth = 0.3;  // 100 bpm
    // Root per eighth note — a plain rock pattern over two bars.
    const roots = [
      'E2', 'E2', 'E2', 'E2', 'G2', 'G2', 'A2', 'A2',
      'E2', 'E2', 'E2', 'E2', 'G2', 'A2', 'A2', 'A2',
    ];
    roots.forEach((root, i) => {
      const fifth = noteFreq(root) * 1.4983;  // perfect fifth
      const octave = noteFreq(root) * 2;
      const accent = i % 4 === 0 ? 1.0 : 0.78;
      const at = i * eighth;
      this._pluck(out, sr, at, noteFreq(root), 0.9 * accent, 0.3, { damping: 0.9, brightness: 0.45 });
      this._pluck(out, sr, at + 0.004, fifth, 0.7 * accent, 0.3, { damping: 0.9, brightness: 0.45 });
      this._pluck(out, sr, at + 0.008, octave, 0.4 * accent, 0.28, { damping: 0.89, brightness: 0.5 });
    });
    // Let the last chord ring out so the drive tail is audible.
    const at = roots.length * eighth;
    this._pluck(out, sr, at, noteFreq('E2'), 1.0, 1.2, { damping: 0.997, brightness: 0.5 });
    this._pluck(out, sr, at + 0.005, noteFreq('E2') * 1.4983, 0.8, 1.2, { damping: 0.997, brightness: 0.5 });
  }

  _renderOpenChord(out, sr) {
    const chord = ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'];
    this._strum(out, sr, 0.05, chord, 0.85, 3.4, 0.018, { damping: 0.9975, brightness: 0.62 });
    // Upstroke — strings arrive high to low and a touch quieter.
    this._strum(out, sr, 3.5, [...chord].reverse(), 0.7, 3.2, 0.015, { damping: 0.9975, brightness: 0.7 });
  }

  _renderArpeggio(out, sr) {
    const notes = ['A2', 'E3', 'A3', 'C4', 'E4', 'A4', 'E4', 'C4'];
    notes.forEach((note, i) => {
      this._pluck(out, sr, 0.05 + i * 0.36, noteFreq(note), 0.8, 3.0, {
        damping: 0.9975,
        brightness: 0.68,
      });
    });
  }

  _renderDynamics(out, sr) {
    const notes = ['A2', 'A3', 'A2', 'A3', 'A2', 'A3', 'A2', 'A3'];
    notes.forEach((note, i) => {
      // 0.05 → 1.0 geometrically: roughly 26 dB of range.
      const amp = 0.05 * Math.pow(1.0 / 0.05, i / (notes.length - 1));
      this._pluck(out, sr, 0.1 + i * 0.8, noteFreq(note), amp, 1.5, {
        damping: 0.9965,
        // Harder picking is brighter, as on a real string.
        brightness: 0.35 + amp * 0.45,
      });
    });
  }

  _renderSweep(out, sr) {
    const f0 = 40, f1 = 8000;
    const n = out.length;
    const dur = n / sr;
    const ratio = f1 / f0;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const freq = f0 * Math.pow(ratio, t / dur);
      phase += (2 * Math.PI * freq) / sr;
      out[i] = Math.sin(phase) * 0.8;
    }
  }

  _renderPinkNoise(out, sr) {
    // Paul Kellet's economy pink-noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  }

  _renderClicks(out, sr) {
    const spacing = 1.5;
    const len = Math.round(0.003 * sr);
    for (let c = 0; c * spacing < out.length / sr; c++) {
      const start = Math.round(c * spacing * sr);
      let lp = 0;
      for (let i = 0; i < len && start + i < out.length; i++) {
        // Short filtered burst: an audible "tick" rather than a single sample.
        lp += 0.5 * ((Math.random() * 2 - 1) - lp);
        out[start + i] += lp * (1 - i / len);
      }
    }
  }

  // ─── Post-processing ────────────────────────────────────────────────

  /** Scale so the loudest sample sits at `target`. */
  _normalize(out, target) {
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak < 1e-6) return;
    const g = target / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }

  /** Fade the first and last few ms so looping does not click. */
  _fadeEdges(out, sr) {
    const n = Math.min(Math.round(0.005 * sr), Math.floor(out.length / 2));
    for (let i = 0; i < n; i++) {
      const g = i / n;
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }
  }
}
