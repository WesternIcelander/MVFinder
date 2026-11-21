// The reference recording for an ISRC: its title, artists and duration, which YouTube results
// are then checked against. Spotify first, then (free, no key, no Spotify budget) Deezer, then
// MusicBrainz, which also has releases the big streaming services never carried.

import { config } from "./config.js";
import { lookupIsrc as spotifyIsrc, spotifyMode } from "./spotify.js";
import { openStore } from "./store.js";
import { HttpError, log, sleep } from "./util.js";

const DAY_MS = 24 * 3600_000;
const ISRC_FORMAT = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * "us-um7-12-34567", "USUM71234567 ", "isrc:USUM71234567" -> "USUM71234567".
 * Case and anything but letters and digits are ignored. Throws 400 if it isn't an ISRC.
 */
export function normalizeIsrc(input) {
  let s = String(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length === 16 && s.startsWith("ISRC")) s = s.slice(4);
  if (!ISRC_FORMAT.test(s)) {
    throw new HttpError(400, "request", `Not an ISRC: "${input}" (expected 12 characters like USUM71234567; dashes and spaces are ignored)`);
  }
  return s;
}

// ---------------------------------------------------------------- Deezer

async function fromDeezer(isrc) {
  const res = await fetch(`https://api.deezer.com/track/isrc:${isrc}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = await res.json();
  if (t.error) {
    if (t.error.code === 800) return null; // "no data"
    throw new Error(`${t.error.type ?? "error"}: ${t.error.message}`); // e.g. quota exceeded
  }
  if (!t.id || t.isrc?.toUpperCase() !== isrc) return null;
  const artists = (t.contributors ?? []).map((c) => c.name).filter(Boolean);
  return {
    service: "deezer",
    type: "track",
    id: String(t.id),
    url: t.link ?? `https://www.deezer.com/track/${t.id}`,
    title: t.title,
    artists: artists.length ? artists : [t.artist?.name].filter(Boolean),
    album: t.album?.title ?? null,
    durationMs: t.duration ? t.duration * 1000 : null,
    isrc,
  };
}

// ---------------------------------------------------------------- MusicBrainz

const MUSICBRAINZ_INTERVAL_MS = 1100; // their limit is 1 request per second
// MusicBrainz signals rate limiting with 503 (not 429): wait this long, then retry.
const MUSICBRAINZ_RETRY_DELAYS_MS = [2000, 5000];
let musicbrainzNextAt = 0;

/** Wait for MusicBrainz's next request slot (at least `minWaitMs` from now). */
async function musicbrainzSlot(minWaitMs = 0) {
  const now = Date.now();
  const at = Math.max(now + minWaitMs, musicbrainzNextAt);
  musicbrainzNextAt = at + MUSICBRAINZ_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

async function fromMusicBrainz(isrc) {
  const delays = config.isrc.musicbrainzRetryDelaysMs ?? MUSICBRAINZ_RETRY_DELAYS_MS;
  let res;
  for (let attempt = 0; ; attempt++) {
    await musicbrainzSlot(attempt ? delays[attempt - 1] : 0);
    res = await fetch(`https://musicbrainz.org/ws/2/isrc/${isrc}?inc=artist-credits&fmt=json`, {
      headers: { accept: "application/json", "user-agent": config.isrc.musicbrainzUserAgent },
    });
    if (res.status !== 503 || attempt >= delays.length) break;
    const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
    musicbrainzNextAt = Math.max(musicbrainzNextAt, Date.now() + Math.max(retryAfter, delays[attempt])); // slow everyone down
  }
  if (res.status === 404) return null;
  if (res.status === 503) throw new HttpError(503, "musicbrainz", "rate limited (HTTP 503)");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const recordings = (await res.json()).recordings ?? [];
  // Several recordings can share an ISRC (mostly duplicates); one with a length is more useful.
  const r = recordings.find((x) => x.length) ?? recordings[0];
  if (!r) return null;
  return {
    service: "musicbrainz",
    type: "recording",
    id: r.id,
    url: `https://musicbrainz.org/recording/${r.id}`,
    title: r.title,
    artists: (r["artist-credit"] ?? []).map((a) => a.name).filter(Boolean),
    album: null,
    durationMs: r.length ?? null,
    isrc,
  };
}

// ---------------------------------------------------------------- Lookup

const FALLBACKS = { deezer: fromDeezer, musicbrainz: fromMusicBrainz };
let store = null; // opened on first use
const inFlight = new Map();

/** A fallback's answer, cached on disk (a "not found" for a day). Null if it has none. */
async function cachedLookup(name, isrc) {
  store ??= openStore("isrc-sources", { maxEntries: 50_000 });
  const key = `${name}:${isrc}`;
  const hit = store.get(key);
  if (hit !== undefined) return hit.notFound ? null : hit;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = FALLBACKS[name](isrc)
      .then((rec) => {
        store.set(key, rec ?? { notFound: true }, rec ? {} : { ttlMs: DAY_MS });
        return rec;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return structuredClone(await pending);
}

/**
 * The recording with this (normalized) ISRC from the first source that has it. Throws 404 if no
 * source has it, or 503/502 if it wasn't found but some source couldn't be asked.
 */
export async function lookupIsrcSource(isrc) {
  const asked = [];
  const problems = []; // [status, message]
  if (spotifyMode() === "api") {
    asked.push("Spotify");
    try {
      return { ...(await spotifyIsrc(isrc)), metadataSource: "api" };
    } catch (err) {
      if (err.status !== 404) problems.push([err.status === 503 ? 503 : 502, `Spotify: ${err.message}`]);
    }
  }
  for (const name of config.isrc.fallbacks) {
    if (!FALLBACKS[name]) continue;
    asked.push(name === "deezer" ? "Deezer" : "MusicBrainz");
    try {
      const rec = await cachedLookup(name, isrc);
      if (rec) return rec;
    } catch (err) {
      log(`isrc: ${name} lookup failed for ${isrc}: ${err.message}`);
      problems.push([err.status === 503 ? 503 : 502, `${name}: ${err.message}`]);
    }
  }
  if (problems.length) {
    const status = problems.some(([s]) => s === 503) ? 503 : 502;
    throw new HttpError(status, "isrc", `ISRC ${isrc} not found, and not every source could be asked: ${problems.map(([, m]) => m).join("; ")}`);
  }
  if (!asked.length) throw new HttpError(503, "isrc", "ISRC lookups need Spotify credentials or ISRC_FALLBACKS");
  throw new HttpError(404, "isrc", `No recording with ISRC ${isrc} on ${asked.join(", ")}`);
}
