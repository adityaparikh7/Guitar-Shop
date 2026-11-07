/**
 * Guitar Effects — Each effect is a self-contained class with a common interface.
 *
 * Every pedal can also run a NAM capture (see capture-slot.js). How it fits
 * depends on the pedal, set by `static captureMode`:
 *
 *   replace  the capture stands in for the circuit (Boost, Overdrive,
 *            Distortion, Compressor). Drive/Gain sets how hard it is hit,
 *            Tone becomes a tilt that is flat at noon, Level stays Level.
 *   pre      the capture colours the signal ahead of the circuit (everything
 *            else) — NAM cannot model an LFO or a long delay — and every knob
 *            keeps working.
 *
 * The drive pedals' clipping runs in tube-stage-processor (amp-processor.js),
 * the same 4x-oversampled worklet as the amp's tubes: a WaveShaperNode at '2x'
 * cost 128 samples of latency per pedal; this costs about 6.
 */
import { createStageNode, dbToGain } from './audio-nodes.js';
import { CaptureSlot } from './capture-slot.js';

/**
 * Clipping stages for the drive pedals (see createStage() in amp-processor.js).
 *
 * `trim` is the output gain, in dB, at Drive 0, ½ and 1 — measured on the
 * Test Bench power chords so the pedal at its default Level sits at the dry
 * signal's loudness with Drive at noon, about 3dB under it at zero and a
 * little over it when cranked. Clipping squashes the signal up towards a
 * fixed ceiling, so without it the pedals got 15dB louder across the knob.
 */
const DRIVE_STAGES = {
  // An EP-style JFET booster: clean until it is pushed, then mostly even
  // harmonics. A boost is meant to get louder, so it has no trim.
  boost: { stages: [{ type: 'jfet', gain: [1, 8], headroom: 1.4, asym: 0.3, lp: 16000, hp: 25 }] },
  // Tube Screamer: the 720Hz high-pass in the gain path is the mid hump, and
  // the clean signal riding over the clipped one is why it stays articulate.
  overdrive: { stages: [{ type: 'opamp', gain: [3, 110], pre: 720, clean: 1, asym: 0.04, lp: [9000, 5500], hp: 15 }], trim: [-8.6, -14.3, -17.3] },
  // RAT: an op-amp whose bandwidth collapses as the gain comes up, into
  // silicon diodes to ground. Hard clipping at full gain is close to a square
  // wave, so it runs at 8x: a high note's aliases drop from about −59dB to −97dB.
  distortion: { stages: [{ type: 'diode', gain: [6, 700], pre: 250, clean: 1, knee: 2, asym: 0.08, lp: [16000, 3200], hp: 20 }], oversample: 8, trim: [-10.3, -16.6, -18.2] },
};

/** Output trim in dB at drive `d`, through the three measured points at 0, ½ and 1. */
function driveTrim([a, b, c], d) {
  return a * (2 * d - 1) * (d - 1) + b * 4 * d * (1 - d) + c * d * (2 * d - 1);
}

const TWO_PI = 2 * Math.PI;

class BaseEffect {
  /** 'replace' — a capture stands in for the circuit; 'pre' — it colours the signal ahead of it. */
  static captureMode = 'pre';
  /** Knobs that do nothing while a capture is playing, dimmed in the UI. */
  static captureInactiveParams = [];

  /**
   * @param {BaseAudioContext} context
   * @param {string} name
   * @param {object} [options]
   * @param {import('./capture-library.js').CaptureLibrary} [options.library] - resolves `lib:` capture ids
   */
  constructor(context, name, { library = null } = {}) {
    this.context = context;
    this.name = name;
    this.enabled = false;
    this.library = library;
    this._input = context.createGain();
    this._output = context.createGain();
    this._capture = null;
    /** (status) => void — capture load reports, as CaptureSlot.onStatus. */
    this.onCaptureStatus = null;
  }
  getInputNode() { return this._input; }
  getOutputNode() { return this._output; }
  toggle() { this.enabled = !this.enabled; return this.enabled; }
  setParam(name, value) {}
  getParams() { return {}; }

  /**
   * Splice the capture slot in; subclasses call this once while building.
   * Replace-mode pedals pass their circuit's two ends, which then sit between
   * _input and _output. Pre-mode pedals pass nothing and get back the node
   * their circuit should start from.
   */
  _mountCapture(circuitIn, circuitOut) {
    const mode = this.constructor.captureMode;
    const shared = { mode, source: this._input, library: this.library, label: this.name };
    let front = null;
    if (mode === 'replace') {
      this._capture = new CaptureSlot(this.context, { ...shared, destination: this._output, circuit: { input: circuitIn, output: circuitOut } });
    } else {
      front = this.context.createGain();
      this._capture = new CaptureSlot(this.context, { ...shared, destination: front });
    }
    this._capture.onStatus = (status) => this.onCaptureStatus?.(status);
    return front;
  }

  /** 'lib:<id>' to run a capture from the library, null for the built-in circuit. */
  setCapture(value) { this._capture?.set(value); }
  getCapture() { return this._capture?.value ?? null; }

  /** A mono-in, mono-out worklet, or null (with a warning) if it cannot be built. */
  _worklet(processor, params = {}) {
    try {
      const node = new AudioWorkletNode(this.context, processor, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      for (const [name, value] of Object.entries(params)) node.parameters.get(name).value = value;
      return node;
    } catch (e) {
      console.warn(`[${this.name}] ${processor} unavailable, passing the signal through:`, e);
      return null;
    }
  }

  /** k-rate worklet params take setValueAtTime; the processor smooths them. */
  _setWorkletParam(node, name, value) {
    node?.parameters.get(name).setValueAtTime(value, this.context.currentTime);
  }
}

export class NoiseGate extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'noisegate', options);
    this.threshold = -50;
    const front = this._mountCapture();

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
      front.connect(this._gateNode);
      this._gateNode.connect(this._output);
      this._useWorklet = true;
    } catch (e) {
      // Fallback: simple gain node pass-through if worklet not available
      console.warn('[NoiseGate] AudioWorklet unavailable, using bypass:', e);
      front.connect(this._output);
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
  static captureMode = 'replace';
  static captureInactiveParams = ['ratio'];

  constructor(ctx, options) {
    super(ctx, 'compressor', options);
    this._params = { threshold: -24, ratio: 4, attack: 0.003, release: 0.25 };
    // Zero-latency feed-forward compressor; DynamicsCompressorNode delays
    // everything by 6ms of lookahead.
    this._comp = this._worklet('compressor-processor', this._params);
    const circuit = this._comp || ctx.createGain();
    this._mountCapture(circuit, circuit);
  }
  setParam(n, v) {
    if (!(n in this._params)) return;
    this._params[n] = v;
    this._setWorkletParam(this._comp, n, v);
    // A lower threshold hits a compressor capture harder; −24dB is unity.
    if (n === 'threshold') this._capture.setInput(0.5 - (v + 24) / 48);
  }
  getParams() { return { ...this._params }; }
}

export class Overdrive extends BaseEffect {
  static captureMode = 'replace';

  constructor(ctx, options) {
    super(ctx, 'overdrive', options);
    this._drive = 0.5; this._tone = 0.5; this._level = 0.7;
    const voicing = DRIVE_STAGES.overdrive;
    this._stage = createStageNode(ctx, voicing.stages, { label: 'Overdrive' });
    // The Tube Screamer's tone control: a treble shelf over a fixed high cut.
    this._toneShelf = ctx.createBiquadFilter();
    this._toneShelf.type = 'highshelf';
    this._toneShelf.frequency.value = 1600;
    this._postLP = ctx.createBiquadFilter();
    this._postLP.type = 'lowpass';
    this._postLP.frequency.value = 7000;
    this._postLP.Q.value = -3; // dB, as low/high-pass Q is: about Butterworth
    this._levelGain = ctx.createGain();
    this._trim = ctx.createGain();
    this._trimCurve = voicing.trim;

    this._stage.node.connect(this._toneShelf);
    this._toneShelf.connect(this._postLP);
    this._postLP.connect(this._levelGain);
    this._levelGain.connect(this._trim);
    this._mountCapture(this._stage.input || this._stage.node, this._trim);

    for (const [n, v] of Object.entries(this.getParams())) this.setParam(n, v);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'drive') {
      this._drive = v;
      this._stage.setDrive(v);
      this._trim.gain.setTargetAtTime(dbToGain(driveTrim(this._trimCurve, v)), t, 0.01);
      this._capture.setInput(v);
    }
    if (n === 'tone') {
      this._tone = v;
      this._toneShelf.gain.setTargetAtTime(-12 + v * 18, t, 0.01);
      this._capture.setTone(v);
    }
    if (n === 'level') {
      this._level = v;
      this._levelGain.gain.setTargetAtTime(v, t, 0.01);
      this._capture.setLevel(v, 0.7);
    }
  }
  getParams() { return { drive: this._drive, tone: this._tone, level: this._level }; }
}

export class Distortion extends BaseEffect {
  static captureMode = 'replace';

  constructor(ctx, options) {
    super(ctx, 'distortion', options);
    this._gain = 0.5; this._tone = 0.5; this._level = 0.6;
    const voicing = DRIVE_STAGES.distortion;
    this._hp = ctx.createBiquadFilter();
    this._hp.type = 'highpass';
    this._hp.frequency.value = 60;
    this._hp.Q.value = -3;
    this._stage = createStageNode(ctx, voicing.stages, { label: 'Distortion', oversample: voicing.oversample });
    // The RAT's Filter control: a single low-pass swept by octaves.
    this._filter = ctx.createBiquadFilter();
    this._filter.type = 'lowpass';
    this._filter.Q.value = -6; // dB: no resonant peak, like the RAT's single pole
    this._levelGain = ctx.createGain();
    this._trim = ctx.createGain();
    this._trimCurve = voicing.trim;

    this._hp.connect(this._stage.input || this._stage.node);
    this._stage.node.connect(this._filter);
    this._filter.connect(this._levelGain);
    this._levelGain.connect(this._trim);
    this._mountCapture(this._hp, this._trim);

    for (const [n, v] of Object.entries(this.getParams())) this.setParam(n, v);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'gain') {
      this._gain = v;
      this._stage.setDrive(v);
      this._trim.gain.setTargetAtTime(dbToGain(driveTrim(this._trimCurve, v)), t, 0.01);
      this._capture.setInput(v);
    }
    if (n === 'tone') {
      this._tone = v;
      this._filter.frequency.setTargetAtTime(650 * Math.pow(14000 / 650, v), t, 0.01);
      this._capture.setTone(v);
    }
    if (n === 'level') {
      this._level = v;
      this._levelGain.gain.setTargetAtTime(v, t, 0.01);
      this._capture.setLevel(v, 0.6);
    }
  }
  getParams() { return { gain: this._gain, tone: this._tone, level: this._level }; }
}

export class Chorus extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'chorus', options);
    this._rate = 1.5; this._depth = 0.5; this._mix = 0.5;
    const front = this._mountCapture();
    this._node = this._worklet('chorus-processor', { rate: this._rate, depth: this._depth, mix: this._mix });
    if (this._node) {
      front.connect(this._node);
      this._node.connect(this._output);
    } else {
      front.connect(this._output);
    }
  }
  setParam(n, v) {
    if (n === 'rate') { this._rate = v; this._setWorkletParam(this._node, 'rate', v); }
    if (n === 'depth') { this._depth = v; this._setWorkletParam(this._node, 'depth', v); }
    if (n === 'mix') { this._mix = v; this._setWorkletParam(this._node, 'mix', v); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, mix: this._mix }; }
}

export class Delay extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'delay', options);
    this._time = 0.4; this._feedback = 0.4; this._mix = 0.3;
    const front = this._mountCapture();
    this._delay = ctx.createDelay(2.0);
    this._delay.delayTime.value = this._time;

    // Each repeat loses a little top and bottom, the way tape and bucket
    // brigades do, and the loop saturates instead of slamming the limiter
    // when Feedback is pushed.
    this._repeatLP = ctx.createBiquadFilter();
    this._repeatLP.type = 'lowpass';
    this._repeatLP.frequency.value = 4500;
    this._repeatLP.Q.value = -6; // dB — gentle, no peak to build up in the loop
    this._repeatHP = ctx.createBiquadFilter();
    this._repeatHP.type = 'highpass';
    this._repeatHP.frequency.value = 120;
    this._repeatHP.Q.value = -6;
    this._sat = ctx.createWaveShaper();
    this._sat.curve = this._saturationCurve();
    this._fbGain = ctx.createGain(); this._fbGain.gain.value = this._feedback;

    // A slow wow, a couple of cents, so repeats are not sterile copies.
    this._wow = ctx.createOscillator();
    this._wow.frequency.value = 0.55;
    this._wowDepth = ctx.createGain();
    this._wowDepth.gain.value = 0.00025;
    this._wow.connect(this._wowDepth);
    this._wowDepth.connect(this._delay.delayTime);
    this._wow.start();

    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;
    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1;
    front.connect(this._dryGain); this._dryGain.connect(this._output);
    front.connect(this._delay);
    this._delay.connect(this._repeatLP);
    this._repeatLP.connect(this._repeatHP);
    this._repeatHP.connect(this._wetGain); this._wetGain.connect(this._output);
    this._repeatHP.connect(this._sat); this._sat.connect(this._fbGain); this._fbGain.connect(this._delay);
  }

  /** Unity below 0.6, then a tanh knee towards ±1 — clean repeats, a soft ceiling. */
  _saturationCurve(n = 1024, knee = 0.6) {
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  setParam(n, v) {
    const t = this.context.currentTime;
    // Time glides like a tape machine's motor rather than jumping.
    if (n === 'time') { this._time = v; this._delay.delayTime.setTargetAtTime(v, t, 0.08); }
    if (n === 'feedback') { this._feedback = v; this._fbGain.gain.setTargetAtTime(Math.min(v, 0.95), t, 0.01); }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); }
  }
  getParams() { return { time: this._time, feedback: this._feedback, mix: this._mix }; }
}

// Synthesized reverb: shape of the impulse response.
const REVERB = {
  preDelay: 0.012,
  reflections: 14,        // sparse early reflections in the first ~75ms
  fadeIn: 0.015,          // the tail builds up rather than starting as a wall
  brightHz: 9000,         // tail low-pass at the start…
  darkHz: 1500,           // …and at the end: highs die first
  energy: 0.25,           // per channel at 2s: wet ~5dB under dry at full Mix
};

/** Small seeded PRNG, so a given decay always renders the same response. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Reverb extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'reverb', options);
    this._decay = 2.0; this._mix = 0.3;
    const front = this._mountCapture();
    this._convolver = ctx.createConvolver();
    // The wet path is kept out of the mud and the fizz.
    this._wetHP = ctx.createBiquadFilter();
    this._wetHP.type = 'highpass';
    this._wetHP.frequency.value = 150;
    this._wetHP.Q.value = -3;
    this._wetLP = ctx.createBiquadFilter();
    this._wetLP.type = 'lowpass';
    this._wetLP.frequency.value = 8000;
    this._wetLP.Q.value = -3;
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

    front.connect(this._dryGain); this._dryGain.connect(this._output);
    front.connect(this._convolver);
    this._convolver.connect(this._wetHP);
    this._wetHP.connect(this._wetLP);
    this._wetLP.connect(this._wetGain);
    this._wetGain.connect(this._output);
  }

  /** Quarter-second steps — finer than anyone can hear on a reverb tail. */
  _quantizeDecay(decay) {
    return Math.max(0.25, Math.round(decay * 4) / 4);
  }

  /**
   * A stereo impulse response with an RT60 of `decay` seconds: pre-delay,
   * sparse early reflections, then decorrelated noise under an exponential
   * envelope through a low-pass that closes as the tail decays. Each render
   * carries the same energy (scaled gently with decay), so Mix means the same
   * thing at every Decay setting.
   */
  _renderIR(decay) {
    const sr = this.context.sampleRate;
    const pre = Math.round(REVERB.preDelay * sr);
    const tail = Math.max(1, Math.floor(sr * decay));
    const len = pre + tail;
    const buf = this.context.createBuffer(2, len, sr);
    const target = REVERB.energy * Math.sqrt(decay / 2);
    const envStep = Math.exp(Math.log(0.001) / (decay * sr));
    const fadeStep = Math.exp(-1 / (REVERB.fadeIn * sr));
    const lpStep = Math.pow(REVERB.darkHz / REVERB.brightHz, 1 / tail);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const rand = mulberry32((ch + 1) * 0x9E3779B9 ^ Math.round(decay * 100));
      for (let r = 0; r < REVERB.reflections; r++) {
        const t = 0.004 + rand() * 0.07;
        const i = pre + Math.floor(t * sr);
        if (i < len) d[i] += (0.5 + 0.5 * rand()) * 0.7 * Math.exp(-t / 0.05) * (rand() < 0.5 ? -1 : 1);
      }
      let lp = 0, fc = REVERB.brightHz, env = 1, fade = 1;
      for (let n = 0; n < tail; n++) {
        lp += (rand() * 2 - 1 - lp) * (1 - Math.exp(-TWO_PI * fc / sr));
        d[pre + n] += lp * env * (1 - fade);
        fc *= lpStep;
        env *= envStep;
        fade *= fadeStep;
      }
      let energy = 0;
      for (let i = 0; i < len; i++) energy += d[i] * d[i];
      const scale = Math.sqrt(target / (energy || 1));
      for (let i = 0; i < len; i++) d[i] *= scale;
    }
    return buf;
  }

  _applyIR(decay) {
    let buf = this._irCache.get(decay);
    if (!buf) {
      buf = this._renderIR(decay);
      this._irCache.set(decay, buf);
    }
    // Synthesized responses are level-set when rendered; the convolver's own
    // power normalization would undo that.
    this._convolver.normalize = false;
    this._convolver.buffer = buf;
    this._builtDecay = decay;
  }

  async loadIR(arrayBuffer) {
    const ab = await this.context.decodeAudioData(arrayBuffer);
    if (this._irTimer) { clearTimeout(this._irTimer); this._irTimer = null; }
    // A loaded IR can be at any level, so let the convolver normalize it.
    this._convolver.normalize = true;
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
  constructor(ctx, options) {
    super(ctx, 'eq', options);
    this._bass = 0; this._mid = 0; this._treble = 0;
    const front = this._mountCapture();
    // Guitar bands: low end below the mud, the mids a guitar lives in, and the
    // pick and air above them.
    this._low = ctx.createBiquadFilter(); this._low.type = 'lowshelf'; this._low.frequency.value = 120; this._low.gain.value = 0;
    this._midF = ctx.createBiquadFilter(); this._midF.type = 'peaking'; this._midF.frequency.value = 750; this._midF.Q.value = 0.9; this._midF.gain.value = 0;
    this._high = ctx.createBiquadFilter(); this._high.type = 'highshelf'; this._high.frequency.value = 3200; this._high.gain.value = 0;
    front.connect(this._low); this._low.connect(this._midF); this._midF.connect(this._high); this._high.connect(this._output);
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
  constructor(ctx, options) {
    super(ctx, 'phaser', options);
    this._rate = 0.5; this._depth = 0.5; this._feedback = 0.5; this._mix = 0.5;
    const front = this._mountCapture();
    this._node = this._worklet('phaser-processor', {
      rate: this._rateHz(this._rate), depth: this._depth, feedback: this._feedback * 0.85, mix: this._mix,
    });
    if (this._node) {
      front.connect(this._node);
      this._node.connect(this._output);
    } else {
      front.connect(this._output);
    }
  }
  _rateHz(v) { return Math.max(0.02, v * 5); }
  setParam(n, v) {
    if (n === 'rate') { this._rate = v; this._setWorkletParam(this._node, 'rate', this._rateHz(v)); }
    if (n === 'depth') { this._depth = v; this._setWorkletParam(this._node, 'depth', v); }
    if (n === 'feedback') { this._feedback = v; this._setWorkletParam(this._node, 'feedback', v * 0.85); }
    if (n === 'mix') { this._mix = v; this._setWorkletParam(this._node, 'mix', v); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, feedback: this._feedback, mix: this._mix }; }
}

export class Flanger extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'flanger', options);
    this._rate = 0.5; this._depth = 0.5; this._feedback = 0.5; this._mix = 0.5;
    const front = this._mountCapture();
    this._node = this._worklet('flanger-processor', {
      rate: this._rateHz(this._rate), depth: this._depth, feedback: this._feedback * 0.9, mix: this._mix,
    });
    if (this._node) {
      front.connect(this._node);
      this._node.connect(this._output);
    } else {
      front.connect(this._output);
    }
  }
  _rateHz(v) { return Math.max(0.02, v * 5); }
  setParam(n, v) {
    if (n === 'rate') { this._rate = v; this._setWorkletParam(this._node, 'rate', this._rateHz(v)); }
    if (n === 'depth') { this._depth = v; this._setWorkletParam(this._node, 'depth', v); }
    if (n === 'feedback') { this._feedback = v; this._setWorkletParam(this._node, 'feedback', v * 0.9); }
    if (n === 'mix') { this._mix = v; this._setWorkletParam(this._node, 'mix', v); }
  }
  getParams() { return { rate: this._rate, depth: this._depth, feedback: this._feedback, mix: this._mix }; }
}

export class EnvelopeFilter extends BaseEffect {
  constructor(ctx, options) {
    super(ctx, 'envelopefilter', options);
    this._sensitivity = 0.5; this._q = 0.5; this._mix = 1.0;
    const front = this._mountCapture();

    this._dryGain = ctx.createGain(); this._dryGain.gain.value = 1 - this._mix;
    this._wetGain = ctx.createGain(); this._wetGain.gain.value = this._mix;

    // The envelope follower and the resonant filter both run per sample in
    // the worklet, so the sweep tracks the pick instead of trailing it.
    this._envNode = this._worklet('envelope-follower-processor', { sensitivity: this._sensitivity, q: this._q });
    if (this._envNode) {
      front.connect(this._envNode);
      this._envNode.connect(this._wetGain);
      this._useWorklet = true;
    } else {
      // Fallback: no envelope modulation, just a static resonant low-pass
      this._filter = ctx.createBiquadFilter();
      this._filter.type = 'lowpass';
      this._filter.frequency.value = 800;
      this._filter.Q.value = 0.7 + this._q * 11.3;
      front.connect(this._filter);
      this._filter.connect(this._wetGain);
      this._useWorklet = false;
    }
    front.connect(this._dryGain);
    this._wetGain.connect(this._output);
    this._dryGain.connect(this._output);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'sensitivity') { this._sensitivity = v; this._setWorkletParam(this._envNode, 'sensitivity', v); }
    if (n === 'q') {
      this._q = v;
      this._setWorkletParam(this._envNode, 'q', v);
      this._filter?.Q.setTargetAtTime(0.7 + v * 11.3, t, 0.01);
    }
    if (n === 'mix') { this._mix = v; this._wetGain.gain.setTargetAtTime(v, t, 0.01); this._dryGain.gain.setTargetAtTime(1 - v, t, 0.01); }
  }
  getParams() { return { sensitivity: this._sensitivity, q: this._q, mix: this._mix }; }
}

export class Boost extends BaseEffect {
  static captureMode = 'replace';

  constructor(ctx, options) {
    super(ctx, 'boost', options);
    this._gain = 0.5; this._tone = 0.5;
    const voicing = DRIVE_STAGES.boost;
    this._stage = createStageNode(ctx, voicing.stages, { label: 'Boost' });
    // Tone tilts around ~800Hz: brighter thins the lows as it lifts the highs.
    this._low = ctx.createBiquadFilter();
    this._low.type = 'lowshelf';
    this._low.frequency.value = 250;
    this._high = ctx.createBiquadFilter();
    this._high.type = 'highshelf';
    this._high.frequency.value = 1800;

    this._stage.node.connect(this._low);
    this._low.connect(this._high);
    this._mountCapture(this._stage.input || this._stage.node, this._high);

    for (const [n, v] of Object.entries(this.getParams())) this.setParam(n, v);
  }
  setParam(n, v) {
    const t = this.context.currentTime;
    if (n === 'gain') {
      this._gain = v;
      this._stage.setDrive(v);
      this._capture.setInput(v);
    }
    if (n === 'tone') {
      this._tone = v;
      this._low.gain.setTargetAtTime(-(v - 0.5) * 6, t, 0.01);
      this._high.gain.setTargetAtTime((v - 0.5) * 12, t, 0.01);
      this._capture.setTone(v);
    }
  }
  getParams() { return { gain: this._gain, tone: this._tone }; }
}

