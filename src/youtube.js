// YouTube Music search through youtubei.js, with automatic, verified library updates.
//
// The library is installed outside the app (baked-in baseline at /opt/ytjs, updates under
// DATA_DIR/ytjs/<version>). A new version is only switched in after it passes a live self-test,
// and it's loaded with a fresh import() — so updates need no restart and never take the
// service down: if the new version doesn't work, the current one stays.

import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, Semaphore, log } from "./util.js";
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

class Client {
  constructor(mod, { version, dir, source }, cfg) {
    Object.assign(this, { mod, version, dir, source, cfg, loadedAt: null, reinit: null });
  }

  createSession() {
    return this.mod.Innertube.create({ retrieve_player: false, lang: this.cfg.lang, location: this.cfg.location });
  }

  async init() {
    try {
      this.mod.Log?.setLevel?.(this.mod.Log.Level.ERROR); // silence parser warnings
    } catch {}
    this.yt = await this.createSession();
    this.extraSessions = [];
  }

  // Some searches (notably by ISRC) give different results per session, and a session that gets
  // a bad result keeps getting it. So callers can ask for an alternative session; those are
  // created on first use and replaced after EXTRA_SESSION_TTL_MS, so later retries see new ones.
  session(n) {
    if (!n) return this.yt;
    const cur = this.extraSessions[n];
    if (!cur || Date.now() - cur.createdAt > EXTRA_SESSION_TTL_MS) {
      const promise = this.createSession().catch((err) => {
        if (this.extraSessions[n]?.promise === promise) this.extraSessions[n] = null;
        throw err;
      });
      this.extraSessions[n] = { promise, createdAt: Date.now() };
    }
    return this.extraSessions[n].promise;
  }

  /** filter: "songs" | "videos" */
  async search(query, filter, sessionIndex = 0) {
    const yt = await this.session(sessionIndex);
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
      try {
        return await client.search(query, filter, session);
      } catch {
        // Sessions can go stale: recreate it once before blaming the library.
        client.reinit ??= client.init().finally(() => {
          client.reinit = null;
        });
        await client.reinit;
        return await client.search(query, filter, session);
      }
    } catch (err) {
      this.checkForUpdate("search-error");
      throw new HttpError(502, "youtube", `YouTube search failed: ${err.message}`);
    } finally {
      this.sem.release();
    }
  }
}
