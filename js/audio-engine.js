/**
 * AudioEngine — Core audio context management, device enumeration, and signal chain.
 * Handles USB audio input capture and routing through the effects chain to speakers.
 */
export class AudioEngine {
  constructor() {
    this.context = null;
    this.inputStream = null;
    this.sourceNode = null;
    this.inputGainNode = null;
    this.masterGainNode = null;
    this.analyserInput = null;
    this.analyserOutput = null;
    this.effectsChain = [];
    this.isRunning = false;
    this.selectedDeviceId = null;
    this._parallelTaps = new Set();
  }

  /**
   * Initialize the AudioContext with low-latency settings.
   * Must be called from a user gesture (click/tap).
   */
  async init() {
    if (this.context) return;

    this.context = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });

    // Create master gain
    this.masterGainNode = this.context.createGain();
    this.masterGainNode.gain.value = 0.8;

    // Create input gain — USB interfaces via getUserMedia are much quieter
    // than via a DAW, so we need significant gain boost (default ~+30dB)
    this.inputGainNode = this.context.createGain();
    this.inputGainNode.gain.value = 30.0;

    // Analysers for visualizer
    this.analyserInput = this.context.createAnalyser();
    this.analyserInput.fftSize = 2048;
    this.analyserInput.smoothingTimeConstant = 0.8;

    this.analyserOutput = this.context.createAnalyser();
    this.analyserOutput.fftSize = 2048;
    this.analyserOutput.smoothingTimeConstant = 0.8;

    // Connect master gain → output analyser → destination
    this.masterGainNode.connect(this.analyserOutput);
    this.analyserOutput.connect(this.context.destination);

    console.log(`[AudioEngine] Initialized — sampleRate: ${this.context.sampleRate}, baseLatency: ${this.context.baseLatency?.toFixed(4)}s`);
  }

  /**
   * Enumerate available audio input devices.
   * @param {boolean} requestPermission - If true, requests mic permission first to get device labels.
   * @returns {Array<{deviceId: string, label: string}>}
   */
  async getInputDevices(requestPermission = false) {
    if (requestPermission) {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());
      } catch (e) {
        console.warn('[AudioEngine] Could not get mic permissions:', e);
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Audio Input ${i + 1}`,
      }));
  }

  /**
   * Start capturing audio from the selected input device.
   * @param {string} deviceId - The audio input device ID
   */
  async start(deviceId) {
    if (!this.context) await this.init();

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    // Stop existing stream if any
    this.stopInput();

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };

    try {
      this.inputStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.sourceNode = this.context.createMediaStreamSource(this.inputStream);
      this.selectedDeviceId = deviceId;

      // Connect: source → input gain → input analyser → [effects chain] → master gain
      this.sourceNode.connect(this.inputGainNode);
      this.inputGainNode.connect(this.analyserInput);

      this.rebuildChain();
      this.isRunning = true;

      console.log('[AudioEngine] Started audio capture');
    } catch (err) {
      console.error('[AudioEngine] Failed to start:', err);
      throw err;
    }
  }

  /**
   * Stop audio capture.
   */
  stopInput() {
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.inputStream) {
      this.inputStream.getTracks().forEach(t => t.stop());
      this.inputStream = null;
    }
    this.isRunning = false;
  }

  /**
   * Set the effects chain and rebuild connections.
   * @param {Array} effects - Array of effect instances with getInputNode() and getOutputNode()
   */
  setEffectsChain(effects) {
    this.effectsChain = effects;
    if (this.isRunning) {
      this.rebuildChain();
    }
  }

  /**
   * Rebuild the audio node connections through the effects chain.
   */
  rebuildChain() {
    // Disconnect everything from input analyser forward
    this.analyserInput.disconnect();

    // Disconnect all effects
    this.effectsChain.forEach(fx => {
      try { fx.getOutputNode().disconnect(); } catch (e) { /* ignore */ }
    });

    // Get only active (enabled) effects
    const activeEffects = this.effectsChain.filter(fx => fx.enabled);

    if (activeEffects.length === 0) {
      // No effects — direct connection
      this.analyserInput.connect(this.masterGainNode);
    } else {
      // Connect: analyser → first effect
      this.analyserInput.connect(activeEffects[0].getInputNode());

      // Chain effects together
      for (let i = 0; i < activeEffects.length - 1; i++) {
        activeEffects[i].getOutputNode().connect(activeEffects[i + 1].getInputNode());
      }

      // Last effect → master gain
      activeEffects[activeEffects.length - 1].getOutputNode().connect(this.masterGainNode);
    }

    // Reconnect any parallel taps (tuner analyser, etc.)
    // analyserInput.disconnect() removes ALL outgoing, so we re-attach taps
    this._parallelTaps.forEach(node => {
      try { this.analyserInput.connect(node); } catch (e) { /* ignore */ }
    });

    console.log(`[AudioEngine] Chain rebuilt — ${activeEffects.length} active effects: ${activeEffects.map(fx => fx.name).join(' → ')}`);
  }

  /**
   * Register a node as a parallel tap on the input analyser.
   * These survive rebuildChain() disconnections.
   */
  addParallelTap(node) {
    this._parallelTaps.add(node);
    try { this.analyserInput.connect(node); } catch (e) { /* ignore */ }
  }

  /**
   * Set master volume.
   * @param {number} value - 0 to 1
   */
  setMasterVolume(value) {
    if (this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
    }
  }

  /**
   * Set input gain.
   * @param {number} value - 0 to 100 (linear multiplier)
   */
  setInputGain(value) {
    if (this.inputGainNode) {
      this.inputGainNode.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
    }
  }

  /**
   * Get current context state info.
   */
  getState() {
    return {
      isRunning: this.isRunning,
      contextState: this.context?.state || 'closed',
      sampleRate: this.context?.sampleRate || 0,
      baseLatency: this.context?.baseLatency || 0,
      outputLatency: this.context?.outputLatency || 0,
    };
  }

  /**
   * Destroy everything.
   */
  destroy() {
    this.stopInput();
    if (this.context) {
      this.context.close();
      this.context = null;
    }
  }
}
