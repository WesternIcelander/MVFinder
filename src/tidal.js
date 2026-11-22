// TIDAL items from its public web pages; no account or API key needed.
//
// - A track's page (tidal.com/track/{id}) has schema.org JSON-LD with the title, artists, album,
//   duration and ISRC. Fetched once per track and cached on disk.
// - Album and playlist track lists come from the embed player (embed.tidal.com/{albums|playlists}/
//   {id}): track IDs, titles, artists and durations, but no ISRCs. Those are filled in per track
//   from the track pages while matching (see lookupTidalTrack).
// - The album or playlist page itself gives its name, artists, and a playlist's track count.

import { openStore } from "./store.js";
import { HttpError, Semaphore, log } from "./util.js";

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

/** One track from its page, cached on disk ("not found" for a day). */
async function fetchTrack(id) {
  const cached = tracks().get(id);
  if (cached !== undefined) {
    if (cached.notFound) throw new HttpError(404, "tidal", `TIDAL track ${id} not found`, 404);
    return cached;
  }
  let pending = inFlight.get(id);
  if (!pending) {
    pending = fetchPage(tidalUrl("track", id), `track ${id}`)
      .then((html) => {
        const track = trackFromPage(id, html);
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
    const track = await fetchTrack(id);
    return { source: { ...track, metadataSource: "page" }, tracks: [track] };
  }
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
