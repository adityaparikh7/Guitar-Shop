/**
 * Chromatic Tuner — Pitch detection using autocorrelation on AnalyserNode data.
 *
 * Detection is deliberately cheap, because it shares the main thread with the
 * audio graph's control plane: the signal is decimated before correlating, the
 * lag search covers only the range a guitar can actually produce, every buffer
 * is reused, and detection runs at 20Hz rather than once per animation frame.
 * A full O(n²) pass over 4096 samples at 60fps — which is what this used to do —
 * costs enough to drop audio frames.
 *
 * Muting while tuning is the engine's job (AudioEngine.setMuted), so that it
 * does not fight the master volume control.
 */
export class Tuner {
  // A low B string sits near 61Hz in drop tunings; the 24th fret high E is
  // about 1319Hz. Everything outside that is noise as far as a guitar goes.
  static MIN_FREQ = 60;
  static MAX_FREQ = 1350;

  // Below this normalised correlation the frame is not periodic enough to call
  // a pitch — better to show nothing than a wrong note.
  static MIN_CLARITY = 0.5;

  // A periodic signal correlates just as well at twice or three times its
  // period, so the best score alone does not identify the fundamental. Accept
  // the earliest peak that comes this close to the best one instead.
  static PEAK_TOLERANCE = 0.92;

  // Detections per second. Faster than this is wasted: the needle cannot be
  // read any quicker, and each pass is real work.
  static DETECT_INTERVAL_MS = 50;

  constructor(context) {
    this.context = context;
    this.active = false;
    this._analyser = context.createAnalyser();
    this._analyser.fftSize = 4096;
    this._buffer = new Float32Array(this._analyser.fftSize);

    // Decimate by 4 before correlating: 16x less work, and the resulting
    // ~12kHz rate still has six times the headroom the top note needs.
    this._decimation = 4;
    const dsLength = Math.floor(this._analyser.fftSize / this._decimation);
    this._ds = new Float32Array(dsLength);
    this._scores = new Float32Array(dsLength);

    this._rafId = null;
    this._lastDetect = 0;

    // Note names
    this._notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Callbacks
    this.onUpdate = null; // (note, octave, cents, frequency) => void
  }

  getAnalyserNode() { return this._analyser; }

  start() {
    if (this.active) return;
    this.active = true;
    this._lastDetect = 0;
    this._detect();
  }

  stop() {
    this.active = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  toggle() {
    if (this.active) this.stop();
    else this.start();
    return this.active;
  }

  _detect() {
    const tick = (now) => {
      if (!this.active) return;

      // Throttle the expensive part; the frame loop itself stays cheap.
      const t = now ?? performance.now();
      if (t - this._lastDetect >= Tuner.DETECT_INTERVAL_MS) {
        this._lastDetect = t;
        this._analyser.getFloatTimeDomainData(this._buffer);
        const freq = this._autocorrelate(this._buffer, this.context.sampleRate);

        if (freq > 0 && this.onUpdate) {
          const noteNum = 12 * (Math.log2(freq / 440));
          const roundedNote = Math.round(noteNum);
          const cents = Math.round((noteNum - roundedNote) * 100);
          // roundedNote is semitones from A4 — shift to MIDI before indexing the
          // C-based name table, or every note reads three semitones sharp.
          const midi = roundedNote + 69;
          const noteIndex = ((midi % 12) + 12) % 12;
          const note = this._notes[noteIndex];
          const octave = Math.floor(midi / 12) - 1;
          this.onUpdate(note, octave, cents, freq);
        }
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  /**
   * Normalised autocorrelation pitch detection over the guitar's range.
   *
   * Normalising each lag by the energy of the two windows being compared is
   * what keeps a decaying note from reading an octave high: raw correlation
   * falls off with lag, which biases the peak toward short periods.
   *
   * This is monophonic, as a tuner is: if another string is still ringing at
   * more than about a quarter of the new note's level, the lower note wins and
   * is what gets reported. Mute the strings you are not tuning.
   *
   * @param {Float32Array} buf - time-domain samples
   * @param {number} sampleRate
   * @returns {number} frequency in Hz, or -1 when no pitch is found
   */
  _autocorrelate(buf, sampleRate) {
    const D = this._decimation;
    const ds = this._ds;
    const n = ds.length;

    // Decimate with a box average, which doubles as a crude anti-alias filter.
    let rms = 0;
    for (let i = 0; i < n; i++) {
      const base = i * D;
      let acc = 0;
      for (let j = 0; j < D; j++) acc += buf[base + j];
      const v = acc / D;
      ds[i] = v;
      rms += v * v;
    }
    rms = Math.sqrt(rms / n);
    if (rms < 0.005) return -1; // Too quiet

    const sr = sampleRate / D;
    const minLag = Math.max(2, Math.floor(sr / Tuner.MAX_FREQ));
    const maxLag = Math.min(n - 2, Math.ceil(sr / Tuner.MIN_FREQ));
    if (maxLag <= minLag) return -1;

    const scores = this._scores;
    let topLag = -1;
    let topScore = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      const count = n - lag;
      let num = 0, energyA = 0, energyB = 0;
      for (let i = 0; i < count; i++) {
        const a = ds[i];
        const b = ds[i + lag];
        num += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      const denom = Math.sqrt(energyA * energyB);
      const score = denom > 0 ? num / denom : 0;
      scores[lag] = score;
      if (score > topScore) { topScore = score; topLag = lag; }
    }

    if (topLag < 0 || topScore < Tuner.MIN_CLARITY) return -1;

    // Every integer multiple of the period scores about the same, so taking the
    // global maximum lands on an arbitrary sub-harmonic — which is exactly how
    // a tuner ends up reading an octave or two low. Walk up from the shortest
    // lag and take the first peak that is as good as the best, which is the
    // fundamental.
    const threshold = topScore * Tuner.PEAK_TOLERANCE;
    let bestLag = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      const score = scores[lag];
      if (score >= threshold && score > scores[lag - 1] && score >= scores[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    // No interior peak (the period sits at the edge of the search range).
    if (bestLag < 0) bestLag = topLag;
    const bestScore = scores[bestLag];

    // Parabolic interpolation against the neighbouring lags, for sub-sample
    // precision (a whole lag is several cents at the top of the range).
    let shift = 0;
    if (bestLag > minLag && bestLag < maxLag) {
      const prev = scores[bestLag - 1];
      const next = scores[bestLag + 1];
      const denom = 2 * (prev - 2 * bestScore + next);
      if (denom !== 0) {
        const s = (prev - next) / denom;
        if (s > -1 && s < 1) shift = s;
      }
    }

    return sr / (bestLag + shift);
  }
}
