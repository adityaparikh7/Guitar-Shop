/**
 * Guitar Effects — Each effect is a self-contained class with a common interface.
 */

class BaseEffect {
  constructor(context, name) {
    this.context = context;
    this.name = name;
    this.enabled = false;
    this._input = context.createGain();
    this._output = context.createGain();
  }
  getInputNode() { return this._input; }
  getOutputNode() { return this._output; }
  toggle() { this.enabled = !this.enabled; return this.enabled; }
  setParam(name, value) {}
  getParams() { return {}; }
  serialize() { return { name: this.name, enabled: this.enabled, params: this.getParams() }; }
  deserialize(data) {
    this.enabled = data.enabled;
    for (const [k, v] of Object.entries(data.params)) this.setParam(k, v);
  }
}

export class NoiseGate extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'noisegate');
    this.threshold = -50;
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._gateGain = ctx.createGain();
    this._input.connect(this._analyser);
    this._input.connect(this._gateGain);
    this._gateGain.connect(this._output);
    this._dataArray = new Float32Array(256);
    this._tick = () => {
      if (!this.enabled) { this._gateGain.gain.value = 1; }
      else {
        this._analyser.getFloatTimeDomainData(this._dataArray);
        let sum = 0;
        for (let i = 0; i < this._dataArray.length; i++) sum += this._dataArray[i] ** 2;
        const db = 20 * Math.log10(Math.sqrt(sum / this._dataArray.length) + 1e-10);
        this._gateGain.gain.setTargetAtTime(db > this.threshold ? 1 : 0, ctx.currentTime, 0.005);
      }
      this._rafId = requestAnimationFrame(this._tick);
    };
    this._tick();
  }
  setParam(n, v) { if (n === 'threshold') this.threshold = v; }
  getParams() { return { threshold: this.threshold }; }
}

export class Compressor extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'compressor');
    this._comp = ctx.createDynamicsCompressor();
    this._comp.threshold.value = -24;
    this._comp.ratio.value = 4;
    this._comp.attack.value = 0.003;
    this._comp.release.value = 0.25;
    this._input.connect(this._comp);
    this._comp.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'threshold') this._comp.threshold.setValueAtTime(v, t);
    if (n === 'ratio') this._comp.ratio.setValueAtTime(v, t);
    if (n === 'attack') this._comp.attack.setValueAtTime(v, t);
    if (n === 'release') this._comp.release.setValueAtTime(v, t);
  }
  getParams() {
    return { threshold: this._comp.threshold.value, ratio: this._comp.ratio.value, attack: this._comp.attack.value, release: this._comp.release.value };
  }
}

export class Overdrive extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'overdrive');
    this._drive = 0.5; this._tone = 0.5; this._level = 0.7;
    this._driveGain = ctx.createGain();
    this._ws = ctx.createWaveShaper();
    this._filter = ctx.createBiquadFilter();
    this._levelGain = ctx.createGain();
    this._filter.type = 'lowpass';
    this._filter.frequency.value = 3000;
    this._levelGain.gain.value = this._level;
    this._updateCurve();
    this._input.connect(this._driveGain);
    this._driveGain.connect(this._ws);
    this._ws.connect(this._filter);
    this._filter.connect(this._levelGain);
    this._levelGain.connect(this._output);
  }
  _updateCurve() {
    const n = 44100, c = new Float32Array(n), a = this._drive * 50 + 1;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); }
    this._ws.curve = c; this._ws.oversample = '2x';
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'drive') { this._drive = v; this._driveGain.gain.setTargetAtTime(1 + v * 3, t, 0.01); this._updateCurve(); }
    if (n === 'tone') { this._tone = v; this._filter.frequency.setTargetAtTime(500 + v * 5500, t, 0.01); }
    if (n === 'level') { this._level = v; this._levelGain.gain.setTargetAtTime(v, t, 0.01); }
  }
  getParams() { return { drive: this._drive, tone: this._tone, level: this._level }; }
}

export class Distortion extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'distortion');
    this._gain = 0.5; this._tone = 0.5; this._level = 0.6;
    this._driveGain = ctx.createGain();
    this._ws = ctx.createWaveShaper();
    this._filter = ctx.createBiquadFilter();
    this._levelGain = ctx.createGain();
    this._hp = ctx.createBiquadFilter();
    this._filter.type = 'lowpass'; this._filter.frequency.value = 4000;
    this._hp.type = 'highpass'; this._hp.frequency.value = 80;
    this._driveGain.gain.value = 2; this._levelGain.gain.value = this._level;
    this._updateCurve();
    this._input.connect(this._hp);
    this._hp.connect(this._driveGain);
    this._driveGain.connect(this._ws);
    this._ws.connect(this._filter);
    this._filter.connect(this._levelGain);
    this._levelGain.connect(this._output);
  }
  _updateCurve() {
    const n = 44100, c = new Float32Array(n), a = this._gain * 100 + 1;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = (Math.PI + a) * x / (Math.PI + a * Math.abs(x)); }
    this._ws.curve = c; this._ws.oversample = '4x';
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'gain') { this._gain = v; this._driveGain.gain.setTargetAtTime(1 + v * 8, t, 0.01); this._updateCurve(); }
    if (n === 'tone') { this._tone = v; this._filter.frequency.setTargetAtTime(800 + v * 6000, t, 0.01); }
    if (n === 'level') { this._level = v; this._levelGain.gain.setTargetAtTime(v, t, 0.01); }
  }
  getParams() { return { gain: this._gain, tone: this._tone, level: this._level }; }
}

export class Chorus extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'chorus');
    this._rate = 1.5; this._depth = 0.5; this._mix = 0.5;
    this._delay = ctx.createDelay(0.05);
    this._delay.delayTime.value = 0.015;
    this._lfo = ctx.createOscillator();
    this._lfoGain = ctx.createGain();
    this._wetGain = ctx.createGain();
    this._dryGain = ctx.createGain();
    this._lfo.type = 'sine'; this._lfo.frequency.value = this._rate;
    this._lfoGain.gain.value = 0.005;
    this._wetGain.gain.value = this._mix;
    this._dryGain.gain.value = 1 - this._mix;
    this._lfo.connect(this._lfoGain);
    this._lfoGain.connect(this._delay.delayTime);
    this._lfo.start();
    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._delay); this._delay.connect(this._wetGain); this._wetGain.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'rate') { this._rate = v; this._lfo.frequency.setTargetAtTime(v, t, 0.01); }
    if (n === 'depth') { this._depth = v; this._lfoGain.gain.setTargetAtTime(v * 0.01, t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v, t, 0.01); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, mix: this._mix }; }
}

export class Delay extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'delay');
    this._time = 0.4; this._feedback = 0.4; this._mix = 0.3;
    this._delay = ctx.createDelay(2.0);
    this._delay.delayTime.value = this._time;
    this._fbGain = ctx.createGain(); this._fbGain.gain.value = this._feedback;
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1;
    this._delay.connect(this._fbGain); this._fbGain.connect(this._delay);
    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._delay); this._delay.connect(this._wetGain); this._wetGain.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'time') { this._time = v; this._delay.delayTime.setTargetAtTime(v, t, 0.01); }
    if (n === 'feedback') { this._feedback = v; this._fbGain.gain.setTargetAtTime(Math.min(v, 0.95), t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); }
  }
  getParams() { return { time: this._time, feedback: this._feedback, mix: this._mix }; }
}

export class Reverb extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'reverb');
    this._decay = 2.0; this._mix = 0.3;
    this._convolver = ctx.createConvolver();
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1;
    this._generateIR(this._decay);
    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._convolver); this._convolver.connect(this._wetGain); this._wetGain.connect(this._output);
  }
  _generateIR(decay) {
    const sr = this.context.sampleRate, len = sr * decay;
    const buf = this.context.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    this._convolver.buffer = buf;
  }
  async loadIR(arrayBuffer) {
    const ab = await this.context.decodeAudioData(arrayBuffer);
    this._convolver.buffer = ab;
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'decay') { this._decay = v; this._generateIR(v); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v * 0.5, t, 0.01); }
  }
  getParams() { return { decay: this._decay, mix: this._mix }; }
}

export class EQ extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'eq');
    this._bass = 0; this._mid = 0; this._treble = 0;
    this._low = ctx.createBiquadFilter(); this._low.type = 'lowshelf'; this._low.frequency.value = 320; this._low.gain.value = 0;
    this._midF = ctx.createBiquadFilter(); this._midF.type = 'peaking'; this._midF.frequency.value = 1000; this._midF.Q.value = 1; this._midF.gain.value = 0;
    this._high = ctx.createBiquadFilter(); this._high.type = 'highshelf'; this._high.frequency.value = 3200; this._high.gain.value = 0;
    this._input.connect(this._low); this._low.connect(this._midF); this._midF.connect(this._high); this._high.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'bass') { this._bass = v; this._low.gain.setTargetAtTime(v, t, 0.01); }
    if (n === 'mid') { this._mid = v; this._midF.gain.setTargetAtTime(v, t, 0.01); }
    if (n === 'treble') { this._treble = v; this._high.gain.setTargetAtTime(v, t, 0.01); }
  }
  getParams() { return { bass: this._bass, mid: this._mid, treble: this._treble }; }
}
