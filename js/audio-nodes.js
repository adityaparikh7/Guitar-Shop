/**
 * Small graph helpers shared by the amp and the pedals: a click-free branch
 * switch, and a factory for tube-stage-processor instances with a WaveShaper
 * stand-in for when worklets are unavailable.
 */

// Crossfade time constant, and how long to wait before disconnecting the
// branch that faded out (several time constants).
const FADE_TC = 0.008;
const SETTLE_MS = 80;

export const dbToGain = (db) => Math.pow(10, db / 20);

/**
 * Routes one source into exactly one of several named branches, crossfading
 * their outputs so a switch never clicks. Branches that have faded out are
 * disconnected from the source, so an idle NAM node renders nothing.
 */
export class BranchSwitch {
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

/**
 * A tube-stage-processor instance (js/amp-processor.js), or — if worklets are
 * unavailable — a single oversampled WaveShaper standing in for the whole
 * stage list. Both expose { node, input?, setDrive(v), configure(stages) };
 * connect into `input || node` and out of `node`. `oversample` is 4 or 8.
 */
export function createStageNode(context, stages, { label = 'AmpSim', oversample = 4 } = {}) {
  try {
    const node = new AudioWorkletNode(context, 'tube-stage-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { stages, oversample },
    });
    const drive = node.parameters.get('drive');
    return {
      node,
      setDrive: (v) => drive.setValueAtTime(v, context.currentTime),
      configure: (next) => node.port.postMessage({ type: 'config', stages: next }),
    };
  } catch (e) {
    console.warn(`[${label}] tube-stage-processor unavailable, using a WaveShaper stand-in:`, e);
    return createFallbackStages(context, stages);
  }
}

function createFallbackStages(context, stages) {
  const pre = context.createGain();
  const shaper = context.createWaveShaper();
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
    pre.gain.setTargetAtTime(totalGain(driveValue) / max, context.currentTime, 0.01);
  };
  rebuild();
  return {
    node,
    input: pre,
    setDrive: (v) => { driveValue = v; pre.gain.setTargetAtTime(totalGain(v) / maxGain(), context.currentTime, 0.01); },
    configure: (next) => { current = next; rebuild(); },
  };
}
