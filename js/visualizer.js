/**
 * Visualizer — Real-time waveform, spectrum analyzer, and VU meter on canvas.
 */
export class Visualizer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.analyserInput = null;
    this.analyserOutput = null;
    this.mode = 'waveform'; // 'waveform' | 'spectrum' | 'both'
    this._rafId = null;
    this._inputData = null;
    this._outputData = null;
    this._freqData = null;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.W = this.canvas.width;
    this.H = this.canvas.height;
  }

  setAnalysers(input, output) {
    this.analyserInput = input;
    this.analyserOutput = output;
    if (input) {
      this._inputData = new Float32Array(input.fftSize);
      this._freqData = new Uint8Array(input.frequencyBinCount);
    }
    if (output) {
      this._outputData = new Float32Array(output.fftSize);
    }
  }

  start() {
    if (this._rafId) return;
    const draw = () => {
      this._draw();
      this._rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  setMode(mode) {
    this.mode = mode;
  }

  _draw() {
    const { ctx, W, H } = this;
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, W, H);

    // Draw grid
    this._drawGrid();

    if (this.mode === 'waveform' || this.mode === 'both') {
      this._drawWaveform();
    }
    if (this.mode === 'spectrum' || this.mode === 'both') {
      this._drawSpectrum();
    }

    // VU meters
    this._drawVU();
  }

  _drawGrid() {
    const { ctx, W, H } = this;
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.06)';
    ctx.lineWidth = 0.5;
    // Horizontal
    for (let i = 0; i < 8; i++) {
      const y = (H / 8) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Vertical
    for (let i = 0; i < 16; i++) {
      const x = (W / 16) * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  _drawWaveform() {
    if (!this.analyserOutput || !this._outputData) return;
    this.analyserOutput.getFloatTimeDomainData(this._outputData);
    const { ctx, W, H } = this;
    const data = this._outputData;
    const step = Math.floor(data.length / W) || 1;

    // Glow effect
    ctx.shadowColor = '#00e5ff';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < W; i++) {
      const idx = i * step;
      const v = data[idx] || 0;
      const y = (1 - v) * H / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawSpectrum() {
    if (!this.analyserOutput || !this._freqData) return;
    this.analyserOutput.getByteFrequencyData(this._freqData);
    const { ctx, W, H } = this;
    const data = this._freqData;
    const barW = W / data.length * 2.5;

    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 255;
      const barH = v * H * 0.8;
      const x = i * barW;
      if (x > W) break;

      const hue = 180 + v * 60;
      ctx.fillStyle = `hsla(${hue}, 100%, ${40 + v * 30}%, 0.7)`;
      ctx.fillRect(x, H - barH, barW - 1, barH);
    }
  }

  _drawVU() {
    if (!this.analyserOutput || !this._outputData) return;
    this.analyserOutput.getFloatTimeDomainData(this._outputData);
    const { ctx, W, H } = this;

    // Calculate RMS
    let sum = 0;
    for (let i = 0; i < this._outputData.length; i++) sum += this._outputData[i] ** 2;
    const rms = Math.sqrt(sum / this._outputData.length);
    const db = Math.max(-60, 20 * Math.log10(rms + 1e-10));
    const level = (db + 60) / 60; // 0 to 1

    // Draw VU bar
    const barX = W - 30;
    const barW = 12;
    const barH = H - 20;
    const fillH = level * barH;

    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(barX, 10, barW, barH);

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 10 + barH, 0, 10);
    grad.addColorStop(0, '#00e676');
    grad.addColorStop(0.6, '#ffea00');
    grad.addColorStop(0.85, '#ff5722');
    ctx.fillStyle = grad;
    ctx.fillRect(barX, 10 + barH - fillH, barW, fillH);

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('VU', barX, H);
  }
}
