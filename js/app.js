/**
 * App Controller — Wires UI controls to the audio engine, effects, and presets.
 */
import { AudioEngine } from './audio-engine.js';
import { NoiseGate, Compressor, EnvelopeFilter, Boost, Overdrive, Distortion, Phaser, Flanger, Chorus, Delay, Reverb, EQ } from './effects.js';
import { AmpSim } from './amp-sim.js';
import { Visualizer } from './visualizer.js';
import { Tuner } from './tuner.js';
import { PresetManager } from './presets.js';

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.effects = {};
    this.amp = null;
    this.visualizer = null;
    this.tuner = null;
    this.presetManager = new PresetManager();
    this._knobDragState = null;
    this._audioInitialized = false;
    this._useBridge = false;
    this._bridgeDevices = [];

    // Pending state: track bypass/knob states before audio init
    this._pendingBypass = {};
    this._pendingKnobValues = {};
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
    this._setupVisMode();
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

    if (bridgeAvailable) {
      this._useBridge = true;
      if (bridgeLabel) bridgeLabel.textContent = 'Bridge online';
      const dot = document.getElementById('bridge-dot');
      if (dot) dot.classList.add('live');
      await this._populateBridgeDevices();
    } else {
      this._useBridge = false;
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
   */
  async initAudio() {
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

    // Re-populate devices with permission (to get real labels)
    this._populateDevices(true).catch(e => console.warn('[App] Device enumeration failed:', e));

    // Apply the current preset to actual audio nodes
    this._applyCurrentPresetToAudio();

    this._audioInitialized = true;

    // Start signal monitor for debugging
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
      btn.addEventListener('click', () => {
        // Toggle UI state
        const isActive = btn.classList.toggle('active');
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
        this._pendingBypass[name] = isActive;
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
      // Exponential curve: 0 → 0, 0.5 → ~10, 1.0 → 100
      const gain = v * v * 100;
      if (this._audioInitialized) this.engine.setInputGain(gain);
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

  _bindKnob(id, callback) {
    const knob = document.getElementById(id);
    if (!knob) return;
    knob._callback = callback;
    knob._value = parseFloat(knob.dataset.value || 0.5);
    this._updateKnobVisual(knob, knob._value);
  }

  _setupKnobInteractions() {
    document.addEventListener('mousedown', (e) => {
      const knob = e.target.closest('.knob');
      if (!knob) return;
      e.preventDefault();
      this._knobDragState = { knob, startY: e.clientY, startValue: knob._value || 0.5 };
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._knobDragState) return;
      const { knob, startY, startValue } = this._knobDragState;
      const delta = (startY - e.clientY) / 150;
      const newValue = Math.max(0, Math.min(1, startValue + delta));
      knob._value = newValue;
      knob.dataset.value = newValue;
      this._updateKnobVisual(knob, newValue);
      if (knob._callback) knob._callback(newValue);
    });

    document.addEventListener('mouseup', () => {
      this._knobDragState = null;
    });
  }

  _updateKnobVisual(knob, value) {
    const rotation = -135 + value * 270;
    const indicator = knob.querySelector('.knob-indicator');
    if (indicator) {
      indicator.style.transform = `rotate(${rotation}deg)`;
    }
    const wrapper = knob.closest('.knob-wrapper') || knob.closest('.amp-knob-wrapper');
    if (wrapper) {
      const valueDisplay = wrapper.querySelector('.knob-value');
      if (valueDisplay) {
        valueDisplay.textContent = Math.round(value * 10);
      }
    }
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
      const data = this._serializeUIState();
      this.presetManager.saveUserPreset(name, data);
      this._populatePresetList();
      select.value = name;
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
      if (btn) btn.classList.toggle('active', fxData.enabled);
      const led = document.getElementById(`${fxName}-led`);
      if (led) led.classList.toggle('on', fxData.enabled);
      this._pendingBypass[fxName] = fxData.enabled;
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
    return this._currentPreset || {};
  }

  // ─── Tuner ───
  _setupTuner() {
    const btn = document.getElementById('tuner-btn');
    const display = document.getElementById('tuner-display');

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

    btn.addEventListener('click', () => {
      if (!this._audioInitialized) return;
      const active = this.tuner.toggle();
      btn.classList.toggle('active', active);
      display.classList.toggle('visible', active);
    });
  }

  // ─── IR Loading ───
  _setupIRLoadingUI() {
    const reverbIRBtn = document.getElementById('reverb-load-ir');
    if (reverbIRBtn) {
      reverbIRBtn.addEventListener('click', () => {
        if (this._audioInitialized) this._loadIRFile(this.effects.reverb);
      });
    }
    const cabIRBtn = document.getElementById('cab-load-ir');
    if (cabIRBtn) {
      cabIRBtn.addEventListener('click', () => {
        if (this._audioInitialized) this._loadIRFile(this.amp);
      });
    }
  }

  _loadIRFile(target) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wav,.mp3,.ogg';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const arrayBuffer = await file.arrayBuffer();
      if (target.loadIR) await target.loadIR(arrayBuffer);
      else if (target.loadCabIR) await target.loadCabIR(arrayBuffer);
    });
    input.click();
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
      statusText.textContent = state.isRunning
        ? `Live — ${state.sampleRate}Hz — Latency: ${(state.baseLatency * 1000).toFixed(1)}ms`
        : 'Stopped';
    }
  }

  /**
   * Monitor signal levels for debugging — logs every 2 seconds.
   */
  _startSignalMonitor() {
    const inputBuf = new Float32Array(2048);
    const outputBuf = new Float32Array(2048);

    setInterval(() => {
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

  // Setup UI immediately — no audio context needed
  app.setupUI();

  // Tuner button (needs audio, handled separately)
  const tunerBtn = document.getElementById('tuner-btn');
  tunerBtn.addEventListener('click', async () => {
    if (!app._audioInitialized) await app.initAudio();
  });

  // Start/Stop button
  const startBtn = document.getElementById('start-btn');
  startBtn.addEventListener('click', async () => {
    // Ensure audio is initialized
    if (!app._audioInitialized) {
      await app.initAudio();
    }

    if (app.engine.isRunning) {
      app.engine.stopInput();
      if (app.visualizer) app.visualizer.stop();
      startBtn.textContent = '▶ START';
      startBtn.classList.remove('active');
      document.getElementById('status-dot').classList.remove('live');
    } else {
      const deviceSelect = document.getElementById('device-select');
      const channelSelect = document.getElementById('channel-select');
      const deviceId = deviceSelect.value;
      const channel = parseInt(channelSelect?.value || '0', 10);

      try {
        if (app._useBridge) {
          // Use Core Audio bridge (primary)
          await app.engine.startFromBridge(parseInt(deviceId, 10), channel);
        } else {
          // Fallback to browser getUserMedia
          await app.engine.start(deviceId);
        }
        if (app.visualizer) app.visualizer.start();
        startBtn.textContent = '⏹ STOP';
        startBtn.classList.add('active');
        document.getElementById('status-dot').classList.add('live');
      } catch (e) {
        console.error('Failed to start audio:', e);
        alert(app._useBridge
          ? 'Failed to connect to AudioBridge. Make sure it is running (./audio-bridge/start-bridge.sh)'
          : 'Failed to start audio: ' + e.message);
      }
    }
    app._updateStateUI();
  });
});
