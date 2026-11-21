// YouTube Music search through youtubei.js, with automatic, verified library updates.
//
// The library is installed outside the app (baked-in baseline at /opt/ytjs, updates under
// DATA_DIR/ytjs/<version>). A new version is only switched in after it passes a live self-test,
// and it's loaded with a fresh import() — so updates need no restart and never take the
// service down: if the new version doesn't work, the current one stays.

import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, Semaphore, log, sleep } from "./util.js";
import {
  PKG,
  installVersion,
  installedVersion,
  isExactSpec,
  loadModule,
  resolveTargetVersion,
  validateSpec,
} from "./ytjs-package.js";

// YouTube's own classification of each result.
const KIND_BY_VIDEO_TYPE = {
  MUSIC_VIDEO_TYPE_ATV: "song", // audio track with static album art: the YouTube Music version
  MUSIC_VIDEO_TYPE_OMV: "music_video",
  MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC: "official_video",
  MUSIC_VIDEO_TYPE_UGC: "user_video",
};

const VIDEO_MARKER = /\b(official )?music video\b|\bofficial video\b|\bm\/?v\b/i;
export const hasVideoMarker = (title) => VIDEO_MARKER.test(title);

// YouTube tags plenty of static "Official Audio" / visualizer uploads as OMV, so refine
// official uploads by title. User uploads stay "user_video".
export function refineKind(kind, title) {
  if (kind !== "music_video" && kind !== "official_video") return kind;
  const t = title.toLowerCase();
  if (VIDEO_MARKER.test(t)) return "music_video";
  if (/\bvisuali[sz]er\b/.test(t)) return "visualizer";
  if (/\blyrics?( video)?\b/.test(t)) return "lyric_video";
  if (/\b(official )?audio\b|\bart track\b/.test(t)) return "official_audio";
  return kind;
}

function videoTypeOf(item) {
  for (const ep of [item.overlay?.content?.endpoint, item.flex_columns?.[0]?.title?.endpoint, item.endpoint]) {
    const t = ep?.payload?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType;
    if (t) return t;
  }
  return null;
}

/** Convert a youtubei.js MusicResponsiveListItem into our result shape. */
export function toResult(item) {
  if (!item?.id) return null;
  const title = item.title ?? "";
  const videoType = videoTypeOf(item);
  const people = item.artists ?? item.authors ?? (item.author ? [item.author] : []);
  let artists = people.map((p) => p.name).filter(Boolean);
  if (!artists.length) {
    // Artists without a channel link aren't parsed; read them from the "Artist • Album • 3:33" line.
    const subtitle = item.flex_columns?.[1]?.title?.text ?? "";
    artists = subtitle.split(" • ")[0].split(/\s*(?:,|&)\s*/).map((a) => a.trim()).filter(Boolean);
  }
  return {
    videoId: item.id,
    videoType,
    kind: refineKind(KIND_BY_VIDEO_TYPE[videoType] ?? "other", title),
    title,
    artists,
    album: item.album?.name ?? null,
    durationMs: item.duration?.seconds != null ? item.duration.seconds * 1000 : null,
  };
}

export class Client {
  constructor(mod, { version, dir, source }, cfg) {
    Object.assign(this, { mod, version, dir, source, cfg, loadedAt: null });
  }

  // When YouTube answers the session's config request with an HTML page (it sometimes does,
  // e.g. under bursts), youtubei.js logs an error but returns the session anyway, and searches
  // on it can then fail with 403. So check for the config and try again a couple of times.
  async createSession() {
    let yt;
    for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
      yt = await this.mod.Innertube.create({ retrieve_player: false, lang: this.cfg.lang, location: this.cfg.location });
      if (yt.session?.config_data !== undefined || !("config_data" in (yt.session ?? {}))) return yt;
      log(`youtube: session created without config data (attempt ${attempt}/${SESSION_ATTEMPTS})`);
      if (attempt < SESSION_ATTEMPTS) await sleep((this.cfg.sessionRetryDelayMs ?? 1000) * attempt);
    }
    return yt; // may still work; a failing search replaces it
  }

  async init() {
    try {
      this.mod.Log?.setLevel?.(this.mod.Log.Level.ERROR); // silence parser warnings
    } catch {}
    this.sessions = [];
    await this.session(0);
  }

  // Session 0 serves ordinary searches. Some searches (notably by ISRC) give different results
  // per session, and a session that gets a bad result keeps getting it, so callers can ask for
  // alternative sessions (n > 0); those are created on first use and replaced after
  // EXTRA_SESSION_TTL_MS, so later retries see new ones.
  session(n) {
    const cur = this.sessions[n];
    if (!cur || (n > 0 && Date.now() - cur.createdAt > EXTRA_SESSION_TTL_MS)) this.renewSession(n);
    return this.sessions[n].promise;
  }

  /** Replace session n (unless `stale` is given and it has already been replaced). */
  renewSession(n, stale = null) {
    if (stale && this.sessions[n]?.promise !== stale) return;
    const promise = this.createSession().catch((err) => {
      if (this.sessions[n]?.promise === promise) this.sessions[n] = null;
      throw err;
    });
    this.sessions[n] = { promise, createdAt: Date.now() };
  }

  /** filter: "songs" | "videos" */
  // Sessions can go bad or stale, and under bursts YouTube refuses some searches (403) for a
  // little while. So on failure, wait, replace this session (only), and try again.
  async search(query, filter, sessionIndex = 0) {
    const delays = this.cfg.searchRetryDelaysMs ?? SEARCH_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const session = this.session(sessionIndex);
      try {
        return await this.searchWith(await session, query, filter);
      } catch (err) {
        if (attempt >= delays.length) throw err;
        log(`youtube: search failed (${err.message.slice(-60)}); retrying on a new session`);
        this.renewSession(sessionIndex, session);
        await sleep(delays[attempt]);
      }
    }
  }

  async searchWith(yt, query, filter) {
    const r = await yt.music.search(query, { type: filter === "songs" ? "song" : "video" });
    return (r.contents ?? [])
      .filter((s) => s.type === "MusicShelf")
      .flatMap((s) => s.contents ?? [])
      .map(toResult)
      .filter(Boolean);
  }
}

// A live search whose results we know: proves the library works AND that our parsing still fits.
async function selfTest(client) {
  const q = "Rick Astley Never Gonna Give You Up";
  const songs = await client.search(q, "songs");
  if (!songs.some((r) => r.kind === "song" && r.title && r.artists.length && r.durationMs)) {
    throw new Error(`self-test: song search gave ${songs.length} results, none a complete song`);
  }
  const videos = await client.search(q, "videos");
  if (!videos.some((r) => r.videoType === "MUSIC_VIDEO_TYPE_OMV" && r.artists.length && r.durationMs)) {
    throw new Error(`self-test: video search gave ${videos.length} results, none a complete official video`);
  }
}

const RETRIGGER_MS = 30 * 60_000; // min gap between failure-triggered update checks
const EXTRA_SESSION_TTL_MS = 30 * 60_000;
const SESSION_ATTEMPTS = 3;
const SEARCH_RETRY_DELAYS_MS = [2000, 5000];

export class YouTubeManager {
  constructor(cfg) {
    validateSpec(cfg.packageSpec);
    this.cfg = cfg;
    this.root = path.join(cfg.dataDir, "ytjs");
    this.client = null;
    this.sem = new Semaphore(cfg.concurrency);
    this.updating = null;
    this.lastTriggeredCheck = 0;
    this.status = { lastUpdateCheck: null, lastSelfTest: null, rejectedVersions: {} };
  }

  versionLabel() {
    return this.client ? `${PKG}@${this.client.version}` : "none";
  }

  health() {
    const c = this.client;
    return {
      ok: Boolean(c) && this.status.lastSelfTest?.ok !== false,
      package: PKG,
      version: c?.version ?? null,
      installSource: c?.source ?? null,
      loadedAt: c?.loadedAt ?? null,
      versionSpec: this.cfg.packageSpec,
      minReleaseAgeHours: this.cfg.minReleaseAgeHours,
      updateIntervalHours: this.cfg.updateIntervalHours,
      ...this.status,
    };
  }

  async start() {
    await fs.mkdir(this.root, { recursive: true });
    const candidates = [];
    const persisted = await this.readActive();
    if (persisted) candidates.push({ ...persisted, source: "updated" });
    const baseline = await installedVersion(this.cfg.baselineDir);
    if (baseline) candidates.push({ version: baseline, dir: this.cfg.baselineDir, source: "baseline" });

    for (const c of candidates) {
      try {
        await this.activate(c);
        break;
      } catch (err) {
        log(`youtube: ${PKG}@${c.version} (${c.source}) failed to start: ${err.message}`);
      }
    }
    if (!this.client) log("youtube: no working client yet; will try installing one");

    this.checkForUpdate("startup");
    const every = this.cfg.updateIntervalHours * 3600_000;
    if (every > 0) setInterval(() => this.periodic(), every).unref();
  }

  async readActive() {
    try {
      const a = JSON.parse(await fs.readFile(path.join(this.root, "active.json"), "utf8"));
      return (await installedVersion(a.dir)) === a.version ? a : null;
    } catch {
      return null;
    }
  }

  async activate(candidate, { persist = false } = {}) {
    const client = new Client(await loadModule(candidate.dir), candidate, this.cfg);
    await client.init();
    await selfTest(client);
    client.loadedAt = new Date().toISOString();
    this.client = client;
    this.status.lastSelfTest = { at: client.loadedAt, ok: true };
    if (persist) {
      await fs.writeFile(path.join(this.root, "active.json"), JSON.stringify({ version: client.version, dir: client.dir }));
    }
    log(`youtube: using ${PKG}@${client.version} (${client.source})`);
  }

  async periodic() {
    if (this.client) {
      try {
        await selfTest(this.client);
        this.status.lastSelfTest = { at: new Date().toISOString(), ok: true };
      } catch (err) {
        this.status.lastSelfTest = { at: new Date().toISOString(), ok: false, error: err.message };
        log(`youtube: ${err.message}`);
      }
    }
    await this.checkForUpdate("scheduled", { force: true });
  }

  /** Check npm for a newer eligible version; install, verify and switch to it. Never throws. */
  checkForUpdate(reason, { force = false } = {}) {
    if (this.updating) return this.updating;
    if (!force && reason !== "startup" && Date.now() - this.lastTriggeredCheck < RETRIGGER_MS) return Promise.resolve();
    this.lastTriggeredCheck = Date.now();
    this.updating = this.update(reason)
      .catch((err) => {
        this.recordCheck(reason, "error", { error: err.message });
        log(`youtube: update check failed: ${err.message}`);
      })
      .finally(() => {
        this.updating = null;
      });
    return this.updating;
  }

  recordCheck(reason, result, extra = {}) {
    this.status.lastUpdateCheck = { at: new Date().toISOString(), reason, result, ...extra };
  }

  async update(reason) {
    const { packageSpec: spec, minReleaseAgeHours: age } = this.cfg;
    const target = await resolveTargetVersion(spec, age);
    const current = this.client?.version ?? null;
    if (!target) return this.recordCheck(reason, "no-eligible-version", { current });
    if (target === current) return this.recordCheck(reason, "up-to-date", { current });
    if (this.status.rejectedVersions[target]) return this.recordCheck(reason, "skipped-rejected", { current, target });

    const dir = path.join(this.root, target);
    if ((await installedVersion(dir)) !== target) {
      log(`youtube: installing ${PKG}@${target} (${reason})`);
      await installVersion(target, dir, {
        cacheDir: path.join(this.root, ".npm-cache"),
        beforeMs: isExactSpec(spec) ? null : Date.now() - age * 3600_000,
      });
    }

    const previousDir = this.client?.dir ?? null;
    try {
      await this.activate({ version: target, dir, source: "updated" }, { persist: true });
    } catch (err) {
      this.status.rejectedVersions[target] = err.message;
      log(`youtube: rejected ${PKG}@${target}, staying on ${current ?? "nothing"}: ${err.message}`);
      return this.recordCheck(reason, "rejected", { current, target, error: err.message });
    }
    this.recordCheck(reason, "updated", { from: current, to: target });
    await this.prune([dir, previousDir]);
  }

  /** Delete installed versions other than the active one and the previous one (rollback). */
  async prune(keep) {
    for (const name of await fs.readdir(this.root).catch(() => [])) {
      const full = path.join(this.root, name);
      if (/^\d+\.\d+\.\d+$/.test(name) && !keep.includes(full)) await fs.rm(full, { recursive: true, force: true });
    }
  }

  /** filter: "songs" | "videos"; session: 0 = main session, 1+ = alternative sessions */
  async search(query, filter, { session = 0 } = {}) {
    const client = this.client;
    if (!client) {
      this.checkForUpdate("no-client");
      throw new HttpError(503, "youtube", "No working YouTube client yet; see /health");
    }
    await this.sem.acquire();
    try {
      return await client.search(query, filter, session); // replaces a failing session and retries once
    } catch (err) {
      this.checkForUpdate("search-error");
      throw new HttpError(502, "youtube", `YouTube search failed: ${err.message}`);
    } finally {
      this.sem.release();
    }
  }
}
