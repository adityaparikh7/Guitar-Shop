/**
 * Guitar Effects — Each effect is a self-contained class with a common interface.
 */

// Waveshaper transfer curves are rebuilt whenever a drive control moves, and a
// knob drag fires that on every mouse move. 4096 points is indistinguishable
// from the 44100 this used to allocate, and roughly ten times cheaper to build.
const CURVE_POINTS = 4096;

// Drive controls are quantised to this many steps before a curve is rebuilt, so
// a drag rebuilds a handful of times rather than once per frame.
const CURVE_STEPS = 64;

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
}

export class NoiseGate extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'noisegate');
    this.threshold = -50;

    // Use AudioWorklet gate-processor for audio-rate gating (~2.6ms response)
    // instead of requestAnimationFrame polling (~16ms response)
    try {
      this._gateNode = new AudioWorkletNode(ctx, 'gate-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this._thresholdParam = this._gateNode.parameters.get('threshold');
      this._thresholdParam.value = this.threshold;
      this._input.connect(this._gateNode);
      this._gateNode.connect(this._output);
      this._useWorklet = true;
    } catch (e) {
      // Fallback: simple gain node pass-through if worklet not available
      console.warn('[NoiseGate] AudioWorklet unavailable, using bypass:', e);
      this._input.connect(this._output);
      this._useWorklet = false;
    }
  }
  setParam(n, v) {
    if (n === 'threshold') {
      this.threshold = v;
      if (this._useWorklet && this._thresholdParam) {
        this._thresholdParam.setValueAtTime(v, this.context.currentTime);
      }
    }
  }
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
    const n = CURVE_POINTS, c = new Float32Array(n), a = this._drive * 50 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      if (x > 0) {
        c[i] = (1 - Math.exp(-a * x)) / Math.tanh(a);
      } else {
        c[i] = -Math.tanh(-a * x * 0.5) / Math.tanh(a * 0.5);
      }
    }
    this._ws.curve = c; this._ws.oversample = '2x';
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'drive') {
      this._drive = v;
      this._driveGain.gain.setTargetAtTime(1 + v * 3, t, 0.01);
      const step = Math.round(v * CURVE_STEPS);
      if (step !== this._curveStep) { this._curveStep = step; this._updateCurve(); }
    }
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
    const n = CURVE_POINTS, c = new Float32Array(n), a = this._gain * 100 + 1;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = (Math.PI + a) * x / (Math.PI + a * Math.abs(x)); }
    this._ws.curve = c; this._ws.oversample = '2x';
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'gain') {
      this._gain = v;
      this._driveGain.gain.setTargetAtTime(1 + v * 8, t, 0.01);
      const step = Math.round(v * CURVE_STEPS);
      if (step !== this._curveStep) { this._curveStep = step; this._updateCurve(); }
    }
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
    // Matches the mix law in setParam, so the dry level is right before the
    // first knob move rather than only after one.
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1 - this._mix * 0.5;

    // Rendering an impulse response means allocating seconds of noise and
    // handing the convolver a new buffer. At one per mousemove that locks up
    // the main thread and breaks the audio, so responses are quantised,
    // cached, and applied once the knob settles.
    this._irCache = new Map();
    this._irTimer = null;
    this._builtDecay = null;
    this._applyIR(this._quantizeDecay(this._decay));

    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._convolver); this._convolver.connect(this._wetGain); this._wetGain.connect(this._output);
  }

  /** Quarter-second steps — finer than anyone can hear on a reverb tail. */
  _quantizeDecay(decay) {
    return Math.max(0.25, Math.round(decay * 4) / 4);
  }

  _renderIR(decay) {
    const sr = this.context.sampleRate, len = Math.max(1, Math.floor(sr * decay));
    const buf = this.context.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lastVal = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        lastVal = (lastVal + white * 0.02) / 1.02;
        d[i] = lastVal * Math.pow(1 - i / len, decay * 0.5) * 5;
      }
    }
    return buf;
  }

  _applyIR(decay) {
    let buf = this._irCache.get(decay);
    if (!buf) {
      buf = this._renderIR(decay);
      this._irCache.set(decay, buf);
    }
    this._convolver.buffer = buf;
    this._builtDecay = decay;
  }

  async loadIR(arrayBuffer) {
    const ab = await this.context.decodeAudioData(arrayBuffer);
    if (this._irTimer) { clearTimeout(this._irTimer); this._irTimer = null; }
    this._convolver.buffer = ab;
    this._builtDecay = null;
  }

  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'decay') {
      this._decay = v;
      const q = this._quantizeDecay(v);
      if (q !== this._builtDecay) {
        if (this._irTimer) clearTimeout(this._irTimer);
        this._irTimer = setTimeout(() => {
          this._irTimer = null;
          this._applyIR(this._quantizeDecay(this._decay));
        }, 120);
      }
    }
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

export class Phaser extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'phaser');
    this._rate = 0.5; this._depth = 0.5; this._feedback = 0.5; this._mix = 0.5;
    this._lfo = ctx.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = this._rate;
    this._lfoGain = ctx.createGain();
    this._lfoGain.gain.value = this._depth * 2000;
    this._lfo.connect(this._lfoGain);
    this._lfo.start();
    
    this._stages = [];
    for (let i = 0; i < 4; i++) {
      const stage = ctx.createBiquadFilter();
      stage.type = 'allpass';
      stage.frequency.value = 1000;
      this._lfoGain.connect(stage.frequency);
      this._stages.push(stage);
    }
    for (let i = 0; i < 3; i++) {
      this._stages[i].connect(this._stages[i+1]);
    }
    
    this._fbGain = ctx.createGain(); this._fbGain.gain.value = this._feedback * 0.8;
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1 - this._mix;
    
    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._stages[0]);
    this._stages[3].connect(this._wetGain); this._wetGain.connect(this._output);
    this._stages[3].connect(this._fbGain); this._fbGain.connect(this._stages[0]);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'rate') { this._rate = v; this._lfo.frequency.setTargetAtTime(v * 5, t, 0.01); }
    if (n === 'depth') { this._depth = v; this._lfoGain.gain.setTargetAtTime(v * 3000, t, 0.01); }
    if (n === 'feedback') { this._feedback = v; this._fbGain.gain.setTargetAtTime(v * 0.9, t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v, t, 0.01); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, feedback: this._feedback, mix: this._mix }; }
}

export class Flanger extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'flanger');
    this._rate = 0.5; this._depth = 0.5; this._feedback = 0.5; this._mix = 0.5;
    this._delay = ctx.createDelay(0.02);
    this._delay.delayTime.value = 0.005;
    this._lfo = ctx.createOscillator();
    this._lfo.type = 'sine';
    this._lfo.frequency.value = this._rate;
    this._lfoGain = ctx.createGain();
    this._lfoGain.gain.value = this._depth * 0.004;
    this._lfo.connect(this._lfoGain);
    this._lfoGain.connect(this._delay.delayTime);
    this._lfo.start();
    
    this._fbGain = ctx.createGain(); this._fbGain.gain.value = this._feedback * 0.9;
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1 - this._mix;
    
    this._input.connect(this._dryGain); this._dryGain.connect(this._output);
    this._input.connect(this._delay);
    this._delay.connect(this._wetGain); this._wetGain.connect(this._output);
    this._delay.connect(this._fbGain); this._fbGain.connect(this._delay);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'rate') { this._rate = v; this._lfo.frequency.setTargetAtTime(v * 5, t, 0.01); }
    if (n === 'depth') { this._depth = v; this._lfoGain.gain.setTargetAtTime(v * 0.004, t, 0.01); }
    if (n === 'feedback') { this._feedback = v; this._fbGain.gain.setTargetAtTime(v * 0.9, t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v, t, 0.01); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, feedback: this._feedback, mix: this._mix }; }
}

export class EnvelopeFilter extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'envelopefilter');
    this._sensitivity = 0.5; this._q = 0.5; this._mix = 1.0;

    // BiquadFilter for the actual filtering
    this._filter = ctx.createBiquadFilter();
    this._filter.type = 'lowpass';
    this._filter.frequency.value = 300;
    this._filter.Q.value = this._q * 10;

    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1 - this._mix;
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;

    // Use AudioWorklet envelope-follower-processor for audio-rate envelope tracking
    // (~2.6ms response instead of ~16ms from requestAnimationFrame)
    try {
      this._envNode = new AudioWorkletNode(ctx, 'envelope-follower-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this._sensitivityParam = this._envNode.parameters.get('sensitivity');
      this._sensitivityParam.value = this._sensitivity;

      // The envelope worklet sends frequency updates via postMessage
      this._envNode.port.onmessage = (event) => {
        if (event.data.type === 'envelope') {
          this._filter.frequency.setTargetAtTime(event.data.frequency, ctx.currentTime, 0.005);
        }
      };

      // Signal flow: input → envNode (for envelope detection, passes audio through)
      //              envNode output → filter → wetGain → output
      //              input → dryGain → output
      this._input.connect(this._envNode);
      this._envNode.connect(this._filter);
      this._filter.connect(this._wetGain);
      this._input.connect(this._dryGain);
      this._wetGain.connect(this._output);
      this._dryGain.connect(this._output);
      this._useWorklet = true;
    } catch (e) {
      // Fallback: no envelope modulation, just pass through filter
      console.warn('[EnvelopeFilter] AudioWorklet unavailable, using static filter:', e);
      this._input.connect(this._filter);
      this._filter.connect(this._wetGain);
      this._input.connect(this._dryGain);
      this._wetGain.connect(this._output);
      this._dryGain.connect(this._output);
      this._useWorklet = false;
    }
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'sensitivity') {
      this._sensitivity = v;
      if (this._useWorklet && this._sensitivityParam) {
        this._sensitivityParam.setValueAtTime(v, t);
      }
    }
    if (n === 'q') { this._q = v; this._filter.Q.setTargetAtTime(v * 15, t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v, t, 0.01); }
  }
  getParams() { return { sensitivity: this._sensitivity, q: this._q, mix: this._mix }; }
}

export class Boost extends BaseEffect {
  constructor(ctx) {
    super(ctx, 'boost');
    this._gain = 0.5; this._tone = 0.5;
    this._filter = ctx.createBiquadFilter();
    this._filter.type = 'highshelf';
    this._filter.frequency.value = 2000;
    this._filter.gain.value = (this._tone - 0.5) * 10;
    this._boostGain = ctx.createGain();
    this._boostGain.gain.value = 1 + this._gain * 4;
    
    this._input.connect(this._filter);
    this._filter.connect(this._boostGain);
    this._boostGain.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'gain') { this._gain = v; this._boostGain.gain.setTargetAtTime(1 + v * 4, t, 0.01); }
    if (n === 'tone') { this._tone = v; this._filter.gain.setTargetAtTime((v - 0.5) * 10, t, 0.01); }
  }
  getParams() { return { gain: this._gain, tone: this._tone }; }
}
