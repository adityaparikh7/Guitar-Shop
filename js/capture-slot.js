/**
 * NAM captures outside the amp: the shared engine loader and helpers, plus
 * CaptureSlot — the splice point that lets any pedal run a NAM capture.
 *
 * A slot works in one of two modes:
 *
 *   replace  source ─┬─ built-in circuit ─────────────────────────────┐
 *                    └─ trim → NamNode → norm → tilt → level ─────────┴─ destination
 *   pre      source ─┬─ thru ───────────────────────┐
 *                    └─ trim → NamNode → norm ──────┴─ destination (the circuit's input)
 *
 * `replace` is for drive and dynamics pedals, where a capture *is* the pedal;
 * `pre` is for filter, modulation, time and EQ pedals — NAM cannot model an
 * LFO or a long delay, so the capture colours the signal ahead of the effect
 * and every knob keeps working. The two branches crossfade through a
 * BranchSwitch, so an idle NamNode is disconnected and renders nothing.
 */
import { BranchSwitch, dbToGain } from './audio-nodes.js';

// The NAM plugin normalizes captures to this output loudness, in dB.
export const NAM_TARGET_LOUDNESS = -18;

// Pedal captures play at their own gain — a boost should boost. Anything else
// dropped into a pedal (an amp, a preamp, a full rig) is loudness-normalized.
const UNNORMALIZED_GEAR = new Set(['pedal']);

// Tilt EQ corners for a capture's Tone control, and its range at each end.
const TILT = { low: 300, high: 2000, range: 6 };

// One engine promise per context; NamEngine.attach() is idempotent anyway,
// this just keeps the dynamic import to one place.
const engines = new WeakMap();

/**
 * The vendored NAM engine attached to a context, imported on first use so a
 * page that never touches a capture never fetches it.
 */
export function loadNamEngine(context) {
  let engine = engines.get(context);
  if (!engine) {
    engine = import('../vendor/nam/index.js').then(m => m.NamEngine.attach(context));
    engines.set(context, engine);
    // Let a later attempt retry from scratch after a failure.
    engine.catch(() => engines.delete(context));
  }
  return engine;
}

/** Gain that brings a capture to the target loudness, or 1 if it has no loudness metadata. */
export function loudnessGain(info, target = NAM_TARGET_LOUDNESS) {
  return info?.hasLoudness && Number.isFinite(info.loudness)
    ? dbToGain(target - info.loudness)
    : 1;
}

/** The rate a capture was trained at, when it differs from the context's — else null. */
export function rateMismatch(info, sampleRate) {
  const expected = info?.expectedSampleRate;
  return expected > 0 && Math.abs(expected - sampleRate) > 1 ? expected : null;
}

/** Library entry without its payload, for status reports. */
export function entryMeta(entry) {
  const { data, ...meta } = entry;
  return meta;
}

/** `lib:<id>` → id, anything else → null. */
export function libraryId(value) {
  return typeof value === 'string' && value.startsWith('lib:') ? value.slice(4) : null;
}

export class CaptureSlot {
  /**
   * @param {BaseAudioContext} context
   * @param {object} options
   * @param {'replace'|'pre'} options.mode
   * @param {AudioNode} options.source - feeds the slot
   * @param {AudioNode} options.destination - where both branches end up
   * @param {{input: AudioNode, output: AudioNode}} [options.circuit] - the built-in branch (replace mode)
   * @param {import('./capture-library.js').CaptureLibrary} [options.library] - resolves `lib:` ids
   * @param {string} [options.label] - for log messages
   */
  constructor(context, { mode, source, destination, circuit = null, library = null, label = 'pedal' }) {
    this.context = context;
    this.mode = mode;
    this.library = library;
    this.label = label;

    /** (status) => void — { state: 'builtin'|'loading'|'ready'|'error', id?, entry?, info?, rateMismatch?, error? } */
    this.onStatus = null;

    this.value = null;
    // A newer choice bumps the token, so a load that finishes late loses.
    this._token = 0;
    this._node = null;

    this.trim = context.createGain();
    this.norm = context.createGain();
    let tail = this.norm;
    if (mode === 'replace') {
      this.low = this._shelf('lowshelf', TILT.low);
      this.high = this._shelf('highshelf', TILT.high);
      this.level = context.createGain();
      this.norm.connect(this.low);
      this.low.connect(this.high);
      this.high.connect(this.level);
      tail = this.level;
    }

    this._switch = new BranchSwitch(context, source, destination);
    if (mode === 'replace') {
      this._switch.add('builtin', circuit.input, circuit.output);
    } else {
      const thru = context.createGain();
      this._switch.add('builtin', thru, thru);
    }
    // The NamNode is spliced in between trim and norm once it exists.
    this._switch.add('nam', this.trim, tail);
    this._switch.select('builtin');
  }

  _shelf(type, freq) {
    const f = this.context.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.gain.value = 0;
    return f;
  }

  /** Whether a capture is the branch that is playing. */
  get active() { return this._switch.active === 'nam'; }

  // ─── Knob mappings (replace mode; harmless no-ops in pre mode) ─────────

  /** How hard the capture is hit: noon is unity, ±12dB at the ends. */
  setInput(v) {
    this.trim.gain.setTargetAtTime(dbToGain((v - 0.5) * 24), this.context.currentTime, 0.01);
  }

  /** Tilt around ~800Hz, flat at noon — the capture already has its pedal's own tone. */
  setTone(v) {
    if (!this.low) return;
    const t = this.context.currentTime;
    const db = (v - 0.5) * 2 * TILT.range;
    this.low.gain.setTargetAtTime(-db, t, 0.01);
    this.high.gain.setTargetAtTime(db, t, 0.01);
  }

  /** Output level: unity at `unityAt`, silent at 0, +10dB at full. */
  setLevel(v, unityAt) {
    if (!this.level) return;
    const gain = v <= unityAt ? v / unityAt : dbToGain(((v - unityAt) / (1 - unityAt)) * 10);
    this.level.gain.setTargetAtTime(gain, this.context.currentTime, 0.01);
  }

  // ─── Capture selection ────────────────────────────────────────────────

  /** 'lib:<id>' to run a capture, anything else for the built-in circuit. */
  set(value) {
    const id = libraryId(value);
    // Re-applying a preset names the same capture again; reparsing it would
    // stall the audio thread for nothing.
    if (id && value === this.value) return;
    this.value = id ? value : null;
    const token = ++this._token;
    if (!id) {
      this._switch.select('builtin');
      this._status({ state: 'builtin' });
      return;
    }
    this._load(id, token);
  }

  async _load(id, token) {
    this._status({ state: 'loading', id });
    try {
      const entry = await this.library?.get(id);
      if (!entry || entry.kind !== 'nam') throw new Error('This capture is no longer in your library.');
      const node = await this._ensureNode();
      if (token !== this._token) return;
      const info = await node.loadModel(entry.data);
      if (token !== this._token) return;
      const normalize = !UNNORMALIZED_GEAR.has(entry.gearType ?? 'pedal');
      this.norm.gain.setTargetAtTime(normalize ? loudnessGain(info) : 1, this.context.currentTime, 0.01);
      this._switch.select('nam');
      this._status({ state: 'ready', id, entry: entryMeta(entry), info, rateMismatch: rateMismatch(info, this.context.sampleRate) });
    } catch (err) {
      if (token !== this._token) return;
      console.error(`[${this.label}] Could not load NAM capture:`, err);
      this.value = null;
      this._switch.select('builtin');
      this._status({ state: 'error', id, error: err?.message || String(err), fallback: null });
    }
  }

  /** The slot's NamNode, creating the engine and the node on first use. */
  _ensureNode() {
    if (!this._node) {
      this._node = (async () => {
        const engine = await loadNamEngine(this.context);
        const node = await engine.createNode();
        this.trim.connect(node);
        node.connect(this.norm);
        return node;
      })();
      this._node.catch(() => { this._node = null; });
    }
    return this._node;
  }

  _status(status) {
    try { this.onStatus?.(status); } catch (e) { console.error(`[${this.label}] onStatus handler failed:`, e); }
  }
}
