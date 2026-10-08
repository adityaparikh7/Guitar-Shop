/**
 * Amp Simulator — a built-in tube amp model or a NAM capture, into a cabinet.
 *
 *   input ─┬─ built-in: tight → hump → bright → [preamp stages] → bass/mid/treble
 *          │            → [power stage] → depth → presence → makeup ──────────────┐
 *          └─ NAM:      drive → NamNode → loudness → bass/mid/treble/presence ────┤
 *                                                     crossfade → CAB → master → output
 *   CAB: built-in or loaded IR (two convolvers, A/B) | NAM cab capture | off
 *
 * The preamp and power stages are tube-stage-processor worklets (see
 * amp-processor.js). NAM runs in the vendored wasm engine (vendor/nam/), loaded
 * on first use so a page that never touches a capture never fetches it.
 *
 * Like the pedals, every knob is a normalized 0–1 value; `model` and `cab`
 * are strings, and `lib:<id>` values refer to entries in the CaptureLibrary.
 */
import { AMP_VOICES, CAB_MODELS, DEFAULT_VOICE, DEFAULT_CAB, renderCabIR, normalizeIR } from './amp-models.js';

// The NAM plugin normalizes captures to this output loudness, in dB.
const NAM_TARGET_LOUDNESS = -18;

// Crossfade time constant, and how long to wait before disconnecting the
// branch that faded out (several time constants).
const FADE_TC = 0.008;
const SETTLE_MS = 80;

// The NAM path's tone controls sit at the NAM plugin's own tone-stack corners.
const NAM_EQ = { bass: 150, mid: 425, midQ: 0.7, treble: 1800, range: 10 };
const PRESENCE = { freq: 3500, range: 8 };

const dbToGain = (db) => Math.pow(10, db / 20);

/**
 * Routes one source into exactly one of several named branches, crossfading
 * their outputs so a switch never clicks. Branches that have faded out are
 * disconnected from the source, so an idle NAM node renders nothing.
 */
class BranchSwitch {
  constructor(context, source, destination) {
    this.context = context;
    this.source = source;
    this.destination = destination;
    this.branches = new Map();
    this.connected = new Set();
    this.active = null;
    this._timer = null;
  }

  add(name, input, output) {
    const fade = this.context.createGain();
    fade.gain.value = 0;
    output.connect(fade);
    fade.connect(this.destination);
    this.branches.set(name, { input, fade });
  }

  select(name) {
    const branch = this.branches.get(name);
    if (!branch) return;
    if (!this.connected.has(name)) {
      this.source.connect(branch.input);
      this.connected.add(name);
    }
    const t = this.context.currentTime;
    for (const [n, b] of this.branches) b.fade.gain.setTargetAtTime(n === name ? 1 : 0, t, FADE_TC);
    this.active = name;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._prune(), SETTLE_MS);
  }

  _prune() {
    for (const name of [...this.connected]) {
      if (name === this.active) continue;
      try { this.source.disconnect(this.branches.get(name).input); } catch (e) { /* already gone */ }
      this.connected.delete(name);
    }
  }
}

export class AmpSim {
  /**
   * @param {BaseAudioContext} context
   * @param {object} [options]
   * @param {import('./capture-library.js').CaptureLibrary} [options.library] - resolves `lib:` ids
   */
  constructor(context, { library = null } = {}) {
    this.context = context;
    this.enabled = true;
    this.name = 'amp';
    this.library = library;

    /** (status) => void — { slot: 'amp'|'cab', state: 'builtin'|'loading'|'ready'|'error', ... } */
    this.onStatus = null;

    this._input = context.createGain();
    this._output = context.createGain();
    this._ampOut = context.createGain();
    this._master = context.createGain();
    this._master.connect(this._output);

    this._buildBuiltinPath();
    this._buildNamPath();
    this._buildCab();

    this._paths = new BranchSwitch(context, this._input, this._ampOut);
    this._paths.add('builtin', this._bi.input, this._bi.output);
    this._paths.add('nam', this._nam.input, this._nam.output);

    // Loads are asynchronous; a newer choice bumps the token so an older load
    // that finishes late cannot take over.
    this._ampToken = 0;
    this._cabToken = 0;
    this._voice = AMP_VOICES[DEFAULT_VOICE];
    this._cabIRCache = new Map();
    this._namEngine = null;
    this._namNodes = { amp: null, cab: null };

    // These are knob positions in 0–1, so the tone controls sit at noon.
    this._params = { gain: 0.3, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5, master: 0.7, model: DEFAULT_VOICE, cab: DEFAULT_CAB };

    // Push the defaults into the nodes so the graph matches _params from the start.
    for (const [name, value] of Object.entries(this._params)) {
      this.setParam(name, value);
    }
  }

  getInputNode() { return this._input; }
  getOutputNode() { return this._output; }

  // ─── Graph construction ───────────────────────────────────────────────

  _filter(type, freq, q = Math.SQRT1_2, gain = 0) {
    const f = this.context.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  }

  /**
   * A tube-stage-processor instance, or — if worklets are unavailable — a
   * single oversampled WaveShaper standing in for the whole stage list.
   * Both expose { node, setDrive(v), configure(stages) }.
   */
  _createStages(stages) {
    try {
      const node = new AudioWorkletNode(this.context, 'tube-stage-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { stages },
      });
      const drive = node.parameters.get('drive');
      return {
        node,
        setDrive: (v) => drive.setValueAtTime(v, this.context.currentTime),
        configure: (next) => node.port.postMessage({ type: 'config', stages: next }),
      };
    } catch (e) {
      console.warn('[AmpSim] tube-stage-processor unavailable, using a WaveShaper stand-in:', e);
      return this._createFallbackStages(stages);
    }
  }

  _createFallbackStages(stages) {
    const pre = this.context.createGain();
    const shaper = this.context.createWaveShaper();
    shaper.oversample = '4x';
    pre.connect(shaper);
    const node = { connect: (...a) => shaper.connect(...a), disconnect: (...a) => shaper.disconnect(...a) };
    let current = stages;
    let driveValue = 0.5;
    // The curve covers the largest total gain; the GainNode scales into it.
    const maxGain = () => current.reduce((g, s) => g * (Array.isArray(s.gain) ? s.gain[1] : s.gain ?? 1), 1);
    const totalGain = (v) => current.reduce((g, s) => {
      const [lo, hi] = Array.isArray(s.gain) ? s.gain : [s.gain ?? 1, s.gain ?? 1];
      return g * lo * Math.pow(hi / lo, v);
    }, 1);
    const rebuild = () => {
      const max = maxGain(), n = 4096, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i * 2) / (n - 1) - 1) * max);
      shaper.curve = curve;
      pre.gain.setTargetAtTime(totalGain(driveValue) / max, this.context.currentTime, 0.01);
    };
    rebuild();
    return {
      node,
      input: pre,
      setDrive: (v) => { driveValue = v; pre.gain.setTargetAtTime(totalGain(v) / maxGain(), this.context.currentTime, 0.01); },
      configure: (next) => { current = next; rebuild(); },
    };
  }

  _buildBuiltinPath() {
    const v = AMP_VOICES[DEFAULT_VOICE];
    const bi = {};
    bi.tight = this._filter('highpass', v.tight);
    bi.hump = this._filter('peaking', 800, 0.7, 0);
    bi.bright = this._filter('highshelf', v.bright.freq);
    bi.pre = this._createStages(v.pre);
    bi.bass = this._filter('lowshelf', v.stack.bass);
    bi.mid = this._filter('peaking', v.stack.mid, v.stack.midQ);
    bi.treble = this._filter('highshelf', v.stack.treble);
    bi.power = this._createStages([v.power]);
    bi.depth = this._filter('peaking', v.depth.freq, v.depth.q, v.depth.gain);
    bi.presence = this._filter('highshelf', PRESENCE.freq);
    bi.makeup = this.context.createGain();

    bi.tight.connect(bi.hump);
    bi.hump.connect(bi.bright);
    bi.bright.connect(bi.pre.input || bi.pre.node);
    bi.pre.node.connect(bi.bass);
    bi.bass.connect(bi.mid);
    bi.mid.connect(bi.treble);
    bi.treble.connect(bi.power.input || bi.power.node);
    bi.power.node.connect(bi.depth);
    bi.depth.connect(bi.presence);
    bi.presence.connect(bi.makeup);

    bi.input = bi.tight;
    bi.output = bi.makeup;
    this._bi = bi;
    // The stage worklets were constructed with this voice's stages.
    this._configuredVoice = v;
  }

  _buildNamPath() {
    const nam = {};
    nam.drive = this.context.createGain();
    nam.loudness = this.context.createGain();
    nam.bass = this._filter('lowshelf', NAM_EQ.bass);
    nam.mid = this._filter('peaking', NAM_EQ.mid, NAM_EQ.midQ);
    nam.treble = this._filter('highshelf', NAM_EQ.treble);
    nam.presence = this._filter('highshelf', PRESENCE.freq);
    // The NamNode is spliced in between drive and loudness once it exists.
    nam.loudness.connect(nam.bass);
    nam.bass.connect(nam.mid);
    nam.mid.connect(nam.treble);
    nam.treble.connect(nam.presence);
    nam.input = nam.drive;
    nam.output = nam.presence;
    this._nam = nam;
  }

  _buildCab() {
    const makeConvolver = () => {
      const c = this.context.createConvolver();
      // Every IR is level-matched by normalizeIR(); the convolver's own
      // power normalization would undo that.
      c.normalize = false;
      return c;
    };
    this._convA = makeConvolver();
    this._convB = makeConvolver();
    // The cab NamNode is spliced in between these two once it exists.
    this._cabNamIn = this.context.createGain();
    this._cabNamLoudness = this.context.createGain();
    this._cabOff = this.context.createGain();

    this._cab = new BranchSwitch(this.context, this._ampOut, this._master);
    this._cab.add('irA', this._convA, this._convA);
    this._cab.add('irB', this._convB, this._convB);
    this._cab.add('nam', this._cabNamIn, this._cabNamLoudness);
    this._cab.add('off', this._cabOff, this._cabOff);
  }

  // ─── Parameters ───────────────────────────────────────────────────────

  setParam(name, value) {
    this._params[name] = value;
    switch (name) {
      case 'gain': case 'bass': case 'mid': case 'treble': case 'presence':
        this._applyTone(name);
        break;
      case 'master':
        this._master.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
        break;
      case 'model':
        this.setModel(value);
        break;
      case 'cab':
        this.setCab(value);
        break;
    }
  }

  getParams() { return { ...this._params }; }

  toggle() { this.enabled = !this.enabled; return this.enabled; }

  /** Push one knob into both paths — cheap, and the inactive one is ready to go. */
  _applyTone(name) {
    const t = this.context.currentTime;
    const v = this._params[name];
    const voice = this._voice;
    const bi = this._bi, nam = this._nam;
    const set = (param, value) => param.setTargetAtTime(value, t, 0.01);
    switch (name) {
      case 'gain':
        bi.pre.setDrive(v);
        // The bright cap is bypassed as the gain pot opens up.
        set(bi.bright.gain, voice.bright.db * (1 - v));
        set(nam.drive.gain, dbToGain((v - 0.5) * 24));
        break;
      case 'bass':
        set(bi.bass.gain, (v - 0.5) * 2 * voice.stack.range);
        set(nam.bass.gain, (v - 0.5) * 2 * NAM_EQ.range);
        break;
      case 'mid':
        set(bi.mid.gain, voice.stack.midBase + (v - 0.5) * 2 * voice.stack.range);
        set(nam.mid.gain, (v - 0.5) * 2 * NAM_EQ.range);
        break;
      case 'treble':
        set(bi.treble.gain, (v - 0.5) * 2 * voice.stack.range);
        set(nam.treble.gain, (v - 0.5) * 2 * NAM_EQ.range);
        break;
      case 'presence':
        set(bi.presence.gain, (v - 0.5) * 2 * PRESENCE.range);
        set(nam.presence.gain, (v - 0.5) * 2 * PRESENCE.range);
        break;
    }
  }

  /** Retune the built-in path to a voice. Frequencies glide; the worklets crossfade internally. */
  _applyVoice(voice) {
    this._voice = voice;
    const t = this.context.currentTime;
    const bi = this._bi;
    const glide = (param, value) => param.setTargetAtTime(value, t, 0.01);
    glide(bi.tight.frequency, voice.tight);
    glide(bi.hump.frequency, voice.hump?.freq ?? 800);
    glide(bi.hump.Q, voice.hump?.q ?? 0.7);
    glide(bi.hump.gain, voice.hump?.gain ?? 0);
    glide(bi.bright.frequency, voice.bright.freq);
    glide(bi.bass.frequency, voice.stack.bass);
    glide(bi.mid.frequency, voice.stack.mid);
    glide(bi.mid.Q, voice.stack.midQ);
    glide(bi.treble.frequency, voice.stack.treble);
    glide(bi.depth.frequency, voice.depth.freq);
    glide(bi.depth.Q, voice.depth.q);
    glide(bi.depth.gain, voice.depth.gain);
    glide(bi.makeup.gain, voice.makeup);
    // Reconfiguring makes the worklets crossfade, so only do it on a real change.
    if (voice !== this._configuredVoice) {
      bi.pre.configure(voice.pre);
      bi.power.configure([voice.power]);
      this._configuredVoice = voice;
    }
    for (const knob of ['gain', 'bass', 'mid', 'treble', 'presence']) this._applyTone(knob);
  }

  _status(slot, status) {
    try { this.onStatus?.({ slot, ...status }); } catch (e) { console.error('[AmpSim] onStatus handler failed:', e); }
  }

  // ─── Amp model ────────────────────────────────────────────────────────

  /** 'clean' | 'crunch' | 'highgain' | 'lib:<id>' (a NAM capture). */
  setModel(model) {
    this._params.model = model;
    const token = ++this._ampToken;
    if (typeof model === 'string' && model.startsWith('lib:')) {
      this._loadAmpCapture(model.slice(4), token);
      return;
    }
    const key = AMP_VOICES[model] ? model : DEFAULT_VOICE;
    this._params.model = key;
    this._applyVoice(AMP_VOICES[key]);
    this._paths.select('builtin');
    this._status('amp', { state: 'builtin', model: key });
  }

  async _loadAmpCapture(id, token) {
    this._status('amp', { state: 'loading', id });
    try {
      const entry = await this.library?.get(id);
      if (!entry || entry.kind !== 'nam') throw new Error('This capture is no longer in your library.');
      const node = await this._ensureNamNode('amp');
      if (token !== this._ampToken) return;
      const info = await node.loadModel(entry.data);
      if (token !== this._ampToken) return;
      this._nam.loudness.gain.setTargetAtTime(this._loudnessGain(info), this.context.currentTime, 0.01);
      this._paths.select('nam');
      this._status('amp', { state: 'ready', id, entry: this._entryMeta(entry), info, rateMismatch: this._rateMismatch(info) });
    } catch (err) {
      if (token !== this._ampToken) return;
      console.error('[AmpSim] Could not load NAM capture:', err);
      this._params.model = DEFAULT_VOICE;
      this._applyVoice(AMP_VOICES[DEFAULT_VOICE]);
      this._paths.select('builtin');
      this._status('amp', { state: 'error', id, error: err?.message || String(err), fallback: DEFAULT_VOICE });
    }
  }

  // ─── Cabinet ──────────────────────────────────────────────────────────

  /** '4x12' | '2x12' | '1x12' | 'off' | 'lib:<id>' (an IR or a NAM cab capture). */
  setCab(cab) {
    this._params.cab = cab;
    const token = ++this._cabToken;
    if (typeof cab === 'string' && cab.startsWith('lib:')) {
      this._loadCabCapture(cab.slice(4), token);
      return;
    }
    if (cab === 'off') {
      this._cab.select('off');
      this._status('cab', { state: 'builtin', cab });
      return;
    }
    const key = CAB_MODELS[cab] ? cab : DEFAULT_CAB;
    this._params.cab = key;
    this._useIR(this._builtinCabIR(key));
    this._status('cab', { state: 'builtin', cab: key });
  }

  _builtinCabIR(key) {
    let buf = this._cabIRCache.get(key);
    if (!buf) {
      const sr = this.context.sampleRate;
      const data = renderCabIR(sr, CAB_MODELS[key]);
      buf = this.context.createBuffer(1, data.length, sr);
      buf.copyToChannel(data, 0);
      this._cabIRCache.set(key, buf);
    }
    return buf;
  }

  /** Load an IR into whichever convolver is idle, then crossfade to it. */
  _useIR(buffer) {
    const next = this._cab.active === 'irA' ? 'irB' : 'irA';
    (next === 'irA' ? this._convA : this._convB).buffer = buffer;
    this._cab.select(next);
  }

  async _decodeLibraryIR(entry) {
    const cacheKey = `lib:${entry.id}`;
    let buf = this._cabIRCache.get(cacheKey);
    if (buf) return buf;
    // decodeAudioData detaches its argument, and resamples to the context rate.
    const decoded = await this.context.decodeAudioData(entry.data.slice(0));
    const sr = this.context.sampleRate;
    // A cabinet is mono: keep the first channel.
    const data = normalizeIR(decoded.getChannelData(0).slice(), sr);
    buf = this.context.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    this._cabIRCache.set(cacheKey, buf);
    return buf;
  }

  async _loadCabCapture(id, token) {
    this._status('cab', { state: 'loading', id });
    try {
      const entry = await this.library?.get(id);
      if (!entry) throw new Error('This cabinet is no longer in your library.');
      if (entry.kind === 'ir') {
        const buffer = await this._decodeLibraryIR(entry);
        if (token !== this._cabToken) return;
        this._useIR(buffer);
        this._status('cab', { state: 'ready', id, entry: this._entryMeta(entry) });
      } else {
        const node = await this._ensureNamNode('cab');
        if (token !== this._cabToken) return;
        const info = await node.loadModel(entry.data);
        if (token !== this._cabToken) return;
        this._cabNamLoudness.gain.setTargetAtTime(this._loudnessGain(info), this.context.currentTime, 0.01);
        this._cab.select('nam');
        this._status('cab', { state: 'ready', id, entry: this._entryMeta(entry), info, rateMismatch: this._rateMismatch(info) });
      }
    } catch (err) {
      if (token !== this._cabToken) return;
      console.error('[AmpSim] Could not load cabinet:', err);
      this._params.cab = DEFAULT_CAB;
      this._useIR(this._builtinCabIR(DEFAULT_CAB));
      this._status('cab', { state: 'error', id, error: err?.message || String(err), fallback: DEFAULT_CAB });
    }
  }

  // ─── NAM engine ───────────────────────────────────────────────────────

  /** The NamNode for a slot, creating the engine and the node on first use. */
  _ensureNamNode(slot) {
    if (!this._namNodes[slot]) {
      this._namNodes[slot] = (async () => {
        if (!this._namEngine) {
          this._namEngine = import('../vendor/nam/index.js').then(m => m.NamEngine.attach(this.context));
          this._namEngine.catch(() => { this._namEngine = null; });
        }
        const engine = await this._namEngine;
        const node = await engine.createNode();
        if (slot === 'amp') {
          this._nam.drive.connect(node);
          node.connect(this._nam.loudness);
        } else {
          this._cabNamIn.connect(node);
          node.connect(this._cabNamLoudness);
        }
        return node;
      })();
      // Let a later attempt retry from scratch after a failure.
      this._namNodes[slot].catch(() => { this._namNodes[slot] = null; });
    }
    return this._namNodes[slot];
  }

  _loudnessGain(info) {
    return info?.hasLoudness && Number.isFinite(info.loudness)
      ? dbToGain(NAM_TARGET_LOUDNESS - info.loudness)
      : 1;
  }

  _rateMismatch(info) {
    const expected = info?.expectedSampleRate;
    return expected > 0 && Math.abs(expected - this.context.sampleRate) > 1 ? expected : null;
  }

  /** Library entry without its payload, for status reports. */
  _entryMeta(entry) {
    const { data, ...meta } = entry;
    return meta;
  }
}
