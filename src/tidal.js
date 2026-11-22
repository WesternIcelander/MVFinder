// TIDAL items, from its official API when TIDAL_CLIENT_ID/SECRET are set, else (or if the API
// fails) from its public web pages, which need no account or key.
//
// API (openapi.tidal.com/v2, client-credentials token, no TIDAL login):
// - A track, or an album or playlist with its first 20 items (ISRCs and artists included) in one
//   request; further items 20 per request.
//
// Pages:
// - A track's page (tidal.com/track/{id}) has schema.org JSON-LD with the title, artists, album,
//   duration and ISRC. Fetched once per track and cached on disk.
// - Album and playlist track lists come from the embed player (embed.tidal.com/{albums|playlists}/
//   {id}): track IDs, titles, artists and durations, but no ISRCs. Those are filled in per track
//   while matching (see lookupTidalTrack), from the API if it works, else the track's page.
// - The album or playlist page itself gives its name, artists, and a playlist's track count.

import { config } from "./config.js";
import { openStore } from "./store.js";
import { HttpError, Semaphore, log, sleep } from "./util.js";

const UA = "Mozilla/5.0";
const DAY_MS = 24 * 3600_000;
const NOT_FOUND_TTL_MS = DAY_MS;
const pageSlots = new Semaphore(4); // concurrent page fetches

let trackStore = null; // opened on first use
const tracks = () => (trackStore ??= openStore("tidal-tracks", { maxEntries: 200_000 }));
const inFlight = new Map();

export const tidalUrl = (type, id) => `https://tidal.com/${type}/${id}`;

async function fetchPage(url, what) {
  await pageSlots.acquire();
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
    if (res.status === 404) throw new HttpError(404, "tidal", `TIDAL ${what} not found`, 404);
    if (!res.ok) throw new HttpError(502, "tidal", `TIDAL page for ${what} returned HTTP ${res.status}`, res.status);
    return await res.text();
  } finally {
    pageSlots.release();
  }
}

/** The schema.org JSON-LD objects in a page. */
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {}
  }
  return out;
}

const ldOf = (html, type) => jsonLd(html).find((j) => j["@type"] === type) ?? null;

/** "PT3M28S" -> 208000 */
export function isoDurationMs(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s ?? "");
  return m ? Math.round(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000) : null;
}

/** "3:28" or "1:02:03" -> ms */
function clockMs(s) {
  const parts = String(s ?? "").trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

const names = (by) => (Array.isArray(by) ? by : by ? [by] : []).map((a) => a?.name).filter(Boolean);

/** A track from its page's JSON-LD. */
export function trackFromPage(id, html) {
  const r = ldOf(html, "MusicRecording");
  if (!r?.name) throw new HttpError(502, "tidal", "TIDAL track page has no track data (page layout may have changed)");
  return {
    service: "tidal",
    type: "track",
    id: String(id),
    url: tidalUrl("track", id),
    title: r.name,
    artists: names(r.byArtist),
    album: r.inAlbum?.name ?? null,
    durationMs: isoDurationMs(r.duration),
    isrc: r.isrcCode ? String(r.isrcCode).toUpperCase() : null,
  };
}

// ---------------------------------------------------------------- API

const API = "https://openapi.tidal.com/v2";
const MAX_LIST_PAGES = 500; // 20 items each; TIDAL playlists hold at most 10,000
const apiSlots = new Semaphore(4);

export const tidalMode = () => (config.tidal.clientId && config.tidal.clientSecret ? "api" : "pages");
export const tidalStatus = () => ({ mode: tidalMode(), countryCode: config.tidal.countryCode });

let token = null; // { value, expiresAt }
let tokenRequest = null; // shared by concurrent callers

function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return Promise.resolve(token.value);
  tokenRequest ??= requestToken().finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

async function requestToken() {
  const { clientId, clientSecret } = config.tidal;
  const res = await fetch("https://auth.tidal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new HttpError(502, "tidal", `TIDAL token request failed (HTTP ${res.status}); check TIDAL_CLIENT_ID/SECRET`, res.status);
  const body = await res.json();
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

/** GET a path under /v2 (with its query), as parsed JSON:API. */
async function api(path, attempt = 0) {
  const auth = await getToken();
  let res;
  await apiSlots.acquire();
  try {
    res = await fetch(API + path, { headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.api+json" } });
  } finally {
    apiSlots.release();
  }
  if (res.status === 401 && attempt === 0) {
    token = null;
    return api(path, attempt + 1);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 1;
    if (wait <= 5 && attempt < 2) {
      await sleep(wait * 1000);
      return api(path, attempt + 1);
    }
    throw new HttpError(503, "tidal", `TIDAL API rate limited (retry after ${wait}s)`, 429);
  }
  if (res.status === 404) throw new HttpError(404, "tidal", `TIDAL API ${path.split("?")[0]}: not found`, 404);
  if (!res.ok) throw new HttpError(502, "tidal", `TIDAL API ${path.split("?")[0]}: HTTP ${res.status}`, res.status);
  return res.json();
}

const withQuery = (path, params) => {
  const u = new URL(path, "http://x");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
};

/** JSON:API "included" resources by "type:id". */
const indexIncluded = (byKey, included) => {
  for (const r of included ?? []) byKey.set(`${r.type}:${r.id}`, r);
  return byKey;
};
const related = (res, rel, byKey) => (res.relationships?.[rel]?.data ?? []).map((ref) => byKey.get(`${ref.type}:${ref.id}`)).filter(Boolean);

/** A track resource -> our track shape. Artists and album come from `byKey` (the included resources). */
export function trackFromApi(res, byKey, albumName = null) {
  const a = res.attributes ?? {};
  if (!a.title) return null;
  return {
    service: "tidal",
    type: "track",
    id: String(res.id),
    url: tidalUrl("track", res.id),
    // TIDAL shows a version ("Remix", "Live") after the title.
    title: a.version && !a.title.toLowerCase().includes(a.version.toLowerCase()) ? `${a.title} (${a.version})` : a.title,
    artists: related(res, "artists", byKey).map((r) => r.attributes?.name).filter(Boolean),
    album: albumName ?? related(res, "albums", byKey)[0]?.attributes?.title ?? null,
    durationMs: isoDurationMs(a.duration),
    isrc: a.isrc ? String(a.isrc).toUpperCase() : null,
  };
}

async function trackViaApi(id) {
  const doc = await api(`/tracks/${id}?countryCode=${config.tidal.countryCode}&include=artists,albums`);
  const track = trackFromApi(doc.data, indexIncluded(new Map(), doc.included));
  if (!track) throw new HttpError(502, "tidal", `TIDAL API returned no data for track ${id}`);
  return track;
}

/** An album or playlist with all its tracks: 1 request, plus 1 per further 20 items. */
async function listViaApi(type, id) {
  const cc = config.tidal.countryCode;
  const itemsInclude = type === "album" ? "items,items.artists" : "items,items.artists,items.albums";
  const doc = await api(`/${type}s/${id}?countryCode=${cc}&include=${type === "album" ? "artists" : "owners"},${itemsInclude}`);
  const byKey = indexIncluded(new Map(), doc.included);
  const refs = [...(doc.data.relationships?.items?.data ?? [])];
  let next = doc.data.relationships?.items?.links?.next;
  for (let pages = 1; next && pages < MAX_LIST_PAGES; pages++) {
    const page = await api(withQuery(next, { include: itemsInclude }));
    refs.push(...(page.data ?? []));
    indexIncluded(byKey, page.included);
    next = page.links?.next;
  }
  const a = doc.data.attributes ?? {};
  const albumName = type === "album" ? a.title : null;
  // Playlists can hold videos; tracks unavailable in the catalog's country come without data.
  const list = refs
    .filter((ref) => ref.type === "tracks")
    .map((ref) => byKey.get(`tracks:${ref.id}`))
    .filter(Boolean)
    .map((res) => trackFromApi(res, byKey, albumName))
    .filter(Boolean);
  const total = type === "album" ? a.numberOfItems : (a.numberOfTrackItems ?? a.numberOfItems);
  const owner = related(doc.data, "owners", byKey)[0]?.attributes;
  return {
    source: {
      service: "tidal",
      type,
      id,
      url: tidalUrl(type, id),
      title: a.title ?? a.name ?? null,
      ...(type === "album"
        ? { artists: related(doc.data, "artists", byKey).map((r) => r.attributes?.name).filter(Boolean) }
        : { owner: owner?.name ?? owner?.username ?? (a.playlistType === "EDITORIAL" ? "TIDAL" : null) }),
      trackCount: list.length,
      totalTracks: Number.isInteger(total) ? total : null,
      truncated: Boolean(next), // stopped at MAX_LIST_PAGES
      metadataSource: "api",
      trackListSource: "api",
    },
    tracks: list,
  };
}

// ---------------------------------------------------------------- Tracks

/** A track from the API (falling back to its page) or its page. */
async function trackFromSource(id) {
  if (tidalMode() === "api") {
    try {
      return { ...(await trackViaApi(id)), metadataSource: "api" };
    } catch (err) {
      if (err.upstreamStatus !== 404) log(`tidal: API failed for track ${id} (${err.message}); reading its page`);
    }
  }
  return { ...trackFromPage(id, await fetchPage(tidalUrl("track", id), `track ${id}`)), metadataSource: "page" };
}

/** One track, cached on disk ("not found" for a day). */
async function fetchTrack(id) {
  const cached = tracks().get(id);
  if (cached !== undefined) {
    if (cached.notFound) throw new HttpError(404, "tidal", `TIDAL track ${id} not found`, 404);
    return cached;
  }
  let pending = inFlight.get(id);
  if (!pending) {
    pending = trackFromSource(id)
      .then((track) => {
        tracks().set(id, track);
        return track;
      })
      .catch((err) => {
        if (err.upstreamStatus === 404) tracks().set(id, { notFound: true }, { ttlMs: NOT_FOUND_TTL_MS });
        throw err;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  return structuredClone(await pending);
}

/** The full record (with ISRC) for a track from a list, or null if its page can't be read. */
export async function lookupTidalTrack(id) {
  try {
    return await fetchTrack(id);
  } catch (err) {
    if (err.upstreamStatus !== 404) log(`tidal: track page failed for ${id}: ${err.message}`);
    return null;
  }
}

/**
 * Tracks from an embed player page. Each row is
 *   <list-item … product-id="251380838" product-type="track"> … <time slot="duration">3:30</time>
 * and window.tidalMediaSessionMetadata maps track IDs to { title, artist, album }.
 */
export function tracksFromEmbed(html) {
  const meta = html.match(/window\.tidalMediaSessionMetadata\s*=\s*(\{.*?\});\s*$/m);
  let byId = {};
  try {
    byId = meta ? JSON.parse(meta[1]) : {};
  } catch {}
  const out = [];
  for (const m of html.matchAll(/<list-item\b([^>]*)>([\s\S]*?)<\/list-item>/g)) {
    const id = /product-id="(\d+)"/.exec(m[1])?.[1];
    const type = /product-type="([^"]+)"/.exec(m[1])?.[1];
    if (!id || type !== "track") continue; // playlists can hold videos
    const info = byId[id] ?? {};
    const title = info.title ?? decodeEntities(/<span slot="title">([^<]*)<\/span>/.exec(m[2])?.[1] ?? "");
    if (!title) continue;
    out.push({
      service: "tidal",
      type: "track",
      id,
      url: tidalUrl("track", id),
      title,
      artists: info.artist ? info.artist.split(/,\s*/).filter(Boolean) : [], // the track page has the exact list
      album: info.album ?? null,
      durationMs: clockMs(/<time slot="duration">([^<]*)<\/time>/.exec(m[2])?.[1]),
      isrc: null,
    });
  }
  return out;
}

const decodeEntities = (s) =>
  s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (e, c) =>
    c[0] === "#"
      ? String.fromCodePoint(c[1].toLowerCase() === "x" ? parseInt(c.slice(2), 16) : Number(c.slice(1)))
      : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[c.toLowerCase()],
  );

/**
 * Track:          { source, tracks: [source] }
 * Album/playlist: { source, tracks: [track, ...] }   (tracks lack ISRCs until looked up)
 */
export async function getTidalItem(type, id) {
  if (type === "track") {
    const { metadataSource = "page", ...track } = await fetchTrack(id);
    return { source: { ...track, metadataSource }, tracks: [track] };
  }
  if (tidalMode() === "api") {
    try {
      return await listViaApi(type, id);
    } catch (err) {
      if (err.upstreamStatus !== 404) log(`tidal: API failed for ${type} ${id} (${err.message}); reading its pages`);
    }
  }
  return listFromPages(type, id);
}

async function listFromPages(type, id) {
  const [embed, page] = await Promise.all([
    fetchPage(`https://embed.tidal.com/${type}s/${id}`, `${type} ${id}`),
    fetchPage(tidalUrl(type, id), `${type} ${id}`).catch(() => null), // only for the name and count
  ]);
  const list = tracksFromEmbed(embed);
  const ld = page ? ldOf(page, type === "album" ? "MusicAlbum" : "MusicPlaylist") : null;
  if (!list.length && !ld) throw new HttpError(404, "tidal", `TIDAL ${type} ${id} not found`);
  const total = Number.isInteger(ld?.numTracks) ? ld.numTracks : null;
  return {
    source: {
      service: "tidal",
      type,
      id,
      url: tidalUrl(type, id),
      title: ld?.name ?? list[0]?.album ?? null,
      ...(type === "album" ? { artists: names(ld?.byArtist) } : { owner: ld?.author?.name ?? null }),
      trackCount: list.length,
      totalTracks: total, // album pages don't say
      truncated: total == null ? null : list.length < total,
      metadataSource: ld ? "page" : "embed",
      trackListSource: "embed",
    },
    tracks: list,
  };
}
