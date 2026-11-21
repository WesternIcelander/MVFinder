// A Map that persists itself to a JSON file in DATA_DIR, so caches survive restarts.
// Insertion order is kept (and refreshed on set), so it also works as an LRU.

import fs from "node:fs";
import path from "node:path";

const stores = [];

export class PersistentMap {
  constructor(file, { maxEntries = Infinity, saveDelayMs = 5000 } = {}) {
    Object.assign(this, { file, maxEntries, saveDelayMs, timer: null, map: new Map() });
    try {
      for (const [k, v] of JSON.parse(fs.readFileSync(file, "utf8"))) this.map.set(k, v);
    } catch {} // missing or unreadable: start empty
    stores.push(this);
  }

  get size() {
    return this.map.size;
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    return this.map.get(key);
  }
  keys() {
    return this.map.keys();
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    this.scheduleSave();
    return this;
  }

  delete(key) {
    const existed = this.map.delete(key);
    if (existed) this.scheduleSave();
    return existed;
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), this.saveDelayMs);
    this.timer.unref?.();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.map]));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`${new Date().toISOString()} store: could not save ${this.file}: ${err.message}`);
    }
  }
}

/** Write all pending changes now (on shutdown). */
export function flushStores() {
  for (const s of stores) if (s.timer) s.save();
}
