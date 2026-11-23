import http from "node:http";
import { config } from "./config.js";
import { createResolver, parseOptions } from "./resolve.js";
import { lookupIsrcSource, normalizeIsrc } from "./isrc.js";
import { getSpotifyItem, lookupLocalizedTrack, lookupTrack, spotifyDegraded, spotifyStatus } from "./spotify.js";
import path from "node:path";
import { cacheDb, closeCacheDb, importLegacyJson, openStore, purgeExpired } from "./store.js";
import { NOT_FOUND_MESSAGE, parseRoute, requestUrl } from "./routes.js";
import { getTidalItem, lookupTidalTrack, tidalStatus } from "./tidal.js";
import { hasMaxresThumbnail } from "./thumbnails.js";
import { createSearch, parseSearchParams } from "./search.js";
import { HttpError, log } from "./util.js";
import { YouTubeManager } from "./youtube.js";

const youtube = new YouTubeManager(config.youtube);
// Match results persist across restarts, so a restart costs no Spotify or YouTube requests.
const matchStore = openStore("matches", { maxEntries: config.cache.maxEntries });
importLegacyJson(path.join(config.dataDir, "matches.json"), (key, { expires, value }) => {
  if (expires > Date.now()) matchStore.set(key, value, { ttlMs: expires - Date.now() });
});
purgeExpired(cacheDb());
setInterval(() => purgeExpired(cacheDb()), 3600_000).unref();
// A list's track without an ISRC gets its full record from its own service.
const lookupFull = (track) => (track.service === "tidal" ? lookupTidalTrack(track.id) : lookupTrack(track.id));
const resolver = createResolver({ youtube, lookupTrack: lookupFull, lookupLocalizedTrack, degraded: spotifyDegraded, store: matchStore, hasMaxresThumbnail, ...config.cache });
const search = createSearch({ youtube, hasMaxresThumbnail, store: openStore("searches", { maxEntries: 5000 }) });

async function handle(url) {
  const route = parseRoute(url.pathname);
  if (!route) throw new HttpError(404, "request", NOT_FOUND_MESSAGE);

  if (route.route === "health") {
    const yt = youtube.health();
    return [yt.ok ? 200 : 503, { status: yt.ok ? "ok" : "degraded", youtube: yt, spotify: spotifyStatus(), tidal: tidalStatus(), cacheEntries: resolver.cacheSize() }];
  }

  if (route.route === "search") {
    const opts = parseSearchParams(url.searchParams);
    return [200, { query: opts.query, matches: await search.search(opts) }];
  }

  if (route.route === "isrc") {
    const isrc = normalizeIsrc(route.isrc);
    const opts = parseOptions(url.searchParams);
    // Spotify, Deezer or MusicBrainz supplies the title, artists and duration that YouTube results
    // are checked against. (YouTube's own ISRC search can't stand in: for ISRCs it doesn't know,
    // it returns unrelated songs.)
    const source = await lookupIsrcSource(isrc);
    const { metadataSource, ...track } = source;
    return [200, { source, matches: await resolver.matchTrack(track, opts) }];
  }

  const { service, type, id } = route;
  const opts = parseOptions(url.searchParams);
  if (opts.single && type !== "track") {
    // Checked before anything is fetched, so a refused link costs no requests.
    throw new HttpError(422, "request", "This link is not for a single item");
  }
  const item = await (service === "tidal" ? getTidalItem : getSpotifyItem)(type, id);

  if (type === "track") {
    return [200, { source: item.source, matches: await resolver.matchTrack(item.source, opts) }];
  }

  const tracks = await Promise.all(
    item.tracks.map(async (track) => {
      try {
        return { source: track, matches: await resolver.matchTrack(track, opts) };
      } catch (err) {
        return { source: track, matches: [], error: err.message };
      }
    }),
  );
  const failed = tracks.filter((t) => t.error);
  if (tracks.length && failed.length === tracks.length) throw new HttpError(502, "youtube", failed[0].error);
  return [200, { source: item.source, tracks }];
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = requestUrl(req.url);
  let status;
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    status = 405;
    body = { error: { status, source: "request", message: "Only GET is supported" } };
  } else {
    try {
      [status, body] = await handle(url);
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      body = { error: { status, source: err.source ?? "server", message: err.message } };
      if (status >= 500) log(`error: ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
    }
  }
  const pretty = url.searchParams.has("pretty") && url.searchParams.get("pretty") !== "false";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-youtube-client": youtube.versionLabel(),
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body, null, pretty ? 2 : 0));
  if (url.pathname !== "/health") log(`${req.method} ${url.pathname}${url.search} ${status} ${Date.now() - started}ms`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    const exit = () => {
      closeCacheDb(); // checkpoints the WAL; SQLite stays consistent even if this is skipped
      process.exit(0);
    };
    server.close(exit);
    setTimeout(exit, 5000).unref();
  });
}

if (spotifyStatus().mode !== "api") log("spotify: SPOTIFY_CLIENT_ID/SECRET not set; using the public embed page only");
await youtube.start();
server.listen(config.port, () => log(`listening on :${config.port}`));
