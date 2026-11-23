// Turns one track (from Spotify, TIDAL, or an ISRC's reference record) into ranked YouTube matches, with a cache.

import { scoreMatch, scriptLangs, searchQuery } from "./match.js";
import { hasVideoMarker } from "./youtube.js";
import { Store, openDatabase } from "./store.js";
import { thumbnailsFor } from "./thumbnails.js";
import { HttpError } from "./util.js";

// With no music video, another official visual upload can stand in, if it's clearly the same song.
const FALLBACK_VIDEO_KINDS = ["official_video", "lyric_video", "visualizer"];
const FALLBACK_VIDEO_MIN = 0.75;
// ISRC search attempts, each on a different YouTube session (results vary by session).
const ISRC_SESSIONS = 5;
// Languages we can ask Spotify for when YouTube shows names in their script.
const LOCALIZE_LANGS = ["ja", "ko", "zh"];
const MISS_TTL_MS = 3600_000;
// Part of the cache key: bump when the shape of cached matches changes (2: thumbnails).
const CACHE_VERSION = 2;

const bool = (v) => v === "" || v === "1" || v === "true";

/** Parse ?type=&all=&minConfidence=&explain=&single= */
export function parseOptions(params) {
  const type = params.get("type") ?? "all";
  if (!["all", "song", "video"].includes(type)) throw new HttpError(400, "request", `type must be all, song or video (got "${type}")`);
  const minConfidence = params.has("minConfidence") ? Number(params.get("minConfidence")) : 0.7;
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new HttpError(400, "request", "minConfidence must be a number between 0 and 1");
  return {
    type,
    all: params.has("all") && bool(params.get("all")),
    minConfidence,
    explain: params.has("explain") && bool(params.get("explain")),
    // Only tracks: refuse album and playlist links (e.g. ones pasted by an end user).
    single: params.has("single") && bool(params.get("single")),
  };
}

async function formatMatch({ yt, score, matchedBy }, explain, hasMaxresThumbnail) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;
  const youtubeMusicUrl = `https://music.youtube.com/watch?v=${yt.videoId}`;
  return {
    type: yt.kind,
    title: yt.title,
    artists: yt.artists,
    ...(yt.album ? { album: yt.album } : {}),
    durationMs: yt.durationMs,
    videoId: yt.videoId,
    url: yt.kind === "song" ? youtubeMusicUrl : youtubeUrl,
    youtubeUrl,
    youtubeMusicUrl,
    thumbnails: await thumbnailsFor(yt, hasMaxresThumbnail),
    confidence: score.confidence,
    matchedBy,
    ...(explain ? { scoring: { ...score.breakdown, youtubeVideoType: yt.videoType } } : {}),
  };
}

/** Pick results for one track from scored candidates (sorted by confidence, best first). */
export function pick(scored, opts) {
  if (opts.all) {
    return scored.filter((s) => opts.type === "all" || (opts.type === "song") === (s.yt.kind === "song"));
  }
  const picked = [];
  const song = scored.find((s) => s.yt.kind === "song");
  // Among music videos, ones titled "Official Video" beat untitled cuts of similar score.
  const rank = (s) => s.score.confidence + (hasVideoMarker(s.yt.title) ? 0.1 : 0);
  const video =
    scored.filter((s) => s.yt.kind === "music_video").sort((a, b) => rank(b) - rank(a))[0] ??
    scored.find((s) => FALLBACK_VIDEO_KINDS.includes(s.yt.kind) && s.score.confidence >= FALLBACK_VIDEO_MIN);
  if (song && opts.type !== "video") picked.push(song);
  if (video && opts.type !== "song") picked.push(video);
  return picked;
}

export function createResolver({ youtube, lookupTrack, lookupLocalizedTrack = async () => null, degraded = () => false, ttlHours, store = null, hasMaxresThumbnail = async () => false }) {
  // key -> matches. A Store (store.js): entries expire, and it drops the least recently used.
  const cache = store ?? new Store(openDatabase(":memory:"), "matches");
  const ttl = ttlHours * 3600_000;

  // Album and embed-page track lists lack the ISRC, and the embed page can name things
  // differently from the API ("Police Piccadilly" vs "ポリスピカデリー"). Fill in the API record
  // (it's also what the response shows) and keep the differing names as aliases.
  async function enrich(track, aliases) {
    if (track.isrc) return;
    const full = await lookupTrack(track); // the full record from the track's own service
    if (!full) return;
    if (full.title !== track.title) aliases.titles.push(track.title);
    if (full.artists[0] && full.artists[0] !== track.artists[0]) aliases.artists.push(track.artists[0]);
    Object.assign(track, { title: full.title, artists: full.artists, album: track.album ?? full.album, isrc: full.isrc });
  }

  // Searching YouTube Music for an ISRC usually puts the exact recording first (followed by
  // noise), but in some sessions it returns an unrelated track instead. Accept the top hit only
  // if the duration agrees plus the artist or title.
  function verifyIsrcTop(track, top, aliases) {
    if (top?.kind !== "song") return null;
    const { breakdown } = scoreMatch(track, top, aliases);
    if (breakdown.duration < 0.8 || (breakdown.artist < 0.7 && breakdown.title < 0.5)) return null;
    return { yt: top, score: { confidence: 1, breakdown }, matchedBy: "isrc" };
  }

  // Try the ISRC on several sessions; every top hit is collected in `tops` for re-checking later.
  // A session whose search fails is skipped (the text searches still run), but the result is
  // then marked incomplete so it isn't cached for long.
  async function isrcMatch(track, aliases, tops, flags) {
    if (!track.isrc) return null;
    for (let session = 0; session < ISRC_SESSIONS; session++) {
      let top;
      try {
        [top] = await youtube.search(track.isrc, "songs", { session });
      } catch {
        flags.incomplete = true;
        continue;
      }
      if (top) tops.push(top);
      const hit = verifyIsrcTop(track, top, aliases);
      if (hit) return hit;
    }
    return null;
  }

  // When YouTube shows names in a script Spotify's names aren't in (e.g. 「はるまきごはん」 for
  // "Harumakigohan"), ask Spotify for the track in that language: it often has the native artist
  // name (and sometimes title). Returns true if that produced a new alias.
  async function localize(track, aliases, candidates) {
    if (track.service && track.service !== "spotify") return false; // no Spotify ID to look up
    const own = new Set([track.title, ...track.artists].flatMap(scriptLangs));
    const seen = new Set(candidates.flatMap((c) => [c.title, ...c.artists]).flatMap(scriptLangs));
    const langs = LOCALIZE_LANGS.filter((l) => seen.has(l) && !own.has(l)).slice(0, 2);
    let added = false;
    for (const lang of langs) {
      const loc = await lookupLocalizedTrack(track.id, lang);
      if (!loc) continue;
      const artist = loc.artists[0];
      if (artist && artist !== track.artists[0] && !aliases.artists.includes(artist)) {
        aliases.artists.push(artist);
        added = true;
      }
      if (loc.title && loc.title !== track.title && !aliases.titles.includes(loc.title)) {
        aliases.titles.push(loc.title);
        added = true;
      }
      if (added) break; // e.g. kanji-only text maps to ja and zh; one that works is enough
    }
    return added;
  }

  // The verified song's YouTube title and artist (often native-script or a different
  // romanisation) help find and match the videos.
  function addHitAliases(track, hit, aliases) {
    if (hit.yt.title !== track.title && !aliases.titles.includes(hit.yt.title)) aliases.titles.push(hit.yt.title);
    const ytArtist = hit.yt.artists[0];
    if (ytArtist && !track.artists.includes(ytArtist) && !aliases.artists.includes(ytArtist)) aliases.artists.push(ytArtist);
  }

  async function compute(track, opts, aliases, flags) {
    const isrcTops = [];
    let isrcHit = await isrcMatch(track, aliases, isrcTops, flags);
    if (isrcHit) addHitAliases(track, isrcHit, aliases);

    const searches = [];
    if (opts.type !== "video" && (!isrcHit || opts.all)) searches.push(["songs", searchQuery(track)]);
    if (opts.type !== "song") searches.push(["videos", searchQuery(track, isrcHit?.yt.title ?? track.title)]);
    const results = (await Promise.all(searches.map(([filter, q]) => youtube.search(q, filter)))).flat();

    // No verified ISRC hit, but an ISRC top hit of the right length has names in another script:
    // get Spotify's native names, re-check the ISRC hits we have, and search videos by the native
    // title. (Only ISRC hits count: random foreign-script search results would trigger needless
    // Spotify calls for ordinary tracks.)
    const plausible = isrcTops.filter((top) => top.kind === "song" && scoreMatch(track, top).breakdown.duration >= 0.8);
    if (!isrcHit && plausible.length && (await localize(track, aliases, plausible))) {
      isrcHit = isrcTops.map((top) => verifyIsrcTop(track, top, aliases)).find(Boolean) ?? null;
      if (isrcHit) {
        addHitAliases(track, isrcHit, aliases);
        if (opts.type !== "song" && isrcHit.yt.title !== track.title) {
          results.push(...(await youtube.search(searchQuery(track, isrcHit.yt.title), "videos")));
        }
      }
    }

    const scored = isrcHit ? [isrcHit] : [];
    const seen = new Set(scored.map((s) => s.yt.videoId));
    for (const yt of results) {
      if (seen.has(yt.videoId) || yt.kind === "other") continue;
      seen.add(yt.videoId);
      const score = scoreMatch(track, yt, aliases);
      if (score.confidence >= opts.minConfidence) scored.push({ yt, score, matchedBy: "search" });
    }
    scored.sort((a, b) => b.score.confidence - a.score.confidence); // stable: the ISRC hit wins ties
    return Promise.all(pick(scored, opts).map((s) => formatMatch(s, opts.explain, hasMaxresThumbnail)));
  }

  async function matchTrack(track, opts) {
    // Before the cache check, so the response shows the API record (ISRC etc.) either way.
    const aliases = { titles: [], artists: [] };
    await enrich(track, aliases);
    // IDs from other services (TIDAL, or an ISRC's Deezer or MusicBrainz record) get a prefix.
    const id = track.service && track.service !== "spotify" ? `${track.service}:${track.id}` : track.id;
    const key = [CACHE_VERSION, id ?? `${track.artists.join(",")}|${track.title}`, opts.type, opts.all, opts.minConfidence, opts.explain].join("|");
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // Missing ISRC only because the Spotify API was unavailable: recompute sooner.
    const lackedIsrc = !track.isrc && degraded();
    const flags = { incomplete: false };
    const value = await compute(track, opts, aliases, flags);
    if (ttl > 0) {
      // YouTube results vary between sessions, so don't hold on to a miss for long.
      // Likewise for results computed without the ISRC, or with some ISRC searches failed.
      const life = value.length && !lackedIsrc && !flags.incomplete ? ttl : Math.min(ttl, MISS_TTL_MS);
      cache.set(key, value, { ttlMs: life });
    }
    return value;
  }

  return { matchTrack, cacheSize: () => cache.size };
}
