/**
 * Chromatic Tuner — Pitch detection using autocorrelation on AnalyserNode data.
 */
export class Tuner {
  constructor(context) {
    this.context = context;
    this.active = false;
    this._analyser = context.createAnalyser();
    this._analyser.fftSize = 4096;
    this._buffer = new Float32Array(this._analyser.fftSize);
    this._rafId = null;

    // Note names
    this._notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Callbacks
    this.onUpdate = null; // (note, octave, cents, frequency) => void

    // Mute gain — used to mute output when tuner is active
    this._muteGain = context.createGain();
  }

  getAnalyserNode() { return this._analyser; }
  getMuteNode() { return this._muteGain; }

  start() {
    this.active = true;
    this._muteGain.gain.setTargetAtTime(0, this.context.currentTime, 0.01);
    this._detect();
  }

  stop() {
    this.active = false;
    this._muteGain.gain.setTargetAtTime(1, this.context.currentTime, 0.01);
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
    const tick = () => {
      if (!this.active) return;
      this._analyser.getFloatTimeDomainData(this._buffer);
      const freq = this._autocorrelate(this._buffer, this.context.sampleRate);

      if (freq > 0 && this.onUpdate) {
        const noteNum = 12 * (Math.log2(freq / 440));
        const roundedNote = Math.round(noteNum);
        const cents = Math.round((noteNum - roundedNote) * 100);
        const noteIndex = ((roundedNote % 12) + 12) % 12;
        const note = this._notes[noteIndex];
        const octave = Math.floor((roundedNote + 69) / 12) - 1;
        this.onUpdate(note, octave, cents, freq);
      }

      this._rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * Autocorrelation-based pitch detection.
   */
  _autocorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);

    if (rms < 0.01) return -1; // Too quiet

    // Find the first and last non-trivial sample
    let r1 = 0, r2 = SIZE - 1;
    const threshold = 0.2;
    for (let i = 0; i < SIZE / 2; i++) {
      if (Math.abs(buf[i]) < threshold) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
      if (Math.abs(buf[SIZE - i]) < threshold) { r2 = SIZE - i; break; }
    }

    const trimBuf = buf.slice(r1, r2);
    const trimSize = trimBuf.length;

    // Autocorrelation
    const c = new Float32Array(trimSize);
    for (let i = 0; i < trimSize; i++) {
      for (let j = 0; j < trimSize - i; j++) {
        c[i] += trimBuf[j] * trimBuf[j + i];
      }
    }

    // Find first dip then first peak
    let d = 0;
    while (c[d] > c[d + 1] && d < trimSize) d++;

    let maxVal = -1, maxPos = -1;
    for (let i = d; i < trimSize; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }

    // Parabolic interpolation
    const prev = c[maxPos - 1] || 0;
    const next = c[maxPos + 1] || 0;
    const shift = (prev - next) / (2 * (prev - 2 * maxVal + next));
    const T0 = maxPos + (isNaN(shift) ? 0 : shift);

    return sampleRate / T0;
  }
}
