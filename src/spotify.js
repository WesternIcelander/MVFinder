// Spotify metadata, spending as few Web API requests as possible.
//
// Development Mode apps get a small daily allowance (roughly 750 requests a day, which may be
// shared with other tools using the same app), and overshooting can mean hours of HTTP 429. So:
//  - album and playlist track lists come from the public embed page, which costs no API requests
//    (since Feb 2026 the API won't list playlists the app doesn't own anyway);
//  - the API is only used per track (for the ISRC and canonical names), at most once per track:
//    track records are cached on disk;
//  - requests are paced, counted against a daily budget, and stopped entirely while Spotify says
//    to back off. Without the API everything still works, just without ISRCs.

import path from "node:path";
import { config } from "./config.js";
import { PersistentMap } from "./store.js";
import { HttpError, log, sleep } from "./util.js";

const API = "https://api.spotify.com/v1";
// A plain UA: with a full browser UA Spotify serves a JS-only page without the metadata.
const UA = "Mozilla/5.0";
const EMBED_TRACK_LIMIT = 100;
const DAY_MS = 24 * 3600_000;

const hasCredentials = () => Boolean(config.spotify.clientId && config.spotify.clientSecret);
export const spotifyMode = () => (hasCredentials() ? "api" : "embed-only");

const openUrl = (type, id) => `https://open.spotify.com/${type}/${id}`;

// ---------------------------------------------------------------- Request budget and backoff

// "calls": timestamps of API requests in the last 24 h; "blockedUntil": end of a Retry-After.
const state = new PersistentMap(path.join(config.dataDir, "spotify-state.json"), { saveDelayMs: 1000 });
// "<id>" -> track record, "<id>|<lang>" -> localised record; null = not found.
const trackStore = new PersistentMap(path.join(config.dataDir, "spotify-tracks.json"), { maxEntries: 200_000 });

const recentCalls = () => (state.get("calls") ?? []).filter((t) => t > Date.now() - DAY_MS);
const blockedUntil = () => state.get("blockedUntil") ?? 0;

/** Why the API can't be used right now, or null if it can. */
function unavailableReason() {
  if (!hasCredentials()) return "no credentials";
  if (Date.now() < blockedUntil()) return `rate limited until ${new Date(blockedUntil()).toISOString()}`;
  if (recentCalls().length >= config.spotify.dailyRequestBudget) return `daily budget of ${config.spotify.dailyRequestBudget} requests used`;
  return null;
}

/** True when credentials are set but the API can't be used right now (results lack ISRCs). */
export const spotifyDegraded = () => hasCredentials() && unavailableReason() !== null;

export function spotifyStatus() {
  return {
    mode: spotifyMode(),
    apiUnavailable: hasCredentials() ? unavailableReason() : null,
    requestsLast24h: recentCalls().length,
    dailyRequestBudget: config.spotify.dailyRequestBudget,
    rateLimitedUntil: Date.now() < blockedUntil() ? new Date(blockedUntil()).toISOString() : null,
    cachedTracks: trackStore.size,
  };
}

let nextSlotAt = 0;

/** Wait for a pacing slot, check the budget and backoff, and count one request. */
async function spend() {
  const unavailable = () => {
    const reason = unavailableReason();
    if (reason) throw new HttpError(503, "spotify", `Spotify API not used: ${reason}`, 429);
  };
  unavailable();
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 1000 / config.spotify.maxRequestsPerSecond;
  if (at > now) await sleep(at - now);
  unavailable(); // again: a 429 or the budget may have been hit while we waited
  state.set("calls", [...recentCalls(), Date.now()]);
}

// ---------------------------------------------------------------- Web API

let token = null; // { value, expiresAt }
let tokenRequest = null; // in-flight token request, shared by concurrent callers

function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return Promise.resolve(token.value);
  tokenRequest ??= requestToken().finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

async function requestToken() {
  await spend();
  const { clientId, clientSecret } = config.spotify;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new HttpError(502, "spotify", `Spotify token request failed (HTTP ${res.status}); check SPOTIFY_CLIENT_ID/SECRET`, res.status);
  }
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function api(pathOrUrl, { lang = null } = {}, attempt = 0) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
  const auth = await getToken();
  await spend();
  const res = await fetch(url, { headers: { authorization: `Bearer ${auth}`, ...(lang ? { "accept-language": lang } : {}) } });
  if (res.status === 401 && attempt === 0) {
    token = null;
    return api(pathOrUrl, { lang }, attempt + 1);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 1;
    if (wait <= 5 && attempt < 2) {
      await sleep(wait * 1000);
      return api(pathOrUrl, { lang }, attempt + 1);
    }
    const until = Date.now() + wait * 1000;
    if (until > blockedUntil()) {
      state.set("blockedUntil", until);
      log(`spotify: rate limited; not calling the API for ${wait}s (until ${new Date(until).toISOString()})`);
    }
    throw new HttpError(503, "spotify", `Spotify API rate limited until ${new Date(until).toISOString()}`, 429);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message ?? "";
    } catch {}
    throw new HttpError(res.status === 404 ? 404 : 502, "spotify", `Spotify API ${new URL(url).pathname}: HTTP ${res.status} ${detail}`.trim(), res.status);
  }
  return res.json();
}

function trackFromApi(t, albumName = null) {
  if (!t?.id || (t.type && t.type !== "track")) return null; // skip episodes and local files
  return {
    service: "spotify",
    type: "track",
    id: t.id,
    url: openUrl("track", t.id),
    title: t.name,
    artists: (t.artists ?? []).map((a) => a.name),
    album: t.album?.name ?? albumName,
    durationMs: t.duration_ms ?? null,
    isrc: t.external_ids?.isrc ?? null,
  };
}

/** One track from the API (optionally with names in `lang`), cached on disk. Throws if unavailable. */
async function fetchTrack(id, lang = null) {
  const key = lang ? `${id}|${lang}` : id;
  if (trackStore.has(key)) {
    const cached = trackStore.get(key);
    if (!cached) throw new HttpError(404, "spotify", `Spotify track ${id} not found`, 404);
    return structuredClone(cached);
  }
  // Concurrent requests for the same track share one API request.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = api(`/tracks/${id}`, { lang })
      .then((raw) => {
        const track = trackFromApi(raw);
        trackStore.set(key, track);
        return track;
      })
      .catch((err) => {
        if (err.upstreamStatus === 404) trackStore.set(key, null);
        throw err;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return structuredClone(await pending);
}

const inFlight = new Map(); // key -> Promise<track>

/** Fallback for albums when the embed page fails: 1 request per 50 tracks. */
async function albumFromApi(id) {
  const a = await api(`/albums/${id}`);
  const paging = a.tracks ?? a.items;
  const tracks = (paging?.items ?? []).map((t) => trackFromApi(t, a.name)).filter(Boolean);
  for (let next = paging?.next; next; ) {
    const page = await api(next);
    tracks.push(...(page.items ?? []).map((t) => trackFromApi(t, a.name)).filter(Boolean));
    next = page.next;
  }
  return {
    source: {
      service: "spotify",
      type: "album",
      id,
      url: openUrl("album", id),
      title: a.name,
      artists: (a.artists ?? []).map((x) => x.name),
      trackCount: tracks.length,
      totalTracks: paging?.total ?? a.total_tracks ?? tracks.length,
      truncated: false,
      metadataSource: "api",
      trackListSource: "api",
    },
    tracks,
  };
}

// ---------------------------------------------------------------- Public pages (no API budget)

async function fetchPage(url) {
  return fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
}

async function fetchEmbedEntity(type, id) {
  const res = await fetchPage(`https://open.spotify.com/embed/${type}/${id}`);
  if (res.status === 404) throw new HttpError(404, "spotify", `Spotify ${type} ${id} not found`, 404);
  if (!res.ok) throw new HttpError(502, "spotify", `Spotify embed page returned HTTP ${res.status}`, res.status);
  const m = (await res.text()).match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new HttpError(502, "spotify", "Spotify embed page has no metadata (page layout may have changed)");
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new HttpError(404, "spotify", `Spotify ${type} ${id} not found`);
  return entity;
}

/** The real track count from the item's public page (<meta name="music:song_count">), or null. */
async function pageTrackCount(type, id) {
  try {
    const html = await (await fetchPage(openUrl(type, id))).text();
    const m = html.match(/<meta name="music:song_count" content="(\d+)"/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const splitArtists = (s) => (s ? s.split(/,\s*/).map((a) => a.trim()).filter(Boolean) : []);

function trackFromEmbed(t) {
  const id = t.uri?.split(":").pop() ?? t.id;
  return {
    service: "spotify",
    type: "track",
    id,
    url: openUrl("track", id),
    title: t.title ?? t.name,
    artists: t.artists ? t.artists.map((a) => a.name) : splitArtists(t.subtitle),
    album: null,
    durationMs: t.duration ?? null,
    isrc: null,
  };
}

async function fromEmbed(type, id) {
  const e = await fetchEmbedEntity(type, id);
  if (type === "track") {
    const track = trackFromEmbed(e);
    return { source: { ...track, metadataSource: "embed" }, tracks: [track] };
  }
  const tracks = (e.trackList ?? [])
    .filter((t) => (t.entityType ?? "track") === "track" && t.uri?.startsWith("spotify:track:"))
    .map(trackFromEmbed);
  // The embed page lists at most 100 tracks; only then is the real count worth looking up.
  const total = tracks.length >= EMBED_TRACK_LIMIT ? await pageTrackCount(type, id) : tracks.length;
  return {
    source: {
      service: "spotify",
      type,
      id,
      url: openUrl(type, id),
      title: e.name ?? e.title,
      ...(type === "album" ? { artists: splitArtists(e.subtitle) } : { owner: e.subtitle ?? null }),
      trackCount: tracks.length,
      totalTracks: total,
      truncated: total == null ? null : tracks.length < total,
      metadataSource: "embed",
      trackListSource: "embed",
    },
    tracks,
  };
}

// ---------------------------------------------------------------- Public

/**
 * The full API record for a track (ISRC, canonical names), from cache or 1 API request.
 * Null when the API isn't available or fails: it's an accuracy boost, not a requirement.
 */
export async function lookupTrack(trackId, lang = null) {
  if (!trackId) return null;
  const key = lang ? `${trackId}|${lang}` : trackId;
  if (!trackStore.has(key) && unavailableReason()) return null;
  try {
    return await fetchTrack(trackId, lang);
  } catch (err) {
    if (![404, 429].includes(err.upstreamStatus)) log(`spotify: track lookup (${lang ?? "default"}) failed for ${trackId}: ${err.message}`);
    return null;
  }
}

/** The track with names in another language, e.g. "ja" gives 「はるまきごはん」 for "Harumakigohan". */
export const lookupLocalizedTrack = (trackId, lang) => lookupTrack(trackId, lang);

/**
 * Track:          { source, tracks: [source] }   — API record if available, else embed page.
 * Album/playlist: { source, tracks: [track, ...] } — embed page (no API requests).
 */
export async function getSpotifyItem(type, id) {
  if (type === "track") {
    if (trackStore.has(id) || !unavailableReason()) {
      try {
        const track = await fetchTrack(id);
        return { source: { ...track, metadataSource: "api" }, tracks: [track] };
      } catch (err) {
        if (err.upstreamStatus === 404) throw err;
        if (err.upstreamStatus !== 429) log(`spotify: API failed for track/${id} (${err.message}); trying embed page`);
      }
    }
    return fromEmbed("track", id);
  }

  try {
    return await fromEmbed(type, id);
  } catch (err) {
    if (type !== "album" || err.status === 404 || unavailableReason()) throw err;
    log(`spotify: embed page failed for album/${id} (${err.message}); trying the API`);
    return albumFromApi(id);
  }
}
