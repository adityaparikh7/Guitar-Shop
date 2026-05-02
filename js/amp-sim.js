/**
 * Amp Simulator — Combines pre-gain saturation, 3-band EQ, presence, and cabinet simulation.
 * Three models: Clean, Crunch, High Gain.
 */
export class AmpSim {
  constructor(context) {
    this.context = context;
    this.enabled = true;
    this.name = 'amp';
    this._model = 'clean';

    // Nodes
    this._input = context.createGain();
    this._output = context.createGain();
    this._preGain = context.createGain();
    this._preGain.gain.value = 1;
    this._waveshaper = context.createWaveShaper();
    this._waveshaper.oversample = '4x';

    // 3-band EQ
    this._bass = context.createBiquadFilter();
    this._bass.type = 'lowshelf'; this._bass.frequency.value = 320; this._bass.gain.value = 0;
    this._mid = context.createBiquadFilter();
    this._mid.type = 'peaking'; this._mid.frequency.value = 1000; this._mid.Q.value = 1; this._mid.gain.value = 0;
    this._treble = context.createBiquadFilter();
    this._treble.type = 'highshelf'; this._treble.frequency.value = 3200; this._treble.gain.value = 0;

    // Presence
    this._presence = context.createBiquadFilter();
    this._presence.type = 'peaking';
    this._presence.frequency.value = 5000;
    this._presence.Q.value = 0.7;
    this._presence.gain.value = 0;

    // Cabinet simulation
    this._cabinet = context.createConvolver();
    this._cabBypass = context.createGain();
    this._cabWet = context.createGain();
    this._cabWet.gain.value = 1;
    this._cabBypass.gain.value = 0;
    this._cabEnabled = true;
    this._generateCabIR();

    // Master
    this._master = context.createGain();
    this._master.gain.value = 0.7;

    // Signal chain
    this._input.connect(this._preGain);
    this._preGain.connect(this._waveshaper);
    this._waveshaper.connect(this._bass);
    this._bass.connect(this._mid);
    this._mid.connect(this._treble);
    this._treble.connect(this._presence);
    // Cabinet path
    this._presence.connect(this._cabinet);
    this._cabinet.connect(this._cabWet);
    this._cabWet.connect(this._master);
    // Bypass path
    this._presence.connect(this._cabBypass);
    this._cabBypass.connect(this._master);
    this._master.connect(this._output);

    // Store param values (must be before setModel which writes to _params)
    this._params = { gain: 0.3, bass: 0, mid: 0, treble: 0, presence: 0, master: 0.7, model: 'clean' };

    // Set default model
    this.setModel('clean');
  }

  getInputNode() { return this._input; }
  getOutputNode() { return this._output; }

  _generateCabIR() {
    const sr = this.context.sampleRate;
    const len = Math.floor(sr * 0.05); // 50ms IR
    const buf = this.context.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        // Simulated speaker frequency response
        const t = i / sr;
        const env = Math.exp(-t * 60);
        d[i] = env * (
          Math.sin(2 * Math.PI * 80 * t) * 0.3 +
          Math.sin(2 * Math.PI * 200 * t) * 0.2 +
          (Math.random() * 2 - 1) * 0.1
        );
      }
    }
    this._cabinet.buffer = buf;
  }

  async loadCabIR(arrayBuffer) {
    const ab = await this.context.decodeAudioData(arrayBuffer);
    this._cabinet.buffer = ab;
  }

  setModel(model) {
    this._model = model;
    this._params.model = model;
    const curves = { clean: 1, crunch: 20, highgain: 80 };
    const amount = curves[model] || 1;
    const n = 44100;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      if (model === 'clean') {
        curve[i] = x; // Linear / clean
      } else {
        curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
      }
    }
    this._waveshaper.curve = curve;
  }

  setParam(name, value) {
    const t = this.context.currentTime;
    this._params[name] = value;
    switch (name) {
      case 'gain': this._preGain.gain.setTargetAtTime(0.5 + value * 4, t, 0.01); break;
      case 'bass': this._bass.gain.setTargetAtTime(value * 12 - 6, t, 0.01); break;
      case 'mid': this._mid.gain.setTargetAtTime(value * 12 - 6, t, 0.01); break;
      case 'treble': this._treble.gain.setTargetAtTime(value * 12 - 6, t, 0.01); break;
      case 'presence': this._presence.gain.setTargetAtTime(value * 12 - 6, t, 0.01); break;
      case 'master': this._master.gain.setTargetAtTime(value, t, 0.01); break;
      case 'model': this.setModel(value); break;
    }
  }

  getParams() { return { ...this._params }; }

  toggle() { this.enabled = !this.enabled; return this.enabled; }

  serialize() { return { name: 'amp', enabled: this.enabled, params: this.getParams() }; }
  deserialize(data) {
    this.enabled = data.enabled;
    for (const [k, v] of Object.entries(data.params)) this.setParam(k, v);
  }
}
