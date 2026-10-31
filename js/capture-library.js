/**
 * Capture Library — NAM captures and cabinet IRs the player has loaded, kept
 * in IndexedDB so they survive a reload and presets can refer to them by id.
 *
 * Metadata and payload live in separate object stores: listing the library
 * for the pickers then never pulls megabytes of model weights into memory.
 * If IndexedDB is unavailable (private window, blocked storage) everything
 * still works for the session from an in-memory map; it just isn't kept.
 */

const DB_NAME = 'guitarshop';
const DB_VERSION = 1;
const META_STORE = 'captures';
const DATA_STORE = 'captureData';

// NAM's gear_type values for captures recorded through a speaker and mic.
const GEAR_TYPES_WITH_CAB = new Set(['amp_cab', 'amp_pedal_cab']);

// Anything longer than this is a reverb or a song, not a cabinet.
const MAX_IR_SECONDS = 10;

const GEAR_LABELS = {
  amp: 'amp',
  preamp: 'preamp',
  pedal: 'pedal',
  pedal_amp: 'pedal + amp',
  amp_cab: 'amp + cab',
  amp_pedal_cab: 'pedal + amp + cab',
  studio: 'studio',
};

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

/** One line describing a library entry, for the amp's info strip. */
export function describeCapture(entry) {
  if (!entry) return '';
  const parts = [];
  if (entry.kind === 'ir') {
    parts.push(`IR · ${entry.meta?.duration ? `${Math.round(entry.meta.duration * 1000)}ms` : 'impulse response'}`);
  } else {
    const gear = [entry.meta?.gearMake, entry.meta?.gearModel].filter(Boolean).join(' ');
    if (gear && gear !== entry.name) parts.push(gear);
    if (entry.gearType) parts.push(GEAR_LABELS[entry.gearType] || entry.gearType);
    if (entry.meta?.modeledBy) parts.push(`by ${entry.meta.modeledBy}`);
    if (entry.meta?.architecture) parts.push(entry.meta.architecture);
  }
  return parts.join(' · ');
}

export class CaptureLibrary {
  constructor() {
    this._dbPromise = null;
    // Fallback store when IndexedDB cannot be opened.
    this._memory = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    }).catch((err) => {
      console.warn('[CaptureLibrary] IndexedDB unavailable — captures will last this session only:', err);
      this._memory = this._memory || new Map();
      return null;
    });
    return this._dbPromise;
  }

  /**
   * Library entries for one slot ('amp', 'cab' or 'pedal'), without their payloads,
   * sorted by name.
   * @returns {Promise<Array<object>>}
   */
  async list(slot) {
    const db = await this._open();
    let entries;
    if (db) {
      try {
        const tx = db.transaction(META_STORE, 'readonly');
        entries = await promisify(tx.objectStore(META_STORE).getAll());
      } catch (err) {
        console.warn('[CaptureLibrary] Could not list captures:', err);
        entries = [];
      }
    } else {
      entries = [...this._memory.values()].map(({ data, ...meta }) => meta);
    }
    return entries
      .filter(e => !slot || e.slot === slot)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Entry metadata plus its payload (`data`), or null if it is gone. */
  async get(id) {
    const db = await this._open();
    if (!db) return this._memory.get(id) || null;
    try {
      const tx = db.transaction([META_STORE, DATA_STORE], 'readonly');
      const [meta, data] = await Promise.all([
        promisify(tx.objectStore(META_STORE).get(id)),
        promisify(tx.objectStore(DATA_STORE).get(id)),
      ]);
      return meta && data !== undefined ? { ...meta, data } : null;
    } catch (err) {
      console.warn('[CaptureLibrary] Could not read capture:', err);
      return null;
    }
  }

  /** Merge fields into an entry's metadata (e.g. the includes-cab flag). */
  async update(id, patch) {
    const db = await this._open();
    if (!db) {
      const entry = this._memory.get(id);
      if (entry) this._memory.set(id, { ...entry, ...patch, id });
      return;
    }
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const meta = await promisify(store.get(id));
    if (meta) store.put({ ...meta, ...patch, id });
    await txDone(tx);
  }

  async remove(id) {
    const db = await this._open();
    if (!db) {
      this._memory.delete(id);
      return;
    }
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(DATA_STORE).delete(id);
    await txDone(tx);
  }

  /**
   * Validate a file and add it to the library.
   *
   * `.nam` files are NAM captures; anything else is treated as an impulse
   * response and must decode as audio. Importing the same file into the same
   * slot twice returns the existing entry instead of a duplicate. The pedal
   * slot is one library shared by every pedal's picker.
   *
   * @param {File} file
   * @param {'amp'|'cab'|'pedal'} slot - which picker the entry belongs to
   * @returns {Promise<object>} the stored entry's metadata
   */
  async importFile(file, slot) {
    const isNam = /\.nam$/i.test(file.name);
    if ((slot === 'amp' || slot === 'pedal') && !isNam) {
      throw new Error(`${slot === 'amp' ? 'Amp' : 'Pedal'} captures must be NAM files (.nam).`);
    }

    const existing = (await this.list(slot)).find(e => e.fileName === file.name && e.size === file.size);
    if (existing) return existing;

    const entry = isNam ? await this._parseNam(file, slot) : await this._parseIR(file);
    const { data, ...meta } = entry;

    const db = await this._open();
    if (!db) {
      this._memory.set(meta.id, entry);
      return meta;
    }
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(DATA_STORE).put(data, meta.id);
    await txDone(tx);
    return meta;
  }

  async _parseNam(file, slot) {
    const text = await file.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`"${file.name}" is not a valid NAM file (not JSON).`);
    }
    if (!json || typeof json.architecture !== 'string' || typeof json.config !== 'object') {
      throw new Error(`"${file.name}" is not a NAM capture (no architecture/config).`);
    }
    const m = json.metadata || {};
    const gearType = typeof m.gear_type === 'string' ? m.gear_type : null;
    return {
      id: newId(),
      kind: 'nam',
      slot,
      name: (typeof m.name === 'string' && m.name.trim()) || baseName(file.name),
      fileName: file.name,
      size: file.size,
      gearType,
      // Only meaningful in the amp slot: a capture taken through a mic'd
      // speaker already has its cabinet, so the cab slot should switch off.
      includesCab: slot === 'amp' && GEAR_TYPES_WITH_CAB.has(gearType),
      sampleRate: Number(json.sample_rate) || null,
      meta: {
        architecture: json.architecture,
        version: json.version ?? null,
        gearMake: m.gear_make ?? null,
        gearModel: m.gear_model ?? null,
        modeledBy: m.modeled_by ?? null,
        toneType: m.tone_type ?? null,
        loudness: typeof m.loudness === 'number' ? m.loudness : null,
      },
      addedAt: Date.now(),
      data: text,
    };
  }

  async _parseIR(file) {
    const data = await file.arrayBuffer();
    let decoded;
    try {
      // A throwaway context — decoding needs no user gesture and no running audio.
      const ctx = new OfflineAudioContext(1, 1, 48000);
      decoded = await ctx.decodeAudioData(data.slice(0));
    } catch {
      throw new Error(`"${file.name}" could not be decoded as audio. Try an uncompressed WAV.`);
    }
    if (decoded.duration > MAX_IR_SECONDS) {
      throw new Error(`"${file.name}" is ${decoded.duration.toFixed(1)}s long — too long for a cabinet IR.`);
    }
    return {
      id: newId(),
      kind: 'ir',
      slot: 'cab',
      name: baseName(file.name),
      fileName: file.name,
      size: file.size,
      gearType: null,
      includesCab: false,
      sampleRate: null,
      meta: { duration: decoded.duration, channels: decoded.numberOfChannels },
      addedAt: Date.now(),
      data,
    };
  }
}
