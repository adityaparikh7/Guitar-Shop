/**
 * Presets — Factory presets and localStorage save/load.
 */

export const FACTORY_PRESETS = {
  'Clean': {
    effects: {
      noisegate: { enabled: false, params: { threshold: -50 } },
      compressor: { enabled: false, params: { threshold: -20, ratio: 3, attack: 0.003, release: 0.25 } },
      overdrive: { enabled: false, params: { drive: 0.2, tone: 0.6, level: 0.7 } },
      distortion: { enabled: false, params: { gain: 0.1, tone: 0.5, level: 0.6 } },
      chorus: { enabled: false, params: { rate: 1.5, depth: 0.5, mix: 0.3 } },
      delay: { enabled: false, params: { time: 0.3, feedback: 0.2, mix: 0.2 } },
      reverb: { enabled: false, params: { decay: 1.5, mix: 0.15 } },
      eq: { enabled: false, params: { bass: 0, mid: 0, treble: 2 } },
    },
    amp: { enabled: true, params: { gain: 0.2, bass: 0.5, mid: 0.5, treble: 0.6, presence: 0.5, master: 0.7, model: 'clean' } },
  },
  'Blues': {
    effects: {
      noisegate: { enabled: true, params: { threshold: -45 } },
      compressor: { enabled: true, params: { threshold: -18, ratio: 4, attack: 0.005, release: 0.2 } },
      overdrive: { enabled: true, params: { drive: 0.4, tone: 0.55, level: 0.7 } },
      distortion: { enabled: false, params: { gain: 0.3, tone: 0.5, level: 0.5 } },
      chorus: { enabled: false, params: { rate: 1.5, depth: 0.5, mix: 0.3 } },
      delay: { enabled: true, params: { time: 0.35, feedback: 0.25, mix: 0.2 } },
      reverb: { enabled: true, params: { decay: 1.8, mix: 0.2 } },
      eq: { enabled: true, params: { bass: 2, mid: 1, treble: -1 } },
    },
    amp: { enabled: true, params: { gain: 0.45, bass: 0.55, mid: 0.6, treble: 0.5, presence: 0.4, master: 0.65, model: 'crunch' } },
  },
  'Rock': {
    effects: {
      noisegate: { enabled: true, params: { threshold: -40 } },
      compressor: { enabled: true, params: { threshold: -15, ratio: 5, attack: 0.003, release: 0.2 } },
      overdrive: { enabled: false, params: { drive: 0.5, tone: 0.5, level: 0.7 } },
      distortion: { enabled: true, params: { gain: 0.5, tone: 0.55, level: 0.6 } },
      chorus: { enabled: false, params: { rate: 1.5, depth: 0.5, mix: 0.3 } },
      delay: { enabled: true, params: { time: 0.4, feedback: 0.3, mix: 0.2 } },
      reverb: { enabled: true, params: { decay: 2.0, mix: 0.2 } },
      eq: { enabled: true, params: { bass: 3, mid: 2, treble: 1 } },
    },
    amp: { enabled: true, params: { gain: 0.6, bass: 0.6, mid: 0.55, treble: 0.6, presence: 0.5, master: 0.7, model: 'crunch' } },
  },
  'Metal': {
    effects: {
      noisegate: { enabled: true, params: { threshold: -35 } },
      compressor: { enabled: true, params: { threshold: -12, ratio: 6, attack: 0.002, release: 0.15 } },
      overdrive: { enabled: false, params: { drive: 0.5, tone: 0.5, level: 0.7 } },
      distortion: { enabled: true, params: { gain: 0.85, tone: 0.6, level: 0.7 } },
      chorus: { enabled: false, params: { rate: 1.5, depth: 0.5, mix: 0.3 } },
      delay: { enabled: false, params: { time: 0.3, feedback: 0.2, mix: 0.15 } },
      reverb: { enabled: true, params: { decay: 1.2, mix: 0.1 } },
      eq: { enabled: true, params: { bass: 4, mid: -2, treble: 3 } },
    },
    amp: { enabled: true, params: { gain: 0.85, bass: 0.7, mid: 0.4, treble: 0.7, presence: 0.6, master: 0.7, model: 'highgain' } },
  },
  'Ambient': {
    effects: {
      noisegate: { enabled: true, params: { threshold: -50 } },
      compressor: { enabled: true, params: { threshold: -20, ratio: 3, attack: 0.01, release: 0.3 } },
      overdrive: { enabled: false, params: { drive: 0.2, tone: 0.7, level: 0.5 } },
      distortion: { enabled: false, params: { gain: 0.1, tone: 0.5, level: 0.5 } },
      chorus: { enabled: true, params: { rate: 0.8, depth: 0.7, mix: 0.5 } },
      delay: { enabled: true, params: { time: 0.6, feedback: 0.55, mix: 0.45 } },
      reverb: { enabled: true, params: { decay: 4.0, mix: 0.5 } },
      eq: { enabled: true, params: { bass: -2, mid: 0, treble: 4 } },
    },
    amp: { enabled: true, params: { gain: 0.2, bass: 0.4, mid: 0.5, treble: 0.7, presence: 0.6, master: 0.6, model: 'clean' } },
  },
};

export class PresetManager {
  constructor() {
    this._storageKey = 'guitarshop_presets';
  }

  getFactoryPresets() {
    return Object.keys(FACTORY_PRESETS);
  }

  getFactoryPreset(name) {
    return FACTORY_PRESETS[name] ? JSON.parse(JSON.stringify(FACTORY_PRESETS[name])) : null;
  }

  getUserPresets() {
    try {
      const data = localStorage.getItem(this._storageKey);
      return data ? JSON.parse(data) : {};
    } catch { return {}; }
  }

  saveUserPreset(name, data) {
    const presets = this.getUserPresets();
    presets[name] = data;
    localStorage.setItem(this._storageKey, JSON.stringify(presets));
  }

  deleteUserPreset(name) {
    const presets = this.getUserPresets();
    delete presets[name];
    localStorage.setItem(this._storageKey, JSON.stringify(presets));
  }

  getPreset(name) {
    return this.getFactoryPreset(name) || this.getUserPresets()[name] || null;
  }

  getAllPresetNames() {
    return [...this.getFactoryPresets(), ...Object.keys(this.getUserPresets())];
  }
}
