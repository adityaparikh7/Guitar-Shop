/**
 * AudioEngine — Core audio context management, device enumeration, and signal chain.
 *
 * Supports two input modes:
 *   1. **Bridge mode** (primary) — Receives audio from the native Swift AudioBridge
 *      via WebSocket. Uses Apple Core Audio for proper per-channel USB device access.
 *   2. **Browser mode** (fallback) — Uses getUserMedia for basic audio input.
 */
export class AudioEngine {
  constructor() {
    this.context = null;
    this.inputGainNode = null;
    this.masterGainNode = null;
    this.analyserInput = null;
    this.analyserOutput = null;
    this.effectsChain = [];
    this.isRunning = false;
    this._parallelTaps = new Set();

    // Bridge mode state
    this._ws = null;
    this._workletNode = null;
    this._bridgeConnected = false;
    this._bridgeSampleRate = 48000;
    this._bridgeDeviceId = null;
    this._bridgeChannel = 0;

    // Browser fallback state
    this.inputStream = null;
    this.sourceNode = null;

    // Callbacks for UI updates
    this.onBridgeStatus = null;   // (connected: boolean, message: string) => void
    this.onBufferHealth = null;   // (health: object) => void

    // Bridge server config
    this.BRIDGE_WS_URL = 'ws://localhost:9876';
    this.BRIDGE_HTTP_URL = 'http://localhost:9877';
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

    // Create input gain — Core Audio bridge delivers proper signal levels,
    // so a moderate boost (6dB) is sufficient. Adjust via the Input knob.
    this.inputGainNode = this.context.createGain();
    this.inputGainNode.gain.value = 2.0;

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

    // Register the AudioWorklet processor for bridge mode
    try {
      await this.context.audioWorklet.addModule('js/audio-stream-processor.js');
      console.log('[AudioEngine] AudioWorklet processor registered');
    } catch (e) {
      console.warn('[AudioEngine] Could not register AudioWorklet:', e);
    }

    console.log(`[AudioEngine] Initialized — sampleRate: ${this.context.sampleRate}, baseLatency: ${this.context.baseLatency?.toFixed(4)}s`);
  }

  // ─── Bridge Mode (Core Audio via Swift AudioBridge) ───────────────────

  /**
   * Check if the AudioBridge is running.
   * @returns {Promise<boolean>}
   */
  async isBridgeAvailable() {
    try {
      const response = await fetch(`${this.BRIDGE_HTTP_URL}/status`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get audio input devices from the Core Audio bridge.
   * Returns devices with full channel info from Core Audio.
   * @returns {Promise<Array<{id: number, uid: string, name: string, inputChannels: number, sampleRate: number}>>}
   */
  async getBridgeDevices() {
    try {
      const response = await fetch(`${this.BRIDGE_HTTP_URL}/devices`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (e) {
      console.warn('[AudioEngine] Failed to get bridge devices:', e);
      return [];
    }
  }

  /**
   * Start audio capture via the Core Audio bridge.
   * This is the primary input method — uses Apple's AVAudioEngine with
   * per-channel routing, just like GarageBand.
   *
   * @param {number} deviceId - Core Audio device ID
   * @param {number} channel - Input channel index (0-based)
   */
  async startFromBridge(deviceId, channel = 0) {
    if (!this.context) await this.init();

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    // Stop any existing input
    this.stopInput();

    this._bridgeDeviceId = deviceId;
    this._bridgeChannel = channel;

    return new Promise((resolve, reject) => {
      try {
        // Connect to the WebSocket bridge
        this._ws = new WebSocket(this.BRIDGE_WS_URL);
        this._ws.binaryType = 'arraybuffer';

        this._ws.onopen = () => {
          console.log('[AudioEngine] Connected to AudioBridge');
          this._bridgeConnected = true;
          this.onBridgeStatus?.(true, 'Connected to AudioBridge');

          // Send start command with device and channel selection
          this._ws.send(JSON.stringify({
            command: 'start',
            deviceId: deviceId,
            channel: channel,
          }));
        };

        this._ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            // Binary audio data — forward to AudioWorklet
            if (this._workletNode) {
              const float32Data = new Float32Array(event.data);
              this._workletNode.port.postMessage(float32Data);
            } else {
              console.warn('[AudioEngine] Received audio but no worklet node!');
            }
          } else {
            // JSON control message
            try {
              const msg = JSON.parse(event.data);
              this._handleBridgeMessage(msg, resolve);
            } catch (e) {
              console.warn('[AudioEngine] Invalid bridge message:', event.data);
            }
          }
        };

        this._ws.onerror = (err) => {
          console.error('[AudioEngine] Bridge WebSocket error:', err);
          this._bridgeConnected = false;
          this.onBridgeStatus?.(false, 'Connection error');
          reject(new Error('WebSocket connection failed. Is the AudioBridge running?'));
        };

        this._ws.onclose = () => {
          console.log('[AudioEngine] Bridge disconnected');
          this._bridgeConnected = false;
          this.onBridgeStatus?.(false, 'Disconnected');
          if (this.isRunning) {
            this.isRunning = false;
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Handle JSON messages from the bridge.
   */
  _handleBridgeMessage(msg, resolveStart) {
    switch (msg.type) {
      case 'status':
        if (msg.status === 'capturing') {
          this._bridgeSampleRate = msg.sampleRate || 48000;
          console.log(`[AudioEngine] Bridge capturing — device ${msg.deviceId}, channel ${msg.channel + 1}, ${this._bridgeSampleRate}Hz`);

          // Create AudioWorklet node and wire it into the graph
          this._setupWorkletNode();
          this.isRunning = true;
          this.onBridgeStatus?.(true, `Capturing — Ch ${msg.channel + 1} @ ${this._bridgeSampleRate}Hz`);
          resolveStart?.();
        } else if (msg.status === 'stopped') {
          this.isRunning = false;
          this.onBridgeStatus?.(true, 'Stopped');
        } else if (msg.status === 'channel_switched') {
          console.log(`[AudioEngine] Bridge switched to channel ${msg.channel + 1}`);
          this.onBridgeStatus?.(true, `Channel ${msg.channel + 1}`);
        }
        break;

      case 'devices':
        // Device list response — handled by getBridgeDevices() via HTTP
        break;

      case 'error':
        console.error('[AudioEngine] Bridge error:', msg.message);
        this.onBridgeStatus?.(true, `Error: ${msg.message}`);
        break;
    }
  }

  /**
   * Create and wire the AudioWorklet node for bridge audio.
   */
  _setupWorkletNode() {
    // Disconnect existing worklet if any
    if (this._workletNode) {
      this._workletNode.disconnect();
    }

    try {
      // Create AudioWorklet node
      this._workletNode = new AudioWorkletNode(this.context, 'audio-stream-processor', {
        numberOfInputs: 0,     // No direct input — we feed data via postMessage
        numberOfOutputs: 1,
        outputChannelCount: [1], // Mono output
      });
    } catch (e) {
      console.error('[AudioEngine] Failed to create AudioWorkletNode. Is the page served over HTTP?', e);
      console.error('[AudioEngine] AudioWorklet requires http:// not file://. Use a local server.');
      return;
    }

    // Listen for buffer health reports
    this._workletNode.port.onmessage = (event) => {
      if (event.data.type === 'health') {
        console.log(`[AudioEngine] Buffer: ${event.data.fillPercent}% full, ${event.data.underruns} underruns`);
        this.onBufferHealth?.(event.data);
      }
    };

    // Connect: workletNode → inputGain → analyserInput → [effects] → masterGain
    this._workletNode.connect(this.inputGainNode);
    this.inputGainNode.connect(this.analyserInput);

    this.rebuildChain();

    console.log('[AudioEngine] AudioWorklet node connected — signal chain ready');
    console.log(`[AudioEngine] Chain: WorkletNode → InputGain(${this.inputGainNode.gain.value}) → Analyser → Effects → MasterGain(${this.masterGainNode.gain.value}) → Destination`);
  }

  /**
   * Switch the capture channel on the running bridge.
   * @param {number} channel - Channel index (0-based)
   */
  switchBridgeChannel(channel) {
    this._bridgeChannel = channel;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        command: 'switch_channel',
        channel: channel,
      }));
    }
  }

  // ─── Browser Fallback Mode (getUserMedia) ─────────────────────────────

  /**
   * Enumerate available audio input devices (browser API).
   * @param {boolean} requestPermission
   * @returns {Array<{deviceId: string, label: string}>}
   */
  async getInputDevices(requestPermission = false) {
    if (!navigator.mediaDevices) {
      console.warn('[AudioEngine] navigator.mediaDevices unavailable (not a secure context)');
      return [];
    }

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
   * Start capturing audio via browser getUserMedia (fallback).
   * @param {string} deviceId - The audio input device ID
   */
  async start(deviceId) {
    if (!this.context) await this.init();

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

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

      // Connect: source → input gain → input analyser → [effects chain] → master gain
      this.sourceNode.connect(this.inputGainNode);
      this.inputGainNode.connect(this.analyserInput);

      this.rebuildChain();
      this.isRunning = true;

      console.log('[AudioEngine] Started audio capture (browser fallback)');
    } catch (err) {
      console.error('[AudioEngine] Failed to start:', err);
      throw err;
    }
  }

  // ─── Common Methods ───────────────────────────────────────────────────

  /**
   * Stop all audio input (bridge or browser).
   */
  stopInput() {
    // Stop bridge
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ command: 'stop' }));
      this._ws.close();
    }
    this._ws = null;

    if (this._workletNode) {
      this._workletNode.port.postMessage('reset');
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    // Stop browser fallback
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.inputStream) {
      this.inputStream.getTracks().forEach(t => t.stop());
      this.inputStream = null;
    }

    this._bridgeConnected = false;
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
      bridgeConnected: this._bridgeConnected,
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
