/**
 * App Controller — Wires UI controls to the audio engine, effects, and presets.
 */
import { AudioEngine } from './audio-engine.js';
import { NoiseGate, Compressor, EnvelopeFilter, Boost, Overdrive, Distortion, Phaser, Flanger, Chorus, Delay, Reverb, EQ } from './effects.js';
import { AmpSim } from './amp-sim.js';
import { Visualizer } from './visualizer.js';
import { Tuner } from './tuner.js';
import { PresetManager } from './presets.js';
import { TestSignal, TEST_SIGNALS } from './test-signal.js';

// Level logging and buffer-health reports are opt-in: append ?debug to the URL.
const DEBUG = new URLSearchParams(location.search).has('debug');

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.effects = {};
    this.amp = null;
    this.visualizer = null;
    this.tuner = null;
    this.testSignal = null;
    this.presetManager = new PresetManager();
    this._testProgressRAF = null;
    this._knobDragState = null;
    this._audioInitialized = false;
    this._useBridge = false;
    this._bridgeDevices = [];
    this._monitorTimer = null;
  }

  /**
   * Setup UI immediately — presets, knob interactions, bypass buttons.
   * No AudioContext needed for this.
   */
  setupUI() {
    this._setupPresets();
    this._setupPedalPresets();
    this._setupKnobInteractions();
    this._setupBypassButtons();
    this._setupIRLoadingUI();
    this._setupTestBench();
    this._setupVisMode();
    this._setupTunerButton();
    this._bindAllKnobs();

    // Try bridge first, fall back to browser device enumeration
    this._initDeviceEnumeration();

    // Channel selector — switch channel on the bridge
    const channelSelect = document.getElementById('channel-select');
    if (channelSelect) {
      channelSelect.addEventListener('change', (e) => {
        const ch = parseInt(e.target.value, 10);
        if (this._useBridge) {
          this.engine.switchBridgeChannel(ch);
        }
      });
    }

    // Device selector — update channel list when device changes
    const deviceSelect = document.getElementById('device-select');
    if (deviceSelect) {
      deviceSelect.addEventListener('change', () => {
        this._updateChannelSelector();
      });
    }

    // Bridge status callback
    this.engine.onBridgeStatus = (connected, message) => {
      const dot = document.getElementById('bridge-dot');
      const text = document.getElementById('bridge-text');
      if (dot) dot.classList.toggle('live', connected);
      if (text) text.textContent = connected ? message : 'Bridge offline';
    };

    // Load default preset (UI-only, no audio nodes yet)
    this._loadPresetUI('Clean');
  }

  async _initDeviceEnumeration() {
    // Check if bridge is available
    const bridgeAvailable = await this.engine.isBridgeAvailable();
    const bridgeLabel = document.getElementById('bridge-text');

    // Per-channel capture only exists on the bridge; getUserMedia hands back
    // whatever the device's default is, so showing the control in browser mode
    // promises something the app cannot deliver.
    const channelGroup = document.getElementById('channel-group');

    if (bridgeAvailable) {
      this._useBridge = true;
      if (bridgeLabel) bridgeLabel.textContent = 'Bridge online';
      if (channelGroup) channelGroup.hidden = false;
      const dot = document.getElementById('bridge-dot');
      if (dot) dot.classList.add('live');
      await this._populateBridgeDevices();
    } else {
      this._useBridge = false;
      if (channelGroup) channelGroup.hidden = true;
      if (bridgeLabel) bridgeLabel.textContent = 'Bridge offline — using browser audio';
      // Fall back to browser enumeration
      this._populateDevices(false).catch(e => console.warn('[App] Device enumeration failed:', e));
      navigator.mediaDevices?.addEventListener('devicechange', () => {
        this._populateDevices(false).catch(() => {});
      });
    }
  }

  async _populateBridgeDevices() {
    const select = document.getElementById('device-select');
    try {
      this._bridgeDevices = await this.engine.getBridgeDevices();
      select.innerHTML = '';
      if (this._bridgeDevices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— No audio inputs found —';
        select.appendChild(opt);
      } else {
        this._bridgeDevices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = `${d.name} (${d.inputChannels}ch @ ${d.sampleRate}Hz)`;
          select.appendChild(opt);
        });
      }
      this._updateChannelSelector();
    } catch (e) {
      console.warn('[App] Bridge device enumeration failed:', e);
    }
  }

  _updateChannelSelector() {
    const deviceSelect = document.getElementById('device-select');
    const channelSelect = document.getElementById('channel-select');
    if (!channelSelect || !this._useBridge) return;

    const deviceId = parseInt(deviceSelect.value, 10);
    const device = this._bridgeDevices.find(d => d.id === deviceId);
    const channelCount = device?.inputChannels || 2;

    channelSelect.innerHTML = '';
    for (let i = 0; i < channelCount; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Channel ${i + 1}`;
      channelSelect.appendChild(opt);
    }
  }

  /**
   * Initialize audio engine and effects. Must be called from a user gesture.
   *
   * @param {object} [options]
   * @param {boolean} [options.requestMicPermission] - false when the caller has
   *   no use for a live input (the test bench), so no mic prompt is raised.
   */
  async initAudio({ requestMicPermission = true } = {}) {
    if (this._audioInitialized) return;

    try {
      await this.engine.init();
    } catch (e) {
      console.error('[App] AudioContext init failed:', e);
      return;
    }

    const ctx = this.engine.context;

    // Create effects
    this.effects = {
      noisegate: new NoiseGate(ctx),
      compressor: new Compressor(ctx),
      envelopefilter: new EnvelopeFilter(ctx),
      boost: new Boost(ctx),
      overdrive: new Overdrive(ctx),
      distortion: new Distortion(ctx),
      phaser: new Phaser(ctx),
      flanger: new Flanger(ctx),
      chorus: new Chorus(ctx),
      delay: new Delay(ctx),
      reverb: new Reverb(ctx),
      eq: new EQ(ctx),
    };

    // Create amp
    this.amp = new AmpSim(ctx);

    // Create tuner
    this.tuner = new Tuner(ctx);
    this._setupTuner();

    // Create the test signal source and apply the current panel settings
    this.testSignal = new TestSignal(ctx);
    this.testSignal.onEnded = () => this._stopTestSignal();
    this.testSignal.setLevel(this._testLevel());
    this.testSignal.setLoop(document.getElementById('test-loop')?.classList.contains('active') ?? true);

    // Starting a live input calls stopInput(), which tears the local source
    // down and lands here — so the two input paths interlock for free.
    this.engine.onLocalSourceStopped = () => {
      this.testSignal?.stop();
      this._syncTestBenchUI();
    };

    // Set signal chain
    const chain = [
      this.effects.noisegate,
      this.effects.compressor,
      this.effects.envelopefilter,
      this.effects.boost,
      this.effects.overdrive,
      this.effects.distortion,
      this.effects.phaser,
      this.effects.flanger,
      this.effects.chorus,
      this.effects.delay,
      this.effects.reverb,
      this.effects.eq,
      this.amp,
    ];
    this.engine.setEffectsChain(chain);

    // Setup tuner — register as a parallel tap so it survives rebuildChain()
    this.engine.addParallelTap(this.tuner.getAnalyserNode());

    // Visualizer
    this.visualizer = new Visualizer('visualizer-canvas');
    this.visualizer.setAnalysers(this.engine.analyserInput, this.engine.analyserOutput);
    this.visualizer.setMode(document.getElementById('viz-mode')?.value || 'both');

    // Re-populate devices with permission (to get real labels). In bridge mode
    // the list comes from Core Audio, so leave it alone — browser deviceIds
    // would overwrite the numeric bridge device IDs the START button reads.
    if (requestMicPermission && !this._useBridge) {
      this._populateDevices(true).catch(e => console.warn('[App] Device enumeration failed:', e));
    }

    // Mark initialised before applying state: _applyCurrentPresetToAudio and
    // the param setters all bail out when this is false, so setting it
    // afterwards meant the preset on screen was never pushed into the nodes —
    // every pedal showed as lit while the graph had it switched off.
    this._audioInitialized = true;

    // Apply the current preset to actual audio nodes
    this._applyCurrentPresetToAudio();

    // The engine's own gain defaults and the knob positions in the markup are
    // set independently, so push the knobs in — otherwise the Input knob reads
    // one thing and the graph does another until the knob is first touched.
    this._applyMasterKnobsToAudio();

    // Level logging, when asked for
    this._startSignalMonitor();

    console.log(`[App] Audio engine initialized — sampleRate: ${ctx.sampleRate}`);
  }

  async _populateDevices(requestPermission = false) {
    const select = document.getElementById('device-select');
    try {
      const devices = await this.engine.getInputDevices(requestPermission);
      const currentValue = select.value;
      select.innerHTML = '';
      if (devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— No audio inputs found —';
        select.appendChild(opt);
      } else {
        devices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label;
          select.appendChild(opt);
        });
        // Restore previous selection if it still exists
        if (currentValue) {
          const exists = devices.some(d => d.deviceId === currentValue);
          if (exists) select.value = currentValue;
        }
      }
    } catch (e) {
      console.warn('[App] Could not enumerate devices:', e);
    }
  }

  // ─── Bypass Buttons ───
  _setupBypassButtons() {
    const effectNames = ['noisegate', 'compressor', 'envelopefilter', 'boost', 'overdrive', 'distortion', 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'eq'];
    effectNames.forEach(name => {
      const btn = document.getElementById(`${name}-bypass`);
      if (!btn) return;
      btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
      btn.addEventListener('click', () => {
        // Toggle UI state
        const isActive = btn.classList.toggle('active');
        btn.setAttribute('aria-pressed', String(isActive));
        const led = document.getElementById(`${name}-led`);
        if (led) led.classList.toggle('on', isActive);

        // Update preset state
        if (this._currentPreset && this._currentPreset.effects[name]) {
          this._currentPreset.effects[name].enabled = isActive;
        }

        // Update audio if initialized
        if (this._audioInitialized && this.effects[name]) {
          this.effects[name].enabled = isActive;
          this.engine.rebuildChain();
        }
      });
    });
  }

  // ─── Knob Bindings ───
  _setEffectParam(effectName, paramName, value) {
    if (this._currentPreset && this._currentPreset.effects[effectName]) {
      this._currentPreset.effects[effectName].params[paramName] = value;
    }
    if (this._audioInitialized && this.effects[effectName]) {
      this.effects[effectName].setParam(paramName, value);
    }
  }

  _setAmpParam(paramName, value) {
    if (this._currentPreset && this._currentPreset.amp) {
      this._currentPreset.amp.params[paramName] = value;
    }
    if (this._audioInitialized && this.amp) {
      this.amp.setParam(paramName, value);
    }
  }

  _bindAllKnobs() {
    // Master
    this._bindKnob('master-volume', (v) => {
      if (this._audioInitialized) this.engine.setMasterVolume(v);
    });
    this._bindKnob('input-gain', (v) => {
      if (this._audioInitialized) this.engine.setInputGain(this._inputGainFor(v));
    });

    // Noise Gate
    this._bindKnob('noisegate-threshold', (v) => this._setEffectParam('noisegate', 'threshold', -60 + v * 40));
    // Compressor
    this._bindKnob('compressor-threshold', (v) => this._setEffectParam('compressor', 'threshold', -50 + v * 50));
    this._bindKnob('compressor-ratio', (v) => this._setEffectParam('compressor', 'ratio', 1 + v * 19));
    // Envelope Filter
    this._bindKnob('envelopefilter-sensitivity', (v) => this._setEffectParam('envelopefilter', 'sensitivity', v));
    this._bindKnob('envelopefilter-q', (v) => this._setEffectParam('envelopefilter', 'q', v));
    this._bindKnob('envelopefilter-mix', (v) => this._setEffectParam('envelopefilter', 'mix', v));
    // Boost
    this._bindKnob('boost-gain', (v) => this._setEffectParam('boost', 'gain', v));
    this._bindKnob('boost-tone', (v) => this._setEffectParam('boost', 'tone', v));
    // Overdrive
    this._bindKnob('overdrive-drive', (v) => this._setEffectParam('overdrive', 'drive', v));
    this._bindKnob('overdrive-tone', (v) => this._setEffectParam('overdrive', 'tone', v));
    this._bindKnob('overdrive-level', (v) => this._setEffectParam('overdrive', 'level', v));
    // Distortion
    this._bindKnob('distortion-gain', (v) => this._setEffectParam('distortion', 'gain', v));
    this._bindKnob('distortion-tone', (v) => this._setEffectParam('distortion', 'tone', v));
    this._bindKnob('distortion-level', (v) => this._setEffectParam('distortion', 'level', v));
    // Phaser
    this._bindKnob('phaser-rate', (v) => this._setEffectParam('phaser', 'rate', v));
    this._bindKnob('phaser-depth', (v) => this._setEffectParam('phaser', 'depth', v));
    this._bindKnob('phaser-feedback', (v) => this._setEffectParam('phaser', 'feedback', v));
    this._bindKnob('phaser-mix', (v) => this._setEffectParam('phaser', 'mix', v));
    // Flanger
    this._bindKnob('flanger-rate', (v) => this._setEffectParam('flanger', 'rate', v));
    this._bindKnob('flanger-depth', (v) => this._setEffectParam('flanger', 'depth', v));
    this._bindKnob('flanger-feedback', (v) => this._setEffectParam('flanger', 'feedback', v));
    this._bindKnob('flanger-mix', (v) => this._setEffectParam('flanger', 'mix', v));
    // Chorus
    this._bindKnob('chorus-rate', (v) => this._setEffectParam('chorus', 'rate', v * 10));
    this._bindKnob('chorus-depth', (v) => this._setEffectParam('chorus', 'depth', v));
    this._bindKnob('chorus-mix', (v) => this._setEffectParam('chorus', 'mix', v));
    // Delay
    this._bindKnob('delay-time', (v) => this._setEffectParam('delay', 'time', v * 2));
    this._bindKnob('delay-feedback', (v) => this._setEffectParam('delay', 'feedback', v));
    this._bindKnob('delay-mix', (v) => this._setEffectParam('delay', 'mix', v));
    // Reverb
    this._bindKnob('reverb-decay', (v) => this._setEffectParam('reverb', 'decay', 0.5 + v * 5));
    this._bindKnob('reverb-mix', (v) => this._setEffectParam('reverb', 'mix', v));
    // EQ
    this._bindKnob('eq-bass', (v) => this._setEffectParam('eq', 'bass', (v - 0.5) * 24));
    this._bindKnob('eq-mid', (v) => this._setEffectParam('eq', 'mid', (v - 0.5) * 24));
    this._bindKnob('eq-treble', (v) => this._setEffectParam('eq', 'treble', (v - 0.5) * 24));
    // Amp
    this._bindKnob('amp-gain', (v) => this._setAmpParam('gain', v));
    this._bindKnob('amp-bass', (v) => this._setAmpParam('bass', v));
    this._bindKnob('amp-mid', (v) => this._setAmpParam('mid', v));
    this._bindKnob('amp-treble', (v) => this._setAmpParam('treble', v));
    this._bindKnob('amp-presence', (v) => this._setAmpParam('presence', v));
    this._bindKnob('amp-master', (v) => this._setAmpParam('master', v));

    // Amp model selector
    const modelSelect = document.getElementById('amp-model');
    if (modelSelect) {
      modelSelect.addEventListener('change', (e) => {
        if (this._currentPreset && this._currentPreset.amp) {
          this._currentPreset.amp.params.model = e.target.value;
        }
        if (this._audioInitialized && this.amp) this.amp.setModel(e.target.value);
      });
    }
  }

  /**
   * Input trim, 0–1 knob to a linear gain. Squared for fine control down low,
   * and scaled so the knob's default position lands on the engine's own default
   * gain of 2x. The old curve topped out at 100x, which turned the first pixel
   * of knob movement into a 20dB jump through a distortion chain.
   */
  _inputGainFor(v) {
    return v * v * 8;
  }

  /** Push the master section's knob positions into the engine. */
  _applyMasterKnobsToAudio() {
    const volume = document.getElementById('master-volume')?._value;
    const input = document.getElementById('input-gain')?._value;
    if (typeof volume === 'number') this.engine.setMasterVolume(volume);
    if (typeof input === 'number') this.engine.setInputGain(this._inputGainFor(input));
  }

  _bindKnob(id, callback) {
    const knob = document.getElementById(id);
    if (!knob) return;
    knob._callback = callback;
    knob._value = parseFloat(knob.dataset.value || 0.5);
    // Remembered so a double-click can put the knob back where it started.
    knob._default = knob._value;

    // These are divs, so the slider semantics are added here rather than
    // repeated across forty elements of markup.
    const wrapper = knob.closest('.knob-wrapper') || knob.closest('.amp-knob-wrapper');
    const label = wrapper?.querySelector('.knob-label');
    knob.setAttribute('role', 'slider');
    knob.setAttribute('tabindex', '0');
    knob.setAttribute('aria-valuemin', '0');
    knob.setAttribute('aria-valuemax', '10');
    if (label) knob.setAttribute('aria-label', label.textContent.trim());

    this._updateKnobVisual(knob, knob._value);
  }

  _setupKnobInteractions() {
    // Pointer events rather than mouse events, so touch and pen work too — the
    // layout has a phone breakpoint, but these knobs could not be turned there.
    // Pointer capture keeps a drag alive when the cursor leaves the knob.
    document.addEventListener('pointerdown', (e) => {
      const knob = e.target.closest?.('.knob');
      if (!knob) return;
      e.preventDefault();
      knob.focus({ preventScroll: true });
      this._knobDragState = {
        knob,
        pointerId: e.pointerId,
        startY: e.clientY,
        startValue: knob._value ?? 0.5,
      };
      try { knob.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
    });

    document.addEventListener('pointermove', (e) => {
      const drag = this._knobDragState;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const delta = (drag.startY - e.clientY) / 150;
      this._setKnobValue(drag.knob, drag.startValue + delta);
    });

    const endDrag = (e) => {
      const drag = this._knobDragState;
      if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
      try { drag.knob.releasePointerCapture(drag.pointerId); } catch (err) { /* already gone */ }
      this._knobDragState = null;
    };
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    // A slider answers to arrow keys.
    document.addEventListener('keydown', (e) => {
      const knob = e.target.closest?.('.knob');
      if (!knob || !knob._callback) return;
      const fine = 0.02, coarse = 0.1;
      let next;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': next = knob._value + fine; break;
        case 'ArrowDown': case 'ArrowLeft': next = knob._value - fine; break;
        case 'PageUp': next = knob._value + coarse; break;
        case 'PageDown': next = knob._value - coarse; break;
        case 'Home': next = 0; break;
        case 'End': next = 1; break;
        default: return;
      }
      e.preventDefault();
      this._setKnobValue(knob, next);
    });

    // Double-click puts a knob back where it started.
    document.addEventListener('dblclick', (e) => {
      const knob = e.target.closest?.('.knob');
      if (!knob || typeof knob._default !== 'number') return;
      this._setKnobValue(knob, knob._default);
    });
  }

  /** Clamp, store, redraw and report a new knob position. */
  _setKnobValue(knob, value) {
    const v = Math.max(0, Math.min(1, value));
    knob._value = v;
    knob.dataset.value = v;
    this._updateKnobVisual(knob, v);
    if (knob._callback) knob._callback(v);
  }

  _updateKnobVisual(knob, value) {
    const rotation = -135 + value * 270;
    const indicator = knob.querySelector('.knob-indicator');
    if (indicator) {
      indicator.style.transform = `rotate(${rotation}deg)`;
    }
    const wrapper = knob.closest('.knob-wrapper') || knob.closest('.amp-knob-wrapper');
    const shown = Math.round(value * 10);
    if (wrapper) {
      const valueDisplay = wrapper.querySelector('.knob-value');
      if (valueDisplay) {
        valueDisplay.textContent = shown;
      }
    }
    knob.setAttribute('aria-valuenow', String(shown));
  }

  // ─── Presets ───

  _setupPedalPresets() {
    const effectNames = ['noisegate', 'compressor', 'envelopefilter', 'boost', 'overdrive', 'distortion', 'phaser', 'flanger', 'chorus', 'delay', 'reverb', 'eq'];
    effectNames.forEach(name => {
      const select = document.getElementById(`${name}-preset`);
      const saveBtn = document.getElementById(`${name}-preset-save`);
      if (!select || !saveBtn) return;

      const populate = () => {
        const current = select.value;
        select.innerHTML = '<option value="">Preset</option>';
        
        const factory = this.presetManager.getPedalFactoryPresets(name);
        if (factory.length > 0) {
          const group = document.createElement('optgroup');
          group.label = 'Factory';
          factory.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            group.appendChild(opt);
          });
          select.appendChild(group);
        }
        
        const user = Object.keys(this.presetManager.getPedalUserPresets(name));
        if (user.length > 0) {
          const group = document.createElement('optgroup');
          group.label = 'User';
          user.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            group.appendChild(opt);
          });
          select.appendChild(group);
        }
        if (current) select.value = current;
      };

      populate();

      select.addEventListener('change', () => {
        const presetName = select.value;
        if (!presetName) return;
        const presetData = this.presetManager.getPedalPreset(name, presetName);
        if (presetData) {
          if (this._currentPreset && this._currentPreset.effects[name]) {
            this._currentPreset.effects[name].params = { ...presetData };
            this._syncKnobsFromPreset(this._currentPreset);
          }
          if (this._audioInitialized && this.effects[name]) {
            for (const [k, v] of Object.entries(presetData)) {
              this.effects[name].setParam(k, v);
            }
          }
        }
      });

      saveBtn.addEventListener('click', () => {
        const presetName = prompt(`Save ${name} preset as:`);
        if (!presetName) return;
        const data = this._currentPreset && this._currentPreset.effects[name] 
          ? this._currentPreset.effects[name].params 
          : (this.effects[name] ? this.effects[name].getParams() : {});
        this.presetManager.savePedalPreset(name, presetName, data);
        populate();
        select.value = presetName;
      });
    });
  }

  _setupPresets() {
    const select = document.getElementById('preset-select');
    const saveBtn = document.getElementById('preset-save');
    const deleteBtn = document.getElementById('preset-delete');

    this._populatePresetList();

    select.addEventListener('change', () => {
      this._loadPresetUI(select.value);
    });

    saveBtn.addEventListener('click', () => {
      const name = prompt('Preset name:');
      if (!name) return;
      try {
        this.presetManager.saveUserPreset(name.trim(), this._serializeUIState());
      } catch (e) {
        alert(e.message);
        return;
      }
      this._populatePresetList();
      select.value = name.trim();
    });

    deleteBtn.addEventListener('click', () => {
      const name = select.value;
      if (this.presetManager.getFactoryPresets().includes(name)) {
        alert('Cannot delete factory presets.');
        return;
      }
      this.presetManager.deleteUserPreset(name);
      this._populatePresetList();
    });
  }

  _populatePresetList() {
    const select = document.getElementById('preset-select');
    const current = select.value;
    select.innerHTML = '';

    const factoryGroup = document.createElement('optgroup');
    factoryGroup.label = 'Factory';
    this.presetManager.getFactoryPresets().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      factoryGroup.appendChild(opt);
    });
    select.appendChild(factoryGroup);

    const userPresets = Object.keys(this.presetManager.getUserPresets());
    if (userPresets.length > 0) {
      const userGroup = document.createElement('optgroup');
      userGroup.label = 'My Presets';
      userPresets.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        userGroup.appendChild(opt);
      });
      select.appendChild(userGroup);
    }

    if (current) select.value = current;
  }

  /**
   * Load a preset to UI controls. If audio is initialized, also apply to audio nodes.
   */
  _loadPresetUI(name) {
    const preset = this.presetManager.getPreset(name);
    if (!preset) return;

    this._currentPreset = preset;
    this._currentPresetName = name;

    // Apply bypass states to UI
    for (const [fxName, fxData] of Object.entries(preset.effects)) {
      const btn = document.getElementById(`${fxName}-bypass`);
      if (btn) {
        btn.classList.toggle('active', fxData.enabled);
        btn.setAttribute('aria-pressed', String(!!fxData.enabled));
      }
      const led = document.getElementById(`${fxName}-led`);
      if (led) led.classList.toggle('on', fxData.enabled);
    }

    // Apply amp model
    if (preset.amp) {
      const modelSelect = document.getElementById('amp-model');
      if (modelSelect) modelSelect.value = preset.amp.params.model;
    }

    // Sync knob visuals
    this._syncKnobsFromPreset(preset);

    // Apply to audio nodes if initialized
    if (this._audioInitialized) {
      this._applyCurrentPresetToAudio();
    }

    // Update preset selector
    const select = document.getElementById('preset-select');
    if (select) select.value = name;
  }

  /**
   * Apply current preset state to audio nodes.
   */
  _applyCurrentPresetToAudio() {
    if (!this._currentPreset || !this._audioInitialized) return;
    const preset = this._currentPreset;

    for (const [fxName, fxData] of Object.entries(preset.effects)) {
      const fx = this.effects[fxName];
      if (!fx) continue;
      fx.enabled = fxData.enabled;
      for (const [param, val] of Object.entries(fxData.params)) {
        fx.setParam(param, val);
      }
    }

    if (preset.amp && this.amp) {
      this.amp.enabled = preset.amp.enabled;
      for (const [param, val] of Object.entries(preset.amp.params)) {
        this.amp.setParam(param, val);
      }
    }

    // The master knobs were just synced from this preset; read them back rather
    // than duplicating the value mapping.
    this._applyMasterKnobsToAudio();

    this.engine.rebuildChain();
  }

  _syncKnobsFromPreset(preset) {
    const knobMap = {};

    // Effects
    if (preset.effects.noisegate) knobMap['noisegate-threshold'] = (preset.effects.noisegate.params.threshold + 60) / 40;
    if (preset.effects.compressor) {
      knobMap['compressor-threshold'] = (preset.effects.compressor.params.threshold + 50) / 50;
      knobMap['compressor-ratio'] = (preset.effects.compressor.params.ratio - 1) / 19;
    }
    if (preset.effects.envelopefilter) {
      knobMap['envelopefilter-sensitivity'] = preset.effects.envelopefilter.params.sensitivity;
      knobMap['envelopefilter-q'] = preset.effects.envelopefilter.params.q;
      knobMap['envelopefilter-mix'] = preset.effects.envelopefilter.params.mix;
    }
    if (preset.effects.boost) {
      knobMap['boost-gain'] = preset.effects.boost.params.gain;
      knobMap['boost-tone'] = preset.effects.boost.params.tone;
    }
    if (preset.effects.overdrive) {
      knobMap['overdrive-drive'] = preset.effects.overdrive.params.drive;
      knobMap['overdrive-tone'] = preset.effects.overdrive.params.tone;
      knobMap['overdrive-level'] = preset.effects.overdrive.params.level;
    }
    if (preset.effects.distortion) {
      knobMap['distortion-gain'] = preset.effects.distortion.params.gain;
      knobMap['distortion-tone'] = preset.effects.distortion.params.tone;
      knobMap['distortion-level'] = preset.effects.distortion.params.level;
    }
    if (preset.effects.phaser) {
      knobMap['phaser-rate'] = preset.effects.phaser.params.rate;
      knobMap['phaser-depth'] = preset.effects.phaser.params.depth;
      knobMap['phaser-feedback'] = preset.effects.phaser.params.feedback;
      knobMap['phaser-mix'] = preset.effects.phaser.params.mix;
    }
    if (preset.effects.flanger) {
      knobMap['flanger-rate'] = preset.effects.flanger.params.rate;
      knobMap['flanger-depth'] = preset.effects.flanger.params.depth;
      knobMap['flanger-feedback'] = preset.effects.flanger.params.feedback;
      knobMap['flanger-mix'] = preset.effects.flanger.params.mix;
    }
    if (preset.effects.chorus) {
      knobMap['chorus-rate'] = preset.effects.chorus.params.rate / 10;
      knobMap['chorus-depth'] = preset.effects.chorus.params.depth;
      knobMap['chorus-mix'] = preset.effects.chorus.params.mix;
    }
    if (preset.effects.delay) {
      knobMap['delay-time'] = preset.effects.delay.params.time / 2;
      knobMap['delay-feedback'] = preset.effects.delay.params.feedback;
      knobMap['delay-mix'] = preset.effects.delay.params.mix;
    }
    if (preset.effects.reverb) {
      knobMap['reverb-decay'] = (preset.effects.reverb.params.decay - 0.5) / 5;
      knobMap['reverb-mix'] = preset.effects.reverb.params.mix;
    }
    if (preset.effects.eq) {
      knobMap['eq-bass'] = preset.effects.eq.params.bass / 24 + 0.5;
      knobMap['eq-mid'] = preset.effects.eq.params.mid / 24 + 0.5;
      knobMap['eq-treble'] = preset.effects.eq.params.treble / 24 + 0.5;
    }
    // Master — absent from user presets saved before this section existed.
    if (preset.master) {
      if (typeof preset.master.volume === 'number') knobMap['master-volume'] = preset.master.volume;
      if (typeof preset.master.input === 'number') knobMap['input-gain'] = preset.master.input;
    }
    // Amp
    if (preset.amp) {
      knobMap['amp-gain'] = preset.amp.params.gain;
      knobMap['amp-bass'] = preset.amp.params.bass;
      knobMap['amp-mid'] = preset.amp.params.mid;
      knobMap['amp-treble'] = preset.amp.params.treble;
      knobMap['amp-presence'] = preset.amp.params.presence;
      knobMap['amp-master'] = preset.amp.params.master;
    }

    for (const [id, value] of Object.entries(knobMap)) {
      const knob = document.getElementById(id);
      if (knob) {
        const v = Math.max(0, Math.min(1, value));
        knob._value = v;
        knob.dataset.value = v;
        this._updateKnobVisual(knob, v);
      }
    }
  }

  _serializeUIState() {
    // Copy, so later knob moves cannot reach into what was just saved.
    const preset = this._currentPreset
      ? JSON.parse(JSON.stringify(this._currentPreset))
      : { effects: {} };
    preset.master = {
      volume: document.getElementById('master-volume')?._value ?? 0.8,
      input: document.getElementById('input-gain')?._value ?? 0.5,
    };
    return preset;
  }

  // ─── Tuner ───

  /**
   * The button is wired during UI setup, before any AudioContext exists.
   * Attaching it from initAudio() instead meant the listener was added while
   * the very first click was still being dispatched — so that click only
   * started the audio and the user had to press Tuner twice.
   */
  _setupTunerButton() {
    const btn = document.getElementById('tuner-btn');
    const display = document.getElementById('tuner-display');
    if (!btn) return;

    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', async () => {
      if (!this._audioInitialized) await this.initAudio();
      if (!this.tuner) return;

      const active = this.tuner.toggle();
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      display?.classList.toggle('visible', active);

      // Mute while tuning so the amp cannot feed back into the pickup. The
      // engine owns this, so the master volume setting is left alone.
      this.engine.setMuted(active);
    });
  }

  _setupTuner() {
    if (!this.tuner) return;

    this.tuner.onUpdate = (note, octave, cents, freq) => {
      const noteEl = document.getElementById('tuner-note');
      const centsEl = document.getElementById('tuner-cents');
      const freqEl = document.getElementById('tuner-freq');
      const needle = document.getElementById('tuner-needle');

      if (noteEl) noteEl.textContent = `${note}${octave}`;
      if (centsEl) centsEl.textContent = `${cents > 0 ? '+' : ''}${cents}¢`;
      if (freqEl) freqEl.textContent = `${freq.toFixed(1)} Hz`;
      if (needle) {
        const rotation = (cents / 50) * 45;
        needle.style.transform = `rotate(${rotation}deg)`;
        needle.classList.toggle('in-tune', Math.abs(cents) < 5);
      }
    };
  }

  // ─── IR Loading ───
  _setupIRLoadingUI() {
    const reverbIRBtn = document.getElementById('reverb-load-ir');
    if (reverbIRBtn) {
      reverbIRBtn.addEventListener('click', async () => {
        if (!this._audioInitialized) await this.initAudio({ requestMicPermission: false });
        this._loadIRFile(this.effects.reverb, 'reverb impulse response');
      });
    }
    const cabIRBtn = document.getElementById('cab-load-ir');
    if (cabIRBtn) {
      cabIRBtn.addEventListener('click', async () => {
        if (!this._audioInitialized) await this.initAudio({ requestMicPermission: false });
        this._loadIRFile(this.amp, 'cabinet impulse response');
      });
    }
  }

  _loadIRFile(target, label = 'impulse response') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.ogg,.aiff,.aif,.flac';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const arrayBuffer = await file.arrayBuffer();
        if (target.loadIR) await target.loadIR(arrayBuffer);
        else if (target.loadCabIR) await target.loadCabIR(arrayBuffer);
        console.log(`[App] Loaded ${label} — ${file.name}`);
      } catch (err) {
        // Without this the rejection was swallowed and the IR silently stayed
        // on the previous buffer.
        console.error(`[App] Could not load ${label}:`, err);
        alert(`Could not load "${file.name}" as an ${label}. Try an uncompressed WAV.`);
      }
    });
    input.click();
  }

  // ─── Test Bench ───

  /**
   * Wire the test-signal panel. Runs before any AudioContext exists, so it only
   * touches the DOM here — the TestSignal itself is built in initAudio().
   */
  _setupTestBench() {
    const sourceSelect = document.getElementById('test-source');
    const playBtn = document.getElementById('test-play');
    const loopBtn = document.getElementById('test-loop');
    const levelInput = document.getElementById('test-level');
    const fileBtn = document.getElementById('test-load-file');
    const bypassBtn = document.getElementById('bypass-all');
    const panel = document.getElementById('test-bench');
    if (!sourceSelect || !playBtn) return;

    // Build the picker from the signal catalogue
    const generated = document.createElement('optgroup');
    generated.label = 'Generated';
    Object.entries(TEST_SIGNALS).forEach(([kind, spec]) => {
      const opt = document.createElement('option');
      opt.value = kind;
      opt.textContent = spec.label;
      generated.appendChild(opt);
    });
    sourceSelect.appendChild(generated);

    const fileGroup = document.createElement('optgroup');
    fileGroup.label = 'Your audio';
    this._fileOption = document.createElement('option');
    this._fileOption.value = 'file';
    this._fileOption.textContent = 'Audio file — none loaded';
    this._fileOption.disabled = true;
    fileGroup.appendChild(this._fileOption);
    sourceSelect.appendChild(fileGroup);

    this._updateTestHint();

    sourceSelect.addEventListener('change', () => {
      this._updateTestHint();
      // Changing source mid-playback swaps straight to the new material
      if (this.testSignal?.isPlaying) this._playTestSignal();
    });

    playBtn.addEventListener('click', () => {
      if (this.testSignal?.isPlaying) this._stopTestSignal();
      else this._playTestSignal();
    });

    loopBtn?.addEventListener('click', () => {
      const active = loopBtn.classList.toggle('active');
      loopBtn.setAttribute('aria-pressed', String(active));
      this.testSignal?.setLoop(active);
    });

    levelInput?.addEventListener('input', () => {
      const readout = document.getElementById('test-level-value');
      if (readout) readout.textContent = levelInput.value;
      this.testSignal?.setLevel(this._testLevel());
    });

    fileBtn?.addEventListener('click', () => this._pickTestFile());

    // Drop an audio file anywhere on the panel
    if (panel) {
      ['dragenter', 'dragover'].forEach(ev => panel.addEventListener(ev, (e) => {
        e.preventDefault();
        panel.classList.add('dragging');
      }));
      ['dragleave', 'dragend'].forEach(ev => panel.addEventListener(ev, () => {
        panel.classList.remove('dragging');
      }));
      panel.addEventListener('drop', (e) => {
        e.preventDefault();
        panel.classList.remove('dragging');
        const file = e.dataTransfer?.files?.[0];
        if (file) this._loadTestFile(file);
      });
    }

    // A/B: bypass every pedal and the amp without disturbing their own state
    bypassBtn?.addEventListener('click', () => {
      const active = bypassBtn.classList.toggle('active');
      bypassBtn.setAttribute('aria-pressed', String(active));
      this.engine.setBypassAll(active);
      document.querySelector('.pedalboard')?.classList.toggle('bypassed', active);
      document.querySelector('.amp-section')?.classList.toggle('bypassed', active);
    });
  }

  /** Level slider position as a 0–1 gain. */
  _testLevel() {
    const el = document.getElementById('test-level');
    return el ? parseInt(el.value, 10) / 100 : 0.35;
  }

  _updateTestHint() {
    const hintEl = document.getElementById('test-hint');
    if (!hintEl) return;
    const kind = document.getElementById('test-source')?.value;
    if (kind === 'file') {
      hintEl.textContent = this.testSignal?.fileName
        ? `Your file: ${this.testSignal.fileName}`
        : 'Load an audio file to use this source.';
    } else {
      hintEl.textContent = TEST_SIGNALS[kind]?.hint || '';
    }
  }

  _pickTestFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.mp3,.ogg,.aiff,.aif,.m4a,.flac';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._loadTestFile(file);
    });
    input.click();
  }

  /**
   * Decode a user-supplied audio file and select it as the test source.
   * @param {File} file
   */
  async _loadTestFile(file) {
    if (!this._audioInitialized) await this.initAudio({ requestMicPermission: false });
    if (!this.testSignal) return;

    const label = document.getElementById('test-file-label');
    const previous = label?.textContent;
    if (label) label.textContent = 'Decoding…';

    try {
      const info = await this.testSignal.loadFile(file);
      if (label) label.textContent = info.name.length > 26 ? `${info.name.slice(0, 25)}…` : info.name;
      if (this._fileOption) {
        this._fileOption.disabled = false;
        this._fileOption.textContent = `${info.name} (${info.duration.toFixed(1)}s)`;
      }
      const sourceSelect = document.getElementById('test-source');
      if (sourceSelect) sourceSelect.value = 'file';
      this._updateTestHint();
      console.log(`[App] Test file loaded — ${info.name}, ${info.duration.toFixed(2)}s`);

      // Already playing? Swap straight over to the new file.
      if (this.testSignal.isPlaying) this._playTestSignal();
    } catch (e) {
      console.error('[App] Could not decode audio file:', e);
      if (label) label.textContent = previous || 'Load audio file…';
      alert(`Could not decode "${file.name}". Try a WAV, MP3, M4A or FLAC file.`);
    }
  }

  /**
   * Patch the test signal into the chain in place of a live input and play it.
   */
  async _playTestSignal() {
    if (!this._audioInitialized) await this.initAudio({ requestMicPermission: false });
    if (!this.testSignal) return;

    const kind = document.getElementById('test-source')?.value;
    if (kind === 'file' && !this.testSignal.hasFile) {
      this._pickTestFile();
      return;
    }

    try {
      // Also stops any live input — the two paths are mutually exclusive
      await this.engine.startFromLocalSource(this.testSignal.getOutputNode());
    } catch (e) {
      console.error('[App] Could not start test signal:', e);
      return;
    }

    this.testSignal.setLevel(this._testLevel());
    if (!this.testSignal.play(kind)) {
      this.engine.stopInput();
      return;
    }

    if (this.visualizer) this.visualizer.start();
    document.getElementById('status-dot')?.classList.add('live');

    // The live input is no longer running, so its button goes back to START
    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
      startBtn.textContent = '▶ START';
      startBtn.classList.remove('active');
    }

    this._syncTestBenchUI();
    this._startTestProgress();
    this._updateStateUI();
  }

  _stopTestSignal() {
    this.testSignal?.stop();
    // Only tear the route down if the test signal is what is running
    if (this.engine.getState().localSource) this.engine.stopInput();
    if (this.visualizer) this.visualizer.stop();
    document.getElementById('status-dot')?.classList.remove('live');
    this._stopTestProgress();
    this._syncTestBenchUI();
    this._updateStateUI();
  }

  _syncTestBenchUI() {
    const playing = !!this.testSignal?.isPlaying;
    const btn = document.getElementById('test-play');
    if (btn) {
      btn.textContent = playing ? '⏹ STOP' : '▶ PLAY';
      btn.classList.toggle('active', playing);
    }
    if (!playing) {
      const fill = document.getElementById('test-progress-fill');
      if (fill) fill.style.width = '0%';
      const time = document.getElementById('test-time');
      if (time) time.textContent = '0:00 / 0:00';
    }
  }

  _startTestProgress() {
    this._stopTestProgress();
    const fill = document.getElementById('test-progress-fill');
    const timeEl = document.getElementById('test-time');

    const tick = () => {
      if (!this.testSignal?.isPlaying) {
        this._testProgressRAF = null;
        return;
      }
      const dur = this.testSignal.duration;
      const pos = this.testSignal.getProgress() * dur;
      if (fill) fill.style.width = `${(dur ? (pos / dur) * 100 : 0).toFixed(1)}%`;
      if (timeEl) timeEl.textContent = `${this._formatTime(pos)} / ${this._formatTime(dur)}`;
      this._testProgressRAF = requestAnimationFrame(tick);
    };
    this._testProgressRAF = requestAnimationFrame(tick);
  }

  _stopTestProgress() {
    if (this._testProgressRAF) cancelAnimationFrame(this._testProgressRAF);
    this._testProgressRAF = null;
  }

  _formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ─── Visualizer Mode ───
  _setupVisMode() {
    const vizMode = document.getElementById('viz-mode');
    if (vizMode) {
      vizMode.addEventListener('change', (e) => {
        if (this.visualizer) this.visualizer.setMode(e.target.value);
      });
    }
  }

  _updateStateUI() {
    const state = this.engine.getState();
    const statusText = document.getElementById('status-text');
    if (statusText) {
      if (!state.isRunning) {
        statusText.textContent = 'Stopped';
      } else if (state.localSource) {
        statusText.textContent = `Test signal — ${state.sampleRate}Hz`;
      } else {
        const resampled = state.bridgeConnected && Math.abs(state.captureSampleRate - state.sampleRate) > 1
          ? ` ← ${state.captureSampleRate}Hz capture`
          : '';
        statusText.textContent = `Live — ${state.sampleRate}Hz${resampled} — Latency: ${(state.baseLatency * 1000).toFixed(1)}ms — ${state.transport}`;
      }
    }
  }

  /**
   * Monitor signal levels — logs every 2 seconds, only with ?debug in the URL.
   * It used to run unconditionally and could never be stopped, which filled the
   * console during normal use.
   */
  _startSignalMonitor() {
    if (!DEBUG || this._monitorTimer) return;

    // Reuse buffers across intervals to avoid repeated allocation.
    // Sized to match analyser fftSize (1024).
    this._monitorInputBuf = this._monitorInputBuf || new Float32Array(1024);
    this._monitorOutputBuf = this._monitorOutputBuf || new Float32Array(1024);
    const inputBuf = this._monitorInputBuf;
    const outputBuf = this._monitorOutputBuf;

    this._monitorTimer = setInterval(() => {
      if (!this.engine.isRunning) return;

      // Input level
      this.engine.analyserInput.getFloatTimeDomainData(inputBuf);
      let inSum = 0;
      for (let i = 0; i < inputBuf.length; i++) inSum += inputBuf[i] ** 2;
      const inRMS = Math.sqrt(inSum / inputBuf.length);
      const inDB = 20 * Math.log10(inRMS + 1e-10);

      // Output level
      this.engine.analyserOutput.getFloatTimeDomainData(outputBuf);
      let outSum = 0;
      for (let i = 0; i < outputBuf.length; i++) outSum += outputBuf[i] ** 2;
      const outRMS = Math.sqrt(outSum / outputBuf.length);
      const outDB = 20 * Math.log10(outRMS + 1e-10);

      console.log(`[Signal] IN: ${inDB.toFixed(1)} dB (${inRMS.toFixed(5)}) | OUT: ${outDB.toFixed(1)} dB (${outRMS.toFixed(5)})`);
    }, 2000);
  }
}

// ─── Boot ───
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();

  // Setup UI immediately — no audio context needed. The Tuner button is wired
  // in there too, so it works on its first click.
  app.setupUI();

  // With ?debug, hang the controller off the window so the chain can be poked
  // at from the console.
  if (DEBUG) window.app = app;

  // Start/Stop button
  const startBtn = document.getElementById('start-btn');
  const statusDot = document.getElementById('status-dot');
  let busy = false;

  startBtn.addEventListener('click', async () => {
    // Starting takes a round trip to the bridge; a second click meanwhile would
    // tear down the capture the first one is still setting up.
    if (busy) return;
    busy = true;
    startBtn.disabled = true;

    try {
      // Ensure audio is initialized
      if (!app._audioInitialized) {
        await app.initAudio();
      }

      // Only act as STOP for a live input — if the test bench is what is playing,
      // START takes over from it (startFromBridge/start stop it on the way in).
      const state = app.engine.getState();
      if (state.isRunning && !state.localSource) {
        app.engine.stopInput();
        if (app.visualizer) app.visualizer.stop();
        startBtn.textContent = '▶ START';
        startBtn.classList.remove('active');
        statusDot?.classList.remove('live');
      } else {
        const deviceSelect = document.getElementById('device-select');
        const channelSelect = document.getElementById('channel-select');
        const deviceId = deviceSelect.value;
        const channel = parseInt(channelSelect?.value || '0', 10);

        try {
          if (app._useBridge) {
            // Use Core Audio bridge (primary)
            const numericId = parseInt(deviceId, 10);
            if (!Number.isFinite(numericId)) {
              throw new Error('Choose an audio input device first.');
            }
            await app.engine.startFromBridge(numericId, channel);
          } else {
            // Fallback to browser getUserMedia
            await app.engine.start(deviceId);
            // Permission is granted now, so the device list can show real labels
            app._populateDevices(true).catch(() => {});
          }
          if (app.visualizer) app.visualizer.start();
          startBtn.textContent = '⏹ STOP';
          startBtn.classList.add('active');
          statusDot?.classList.add('live');
        } catch (e) {
          console.error('Failed to start audio:', e);
          // Leave nothing half-started behind.
          app.engine.stopInput();
          startBtn.textContent = '▶ START';
          startBtn.classList.remove('active');
          statusDot?.classList.remove('live');
          // Report what actually went wrong — the bridge now says when a device
          // is busy or missing, and that is more useful than a generic hint.
          const detail = e?.message ? ` (${e.message})` : '';
          alert(app._useBridge
            ? `Could not start capture via the AudioBridge${detail}.\n\nMake sure it is running: ./audio-bridge/start-bridge.sh`
            : `Failed to start audio${detail}.`);
        }
      }
    } finally {
      busy = false;
      startBtn.disabled = false;
      app._updateStateUI();
    }
  });
});
