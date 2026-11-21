// Key-value caches in one SQLite database (Node's built-in node:sqlite), DATA_DIR/cache.db.
// Lookups read only the entry asked for, writes touch only changed entries, entries can expire,
// and each namespace can be capped (least recently used entries are dropped first).

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const TOUCH_AFTER_MS = 3600_000; // refresh an entry's "last used" time at most hourly
const EVICT_EVERY_SETS = 100;

export function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (
      ns         TEXT    NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL, -- JSON
      expires_at INTEGER,          -- epoch ms; NULL = never
      used_at    INTEGER NOT NULL, -- epoch ms, for LRU eviction
      PRIMARY KEY (ns, key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS kv_used ON kv (ns, used_at);
    CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at) WHERE expires_at IS NOT NULL;
  `);
  return db;
}

/** One namespace of the kv table, with a Map-like interface. */
export class Store {
  constructor(db, ns, { maxEntries = Infinity } = {}) {
    Object.assign(this, { db, ns, maxEntries, setsSinceEvict: 0 });
    this.q = {
      get: db.prepare("SELECT value, expires_at, used_at FROM kv WHERE ns = ? AND key = ?"),
      set: db.prepare(`INSERT INTO kv (ns, key, value, expires_at, used_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, used_at = excluded.used_at`),
      touch: db.prepare("UPDATE kv SET used_at = ? WHERE ns = ? AND key = ?"),
      delete: db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?"),
      size: db.prepare("SELECT COUNT(*) AS n FROM kv WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?)"),
      total: db.prepare("SELECT COUNT(*) AS n FROM kv WHERE ns = ?"),
      evict: db.prepare("DELETE FROM kv WHERE ns = ? AND key IN (SELECT key FROM kv WHERE ns = ? ORDER BY used_at LIMIT ?)"),
    };
    this.evict();
  }

  /** The value, or undefined if absent or expired. */
  get(key) {
    const row = this.q.get.get(this.ns, key);
    const now = Date.now();
    if (!row || (row.expires_at != null && row.expires_at <= now)) return undefined;
    if (now - row.used_at > TOUCH_AFTER_MS) this.q.touch.run(now, this.ns, key);
    return JSON.parse(row.value);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  /** ttlMs: how long the entry stays valid (default: forever). */
  set(key, value, { ttlMs = null } = {}) {
    const now = Date.now();
    this.q.set.run(this.ns, key, JSON.stringify(value), ttlMs == null ? null : now + ttlMs, now);
    if (++this.setsSinceEvict >= EVICT_EVERY_SETS) this.evict();
    return this;
  }

  delete(key) {
    return this.q.delete.run(this.ns, key).changes > 0;
  }

  /** Number of valid (unexpired) entries. */
  get size() {
    return Number(this.q.size.get(this.ns, Date.now()).n);
  }

  evict() {
    this.setsSinceEvict = 0;
    if (!Number.isFinite(this.maxEntries)) return;
    const excess = Number(this.q.total.get(this.ns).n) - this.maxEntries;
    if (excess > 0) this.q.evict.run(this.ns, this.ns, excess);
  }
}

/** Delete expired entries in all namespaces. Returns how many. */
export function purgeExpired(db) {
  return Number(db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(Date.now()).changes);
}

/**
 * One-time import of a JSON cache from before the SQLite switch ([[key, value], ...]).
 * `add(key, value)` stores each entry; the file is then renamed to *.imported.
 */
export function importLegacyJson(file, add) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return 0; // no legacy file
  }
  for (const [key, value] of entries) add(key, value);
  fs.renameSync(file, `${file}.imported`);
  return entries.length;
}

// ---------------------------------------------------------------- The app's database

let appDb = null;

/** The shared cache database in DATA_DIR (opened on first use). */
export function cacheDb() {
  appDb ??= openDatabase(path.join(config.dataDir, "cache.db"));
  return appDb;
}

export const openStore = (ns, opts) => new Store(cacheDb(), ns, opts);

export function closeCacheDb() {
  appDb?.close();
  appDb = null;
}
