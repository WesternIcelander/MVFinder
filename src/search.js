// GET /search?query=…: free-text search, on YouTube or (music=1) YouTube Music, cached for an hour.

import { Store, openDatabase } from "./store.js";
import { thumbnailsFor } from "./thumbnails.js";
import { HttpError } from "./util.js";

const TTL_MS = 3600_000; // results change more than matches do
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const CACHE_VERSION = 1;

const bool = (v) => v === "" || v === "1" || v === "true";

/** ?query=&music=&type=&limit= -> options. Throws 400 on bad input. */
export function parseSearchParams(params) {
  const query = (params.get("query") ?? "").replace(/\s+/g, " ").trim();
  if (!query) throw new HttpError(400, "request", "query is required, e.g. /search?query=beyonce+cuff+it");
  if (query.length > MAX_QUERY_LENGTH) throw new HttpError(400, "request", `query is limited to ${MAX_QUERY_LENGTH} characters`);
  const music = params.has("music") && bool(params.get("music"));
  const type = params.get("type") ?? "all";
  if (!["all", "song", "video"].includes(type)) throw new HttpError(400, "request", `type must be all, song or video (got "${type}")`);
  if (!music && type !== "all") throw new HttpError(400, "request", "type needs music=1 (a YouTube search returns videos only)");
  const limit = params.has("limit") ? Number(params.get("limit")) : DEFAULT_LIMIT;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) throw new HttpError(400, "request", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return { query, music, type, limit };
}

/** a, b -> a[0], b[0], a[1], b[1], … */
export function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

async function format(yt, music, hasMaxresThumbnail) {
  const youtubeUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;
  const youtubeMusicUrl = `https://music.youtube.com/watch?v=${yt.videoId}`;
  return {
    type: yt.kind === "other" ? "video" : yt.kind,
    title: yt.title,
    ...(music ? { artists: yt.artists } : { channel: yt.channel, ...(yt.artists.length ? { artists: yt.artists } : {}) }),
    ...(yt.album ? { album: yt.album } : {}),
    durationMs: yt.durationMs,
    ...(yt.live ? { live: true } : {}),
    videoId: yt.videoId,
    url: music && yt.kind === "song" ? youtubeMusicUrl : youtubeUrl,
    youtubeUrl,
    youtubeMusicUrl,
    thumbnails: await thumbnailsFor(yt, hasMaxresThumbnail),
  };
}

export function createSearch({ youtube, hasMaxresThumbnail = async () => false, store = null }) {
  const cache = store ?? new Store(openDatabase(":memory:"), "searches");

  async function run({ query, music, type, limit }) {
    let results;
    if (!music) {
      results = await youtube.search(query, "youtube");
    } else {
      const [songs, videos] = await Promise.all([
        type === "video" ? [] : youtube.search(query, "songs"),
        type === "song" ? [] : youtube.search(query, "videos"),
      ]);
      results = interleave(songs, videos);
    }
    const seen = new Set();
    const unique = results.filter((r) => !seen.has(r.videoId) && seen.add(r.videoId));
    return Promise.all(unique.slice(0, limit).map((r) => format(r, music, hasMaxresThumbnail)));
  }

  return {
    async search(opts) {
      const key = [CACHE_VERSION, opts.music ? "music" : "youtube", opts.type, opts.limit, opts.query.toLowerCase()].join("|");
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const matches = await run(opts);
      cache.set(key, matches, { ttlMs: TTL_MS });
      return matches;
    },
  };
}
