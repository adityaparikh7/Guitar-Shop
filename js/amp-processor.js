/**
 * Tube Stage Processor — the nonlinear part of the built-in amp.
 *
 * Not an ES module: it lives in the AudioWorkletGlobalScope and only calls
 * registerProcessor(). AmpSim runs two instances, one configured as the
 * preamp (one to three triode stages) and one as the power amp (a push-pull
 * stage with supply sag); the tone stack sits between them as native biquads.
 *
 * Why a worklet rather than WaveShaperNodes: every distorting stage needs
 * oversampling, and a WaveShaperNode set to '4x' adds several milliseconds of
 * linear-phase filter latency per instance. Here a whole chain of stages shares
 * one 4x region, and the polyphase IIR halfband filters used to get there and
 * back cost a few samples of delay rather than a few hundred.
 *
 * Each stage's gain is mapped from the normalized `drive` parameter (the amp's
 * Gain knob, 0–1) through a log taper, so the knob behaves like an audio-taper
 * pot. Stage state carries an envelope of the grid-current excursions, which
 * shifts the operating point under hard playing — that bias shift is what makes
 * the stage compress and change colour with pick attack rather than clip the
 * same way at every level.
 */

const OVERSAMPLE = 4;

// ─── Polyphase IIR halfband filters ──────────────────────────────────────────
// After Laurent de Soras' HIIR: a halfband lowpass split into two parallel
// chains of first-order allpass sections running at the lower rate. Designed
// at load time from a stopband attenuation and a transition bandwidth.

function designHalfband(attenuationDb, transition) {
  let k = Math.tan((1 - transition * 2) * Math.PI / 4);
  k *= k;
  const kksqrt = Math.pow(1 - k * k, 0.25);
  const e = 0.5 * (1 - kksqrt) / (1 + kksqrt);
  const e2 = e * e;
  const e4 = e2 * e2;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));

  const attn = Math.pow(10, -attenuationDb / 10);
  const a = attn / (1 - attn);
  let order = Math.ceil(Math.log(a * a / 16) / Math.log(q));
  if ((order & 1) === 0) order++;
  if (order === 1) order = 3;

  const count = (order - 1) / 2;
  const coefs = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const c = index + 1;
    let num = 0;
    for (let i = 0, sign = 1; ; i++, sign = -sign) {
      const term = Math.pow(q, i * (i + 1)) * Math.sin((i * 2 + 1) * c * Math.PI / order) * sign;
      num += term;
      if (Math.abs(term) <= 1e-100) break;
    }
    num *= Math.pow(q, 0.25);
    let den = 0;
    for (let i = 1, sign = -1; ; i++, sign = -sign) {
      const term = Math.pow(q, i * i) * Math.cos(i * 2 * c * Math.PI / order) * sign;
      den += term;
      if (Math.abs(term) <= 1e-100) break;
    }
    den += 0.5;
    const ww = num / den;
    const wwsq = ww * ww;
    const x = Math.sqrt((1 - wwsq * k) * (1 - wwsq / k)) / (1 + wwsq);
    coefs[index] = (1 - x) / (1 + x);
  }
  return coefs;
}

/**
 * The two allpass chains of one halfband filter. Even-indexed coefficients
 * belong to path 0, odd ones to path 1; run() advances both by one sample.
 */
class HalfbandPaths {
  constructor(coefs) {
    this.c = coefs;
    this.n = coefs.length;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
    this.o0 = 0;
    this.o1 = 0;
  }

  run(s0, s1) {
    const c = this.c, x = this.x, y = this.y, n = this.n;
    for (let i = 0; i < n; i += 2) {
      let t = x[i];
      x[i] = s0;
      s0 = y[i] = (s0 - y[i]) * c[i] + t;
      if (i + 1 < n) {
        t = x[i + 1];
        x[i + 1] = s1;
        s1 = y[i + 1] = (s1 - y[i + 1]) * c[i + 1] + t;
      }
    }
    this.o0 = s0;
    this.o1 = s1;
  }

  reset() {
    this.x.fill(0);
    this.y.fill(0);
  }
}

/** 2x upsampler: one input sample in, two out (in o0 then o1). */
class Upsampler2x extends HalfbandPaths {
  process(input) { this.run(input, input); }
}

/** 2x downsampler: two input samples in, one out. */
class Downsampler2x extends HalfbandPaths {
  process(first, second) {
    this.run(second, first);
    return 0.5 * (this.o0 + this.o1);
  }
}

// 48k↔96k needs a sharp filter to keep the audio band to ~22kHz flat. The
// 96k↔192k stage only has to clear images above ~72kHz, so it can be loose.
const COEFS_STAGE_1 = designHalfband(96, 0.02);
const COEFS_STAGE_2 = designHalfband(96, 0.12);

// ─── Stages ──────────────────────────────────────────────────────────────────

// Keeps the filters' recursive state away from denormals in silence. An
// alternating-sign offset is not removed by the coupling high-pass the way a
// constant one would be.
const ANTI_DENORMAL = 1e-20;

/**
 * Build the runtime state for one stage from its config. Corner frequencies
 * are converted to coefficients at the oversampled rate.
 *
 * Config fields (see AMP_VOICES in amp-models.js):
 *   type      'triode' | 'pushpull'
 *   gain      [min, max] linear gain across the drive knob (log taper)
 *   bias      operating-point offset (triode) — sets the asymmetry
 *   neg       negative-side headroom relative to positive (triode)
 *   block     how far grid-current excursions pull the bias (triode)
 *   sag       supply sag depth (pushpull)
 *   lp, hp    Miller low-pass and coupling high-pass corners, Hz
 */
function createStage(cfg, rate) {
  const onePole = (hz) => 1 - Math.exp(-2 * Math.PI * hz / rate);
  const timeCoef = (seconds) => 1 - Math.exp(-1 / (seconds * rate));
  const gain = Array.isArray(cfg.gain) ? cfg.gain : [cfg.gain ?? 1, cfg.gain ?? 1];
  const neg = cfg.neg ?? 1.6;
  const bias = cfg.bias ?? 0;
  return {
    pushpull: cfg.type === 'pushpull',
    gMin: Math.max(1e-6, gain[0]),
    gRatio: Math.max(1e-6, gain[1]) / Math.max(1e-6, gain[0]),
    g: 0,
    gTarget: 0,
    bias,
    neg,
    invNeg: 1 / neg,
    // Output at rest, subtracted so a stage does not step its own DC.
    rest: bias > 0 ? Math.tanh(bias) : neg * Math.tanh(bias / neg),
    block: cfg.block ?? 0,
    sag: cfg.sag ?? 0,
    env: 0,
    envAtk: timeCoef(cfg.attack ?? 0.004),
    envRel: timeCoef(cfg.release ?? 0.08),
    lpA: onePole(Math.min(cfg.lp ?? 20000, rate * 0.45)),
    lp: 0,
    hpA: Math.exp(-2 * Math.PI * (cfg.hp ?? 10) / rate),
    hpX: 0,
    hpY: 0,
  };
}

class TubeStageProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this._rate = sampleRate * OVERSAMPLE;
    this._up1 = new Upsampler2x(COEFS_STAGE_1);
    this._up2 = new Upsampler2x(COEFS_STAGE_2);
    this._down2 = new Downsampler2x(COEFS_STAGE_2);
    this._down1 = new Downsampler2x(COEFS_STAGE_1);
    this._os = new Float64Array(OVERSAMPLE);

    // Gain changes glide over ~10ms at the oversampled rate.
    this._smooth = 1 - Math.exp(-1 / (0.01 * this._rate));
    this._drive = -1;
    this._flip = 1;

    this._stages = this._build(options?.processorOptions?.stages);
    this._pending = null;
    this._fade = 0; // 0 = steady, 1 = fading out before a swap, 2 = fading in after

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === 'config') this._pending = this._build(msg.stages);
    };
  }

  _build(configs) {
    const list = Array.isArray(configs) && configs.length ? configs : [{ type: 'triode', gain: [1, 1] }];
    const stages = list.map(cfg => createStage(cfg, this._rate));
    // A fresh stage list starts at its target gain rather than gliding up from 0.
    if (this._drive >= 0) this._mapDrive(stages, this._drive, true);
    return stages;
  }

  _mapDrive(stages, drive, snap) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      s.gTarget = s.gMin * Math.pow(s.gRatio, drive);
      if (snap) s.g = s.gTarget;
    }
  }

  /** Run every stage on one oversampled sample. */
  _tick(x) {
    const stages = this._stages;
    const smooth = this._smooth;
    this._flip = -this._flip;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      s.g += (s.gTarget - s.g) * smooth;
      let y;
      if (s.pushpull) {
        // Supply sag: the louder the output has been, the less drive the stage
        // gets, so hard chords squash and bloom instead of hitting a wall.
        const u = x * s.g / (1 + s.sag * s.env);
        y = u / Math.sqrt(1 + u * u);
        const level = y < 0 ? -y : y;
        s.env += (level - s.env) * (level > s.env ? s.envAtk : s.envRel);
      } else {
        const u = x * s.g;
        // Grid current: positive signal swings charge the coupling cap and
        // drag the bias negative, which is what makes the stage feel the pick.
        // The envelope follows the signal, not the static bias, so a stage at
        // rest stays at rest; tanh bounds how far a hard hit can shift it.
        const v = u + s.bias - s.block * Math.tanh(s.env);
        y = v > 0 ? Math.tanh(v) : s.neg * Math.tanh(v * s.invNeg);
        y = s.rest - y; // a common-cathode stage inverts
        const grid = u > 0 ? u : 0;
        s.env += (grid - s.env) * (grid > s.env ? s.envAtk : s.envRel);
      }
      // Miller-capacitance low-pass, then the coupling-cap high-pass.
      s.lp += (y + this._flip * ANTI_DENORMAL - s.lp) * s.lpA;
      const hp = s.hpA * (s.hpY + s.lp - s.hpX);
      s.hpX = s.lp;
      s.hpY = hp;
      x = hp;
    }
    return x;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      output.fill(0);
      return true;
    }

    const drive = parameters.drive[0];
    if (drive !== this._drive) {
      const first = this._drive < 0;
      this._drive = drive;
      this._mapDrive(this._stages, drive, first);
    }

    const up1 = this._up1, up2 = this._up2, down1 = this._down1, down2 = this._down2;
    const n = output.length;
    for (let i = 0; i < n; i++) {
      up1.process(input[i]);
      const a = up1.o0, b = up1.o1;
      up2.process(a);
      const s0 = this._tick(up2.o0);
      const s1 = this._tick(up2.o1);
      up2.process(b);
      const s2 = this._tick(up2.o0);
      const s3 = this._tick(up2.o1);
      output[i] = down1.process(down2.process(s0, s1), down2.process(s2, s3));
    }

    // A new voice is swapped in across two render quanta: fade this one out,
    // swap, fade the next one in. Each is under 3ms, short enough not to be
    // heard as a gap and long enough not to click.
    if (this._fade === 1) {
      for (let i = 0; i < n; i++) output[i] *= 1 - (i + 1) / n;
      this._stages = this._pending;
      this._pending = null;
      this._mapDrive(this._stages, this._drive, true);
      this._fade = 2;
    } else if (this._fade === 2) {
      for (let i = 0; i < n; i++) output[i] *= (i + 1) / n;
      this._fade = 0;
    } else if (this._pending) {
      this._fade = 1;
    }
    return true;
  }
}

registerProcessor('tube-stage-processor', TubeStageProcessor);
