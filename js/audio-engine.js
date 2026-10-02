/**
 * AudioEngine — Core audio context management, device enumeration, and signal chain.
 *
 * Supports two input modes:
 *   1. **Bridge mode** (primary) — Receives audio from the native Swift AudioBridge
 *      via WebSocket. Uses Apple Core Audio for proper per-channel USB device access.
 *   2. **Browser mode** (fallback) — Uses getUserMedia for basic audio input.
 *
 * Audio transport uses SharedArrayBuffer for zero-copy delivery to the AudioWorklet
 * when cross-origin isolation is available, falling back to postMessage otherwise.
 */

// ─── SharedArrayBuffer ring buffer constants (must match audio-stream-processor.js) ──
const CTRL_WRITE_POS = 0;
const CTRL_READ_POS = 1;
const CTRL_CAPACITY = 2;

// Ring capacity is headroom, not latency — a capture callback can hand us
// thousands of samples at once, and anything that does not fit is audio lost.
// The worklet caps latency by trimming its own read cursor instead.
const RING_BUFFER_SIZE = 16384;

// Verbose per-frame logging is opt-in: append ?debug to the URL.
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

export class AudioEngine {
  constructor() {
    this.context = null;
    this.inputGainNode = null;
    this.masterGainNode = null;
    this.limiterNode = null;
    this.muteNode = null;
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

    // SharedArrayBuffer transport
    this._useSAB = false;
    this._ringBufferSAB = null;
    this._controlSAB = null;
    this._ringBufferView = null;
    this._controlView = null;
    this._sabOverflowCount = 0;

    // Largest capture chunk seen so far. AVAudioEngine ignores the tap buffer
    // size it is asked for and can deliver 100ms at a time, so the buffering
    // targets are derived from what actually arrives rather than guessed.
    this._maxChunkSamples = 0;

    // Settles the promise returned by startFromBridge(), exactly once.
    this._pendingStart = null;

    // Browser fallback state
    this.inputStream = null;
    this.sourceNode = null;

    // Local source state (test signal — generated buffer or decoded file)
    this._localSourceNode = null;

    // Global bypass — routes input straight to master, skipping every effect
    // and the amp, without touching any pedal's own enabled state.
    this.bypassAll = false;

    // Callbacks for UI updates
    this.onBridgeStatus = null;   // (connected: boolean, message: string) => void
    this.onBufferHealth = null;   // (health: object) => void
    this.onLocalSourceStopped = null; // () => void — fired when stopInput() tears down a local source

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
      sampleRate: 48000,
    });

    // Create master gain
    this.masterGainNode = this.context.createGain();
    this.masterGainNode.gain.value = 0.8;

    // Create input gain — Core Audio bridge delivers proper signal levels,
    // so a moderate boost (6dB) is sufficient. Adjust via the Input knob.
    this.inputGainNode = this.context.createGain();
    this.inputGainNode.gain.value = 2.0;

    // Analysers for visualizer — reduced fftSize and smoothing for lower overhead
    this.analyserInput = this.context.createAnalyser();
    this.analyserInput.fftSize = 1024;
    this.analyserInput.smoothingTimeConstant = 0.5;

    this.analyserOutput = this.context.createAnalyser();
    this.analyserOutput.fftSize = 1024;
    this.analyserOutput.smoothingTimeConstant = 0.5;

    // Safety limiter — the chain can reach enormous gain (input trim × boost ×
    // two drives × amp pre-gain) and the delay/flanger feedback paths can
    // self-oscillate, so nothing may leave here above full scale. A shaped
    // curve is used rather than a compressor because it adds no lookahead
    // latency, which matters when you are playing through this live.
    this.limiterNode = this.context.createWaveShaper();
    this.limiterNode.curve = this._makeLimiterCurve();
    // No oversampling: it would add filter latency to the always-on master
    // path, and the curve is unity below the knee so there is little to alias.
    this.limiterNode.oversample = 'none';

    // Dedicated mute, so muting (e.g. while tuning) never disturbs the
    // master volume the user set.
    this.muteNode = this.context.createGain();
    this.muteNode.gain.value = 1;

    // Connect master gain → limiter → mute → output analyser → destination
    this.masterGainNode.connect(this.limiterNode);
    this.limiterNode.connect(this.muteNode);
    this.muteNode.connect(this.analyserOutput);
    this.analyserOutput.connect(this.context.destination);

    // Check SharedArrayBuffer availability — requires crossOriginIsolated (COOP/COEP headers)
    this._useSAB = false;
    if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
      try {
        this._ringBufferSAB = new SharedArrayBuffer(RING_BUFFER_SIZE * Float32Array.BYTES_PER_ELEMENT);
        this._controlSAB = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
        this._ringBufferView = new Float32Array(this._ringBufferSAB);
        this._controlView = new Int32Array(this._controlSAB);
        // Initialize control block
        Atomics.store(this._controlView, CTRL_WRITE_POS, 0);
        Atomics.store(this._controlView, CTRL_READ_POS, 0);
        Atomics.store(this._controlView, CTRL_CAPACITY, RING_BUFFER_SIZE);
        this._useSAB = true;
        console.log('[AudioEngine] SharedArrayBuffer available — using zero-copy transport');
      } catch (e) {
        console.warn('[AudioEngine] SharedArrayBuffer allocation failed, using postMessage:', e);
        this._useSAB = false;
      }
    } else {
      console.warn(`[AudioEngine] SharedArrayBuffer unavailable (crossOriginIsolated=${self.crossOriginIsolated}) — using postMessage transport`);
    }

    // Register AudioWorklet processors
    try {
      await this.context.audioWorklet.addModule('js/audio-stream-processor.js');
      await this.context.audioWorklet.addModule('js/gate-processor.js');
      await this.context.audioWorklet.addModule('js/envelope-processor.js');
      console.log('[AudioEngine] AudioWorklet processors registered');
    } catch (e) {
      console.warn('[AudioEngine] Could not register AudioWorklet:', e);
    }

    console.log(`[AudioEngine] Initialized — sampleRate: ${this.context.sampleRate}, baseLatency: ${this.context.baseLatency?.toFixed(4)}s, transport: ${this._useSAB ? 'SAB' : 'postMessage'}`);
  }

  /**
   * Soft-knee limiting curve: unity below the knee, asymptotic to ±1 above it.
   * Normal playing levels pass through untouched; only peaks are shaped.
   */
  _makeLimiterCurve(knee = 0.7, n = 4096) {
    const curve = new Float32Array(n);
    const span = 1 - knee;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  /**
   * Mute or unmute the output without touching the master volume.
   * @param {boolean} muted
   */
  setMuted(muted) {
    if (this.muteNode) {
      this.muteNode.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.01);
    }
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
    this._maxChunkSamples = 0;

    return new Promise((resolve, reject) => {
      // The bridge can fail in ways that produce no 'capturing' status at all
      // (device busy, bad device id, socket closed on us). Every one of those
      // paths has to settle this promise, or the caller awaits forever.
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this._pendingStart = null;
        if (err) reject(err); else resolve();
      };
      const timeoutId = setTimeout(
        () => settle(new Error('AudioBridge did not start capturing within 5s.')),
        5000,
      );
      this._pendingStart = settle;

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
            // Binary audio data — write to transport
            const float32Data = new Float32Array(event.data);

            // Debug: count incoming audio messages
            this._wsAudioMsgCount = (this._wsAudioMsgCount || 0) + 1;
            if (DEBUG && (this._wsAudioMsgCount <= 3 || this._wsAudioMsgCount % 1000 === 0)) {
              console.log(`[AudioEngine] WS audio msg #${this._wsAudioMsgCount}: ${float32Data.length} samples, useSAB=${this._useSAB}, worklet=${!!this._workletNode}`);
            }

            // Size the worklet's pre-fill and latency cap to the real capture
            // cadence. A cap below one chunk makes the reader trim audio away
            // and then starve again on every burst.
            if (float32Data.length > this._maxChunkSamples) {
              this._maxChunkSamples = float32Data.length;
              this._sendTransportConfig();
            }

            if (this._useSAB && this._ringBufferView && this._controlView) {
              // Zero-copy: write directly into SharedArrayBuffer
              this._writeToSAB(float32Data);
            } else if (this._workletNode) {
              // Fallback: postMessage copy
              this._workletNode.port.postMessage(float32Data);
            } else {
              // Worklet not yet created — drop this chunk (will be a few ms at most)
            }
          } else {
            // JSON control message
            try {
              const msg = JSON.parse(event.data);
              this._handleBridgeMessage(msg, settle);
            } catch (e) {
              console.warn('[AudioEngine] Invalid bridge message:', event.data);
            }
          }
        };

        this._ws.onerror = (err) => {
          console.error('[AudioEngine] Bridge WebSocket error:', err);
          this._bridgeConnected = false;
          this.onBridgeStatus?.(false, 'Connection error');
          settle(new Error('WebSocket connection failed. Is the AudioBridge running?'));
        };

        this._ws.onclose = () => {
          console.log('[AudioEngine] Bridge disconnected');
          this._bridgeConnected = false;
          this.onBridgeStatus?.(false, 'Disconnected');
          if (this.isRunning) {
            this.isRunning = false;
          }
          settle(new Error('AudioBridge closed the connection before capture started.'));
        };
      } catch (err) {
        settle(err);
      }
    });
  }

  /**
   * Write audio samples directly into the SharedArrayBuffer ring buffer.
   * Called from the main thread's WebSocket onmessage handler.
   */
  _writeToSAB(samples) {
    const buf = this._ringBufferView;
    const ctrl = this._controlView;
    const capacity = RING_BUFFER_SIZE;
    let len = samples.length;

    if (len === 0) return;

    const wp = Atomics.load(ctrl, CTRL_WRITE_POS);
    const rp = Atomics.load(ctrl, CTRL_READ_POS);

    // One slot stays empty so full and empty remain distinguishable.
    const free = capacity - 1 - ((wp - rp + capacity) % capacity);

    if (len > free) {
      // Never run the write cursor past the read cursor: that corrupts the
      // reader's view of how much is buffered. Keep the newest samples that
      // fit — dropping the oldest is what a live monitor wants.
      this._sabOverflowCount += len - free;
      if (free === 0) return;
      samples = samples.subarray(len - free);
      len = free;
    }

    // Write into ring buffer, handling wrap-around
    const spaceToEnd = capacity - wp;

    if (len <= spaceToEnd) {
      buf.set(samples, wp);
    } else {
      buf.set(samples.subarray(0, spaceToEnd), wp);
      buf.set(samples.subarray(spaceToEnd), 0);
    }

    Atomics.store(ctrl, CTRL_WRITE_POS, (wp + len) % capacity);
  }

  /**
   * Tell the worklet how much to buffer, derived from the capture chunk size.
   * Pre-fill covers one burst; the cap allows a little jitter on top; both are
   * bounded by the ring so they can never starve the reader permanently.
   */
  _sendTransportConfig() {
    if (!this._workletNode) return;
    const chunk = this._maxChunkSamples || 512;
    const preFill = Math.min(Math.max(chunk, 512), RING_BUFFER_SIZE >> 2);
    const maxBuffered = Math.min(Math.max(Math.round(chunk * 1.75), 2048), RING_BUFFER_SIZE >> 1);
    this._workletNode.port.postMessage({
      type: 'config',
      inputSampleRate: this._bridgeSampleRate,
      preFill,
      maxBuffered,
      debug: DEBUG,
    });
    if (DEBUG) {
      const ms = (maxBuffered / this._bridgeSampleRate) * 1000;
      console.log(`[AudioEngine] Transport sized for ${chunk}-sample capture chunks — preFill ${preFill}, cap ${maxBuffered} (${ms.toFixed(0)}ms)`);
    }
  }

  /**
   * Handle JSON messages from the bridge.
   */
  _handleBridgeMessage(msg, settleStart) {
    switch (msg.type) {
      case 'status':
        if (msg.status === 'capturing') {
          this._bridgeSampleRate = msg.sampleRate || 48000;
          console.log(`[AudioEngine] Bridge capturing — device ${msg.deviceId}, channel ${msg.channel + 1}, ${this._bridgeSampleRate}Hz`);

          // Create AudioWorklet node and wire it into the graph. The worklet
          // resamples when the interface does not run at the context rate.
          this._setupWorkletNode();
          this.isRunning = true;
          const rateNote = Math.abs(this._bridgeSampleRate - this.context.sampleRate) > 1
            ? ` (resampled from ${this._bridgeSampleRate}Hz)`
            : '';
          this.onBridgeStatus?.(true, `Capturing — Ch ${msg.channel + 1} @ ${this.context.sampleRate}Hz${rateNote}`);
          settleStart?.();
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
        this.onBridgeStatus?.(false, `Error: ${msg.message}`);
        settleStart?.(new Error(msg.message || 'AudioBridge reported an error.'));
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

    // Reset SAB positions for a clean start
    if (this._useSAB && this._controlView) {
      Atomics.store(this._controlView, CTRL_WRITE_POS, 0);
      Atomics.store(this._controlView, CTRL_READ_POS, 0);
    }
    this._sabOverflowCount = 0;

    try {
      // Build processor options — pass SAB references if available
      const processorOptions = {
        debug: DEBUG,
        inputSampleRate: this._bridgeSampleRate,
      };
      if (this._useSAB) {
        processorOptions.ringBufferSAB = this._ringBufferSAB;
        processorOptions.controlSAB = this._controlSAB;
      }

      // Create AudioWorklet node
      this._workletNode = new AudioWorkletNode(this.context, 'audio-stream-processor', {
        numberOfInputs: 0,     // No direct input — we feed data via SAB or postMessage
        numberOfOutputs: 1,
        outputChannelCount: [1], // Mono output
        processorOptions: processorOptions,
      });
    } catch (e) {
      console.error('[AudioEngine] Failed to create AudioWorkletNode. Is the page served over HTTP?', e);
      console.error('[AudioEngine] AudioWorklet requires http:// not file://. Use a local server.');
      return;
    }

    // Listen for buffer health reports
    this._workletNode.port.onmessage = (event) => {
      if (event.data.type === 'health') {
        const h = event.data;
        console.log(`[AudioEngine] Buffer: ${h.fillPercent}% full (${h.buffered}/${h.capacity}), underruns: ${h.underruns}, trims: ${h.trims}, overflows: ${this._sabOverflowCount}, ratio: ${h.ratio.toFixed(4)}, mode: ${h.mode}`);
        this.onBufferHealth?.({ ...h, overflows: this._sabOverflowCount });
      }
    };

    // Connect: workletNode → inputGain → analyserInput → [effects] → masterGain
    this._workletNode.connect(this.inputGainNode);
    this.inputGainNode.connect(this.analyserInput);

    // Chunks may already have arrived before the node existed.
    if (this._maxChunkSamples > 0) this._sendTransportConfig();

    this.rebuildChain();

    console.log(`[AudioEngine] AudioWorklet node connected — signal chain ready (${this._useSAB ? 'SAB' : 'postMessage'} transport)`);
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

  // ─── Local Source Mode (test signal) ──────────────────────────────────

  /**
   * Route a locally produced source into the chain in place of a live input.
   * Used by the test bench — a generated signal or a decoded audio file sits
   * exactly where a pickup would, so everything downstream behaves identically.
   *
   * @param {AudioNode} node - the source's output node
   */
  async startFromLocalSource(node) {
    if (!this.context) await this.init();

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    this.stopInput();

    this._localSourceNode = node;

    // Connect: source → input gain → input analyser → [effects chain] → master gain
    node.connect(this.inputGainNode);
    this.inputGainNode.connect(this.analyserInput);

    this.rebuildChain();
    this.isRunning = true;

    console.log('[AudioEngine] Started local source (test signal)');
  }

  /**
   * Bypass the whole chain — effects and amp — for A/B comparison.
   * @param {boolean} value
   */
  setBypassAll(value) {
    this.bypassAll = value;
    if (this.isRunning) this.rebuildChain();
  }

  // ─── Common Methods ───────────────────────────────────────────────────

  /**
   * Stop all audio input (bridge or browser).
   */
  stopInput() {
    // A start that is still in flight has to be told it lost the race.
    this._pendingStart?.(new Error('Input was stopped before capture started.'));
    this._pendingStart = null;

    // Stop bridge. A socket still in CONNECTING must be closed too — dropping
    // the reference leaves it to open behind our back and keep streaming.
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ command: 'stop' }));
        }
      } catch (e) { /* socket already gone */ }
      try { ws.close(); } catch (e) { /* already closing */ }
    }

    if (this._workletNode) {
      this._workletNode.port.postMessage('reset');
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    // Reset SAB positions
    if (this._useSAB && this._controlView) {
      Atomics.store(this._controlView, CTRL_WRITE_POS, 0);
      Atomics.store(this._controlView, CTRL_READ_POS, 0);
    }

    // Stop local source (test signal). Null it before notifying so a handler
    // that calls back into stopInput() cannot re-enter this branch.
    if (this._localSourceNode) {
      try { this._localSourceNode.disconnect(); } catch (e) { /* ignore */ }
      this._localSourceNode = null;
      this.onLocalSourceStopped?.();
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

    // Get only active (enabled) effects — none at all while globally bypassed
    const activeEffects = this.bypassAll ? [] : this.effectsChain.filter(fx => fx.enabled);

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

    console.log(this.bypassAll
      ? '[AudioEngine] Chain rebuilt — bypassed (dry)'
      : `[AudioEngine] Chain rebuilt — ${activeEffects.length} active effects: ${activeEffects.map(fx => fx.name).join(' → ')}`);
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
      localSource: !!this._localSourceNode,
      bypassAll: this.bypassAll,
      transport: this._useSAB ? 'SharedArrayBuffer' : 'postMessage',
      captureSampleRate: this._bridgeSampleRate,
      overflows: this._sabOverflowCount,
      muted: this.muteNode ? this.muteNode.gain.value < 0.5 : false,
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
