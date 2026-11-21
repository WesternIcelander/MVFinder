import http from "node:http";
import { config } from "./config.js";
import { createResolver, parseOptions } from "./resolve.js";
import { getSpotifyItem, lookupLocalizedTrack, lookupTrack, spotifyDegraded, spotifyStatus } from "./spotify.js";
import path from "node:path";
import { PersistentMap, flushStores } from "./store.js";
import { HttpError, log } from "./util.js";
import { YouTubeManager } from "./youtube.js";

const ROUTE = /^\/spotify\/(track|album|playlist)\/([A-Za-z0-9]{10,40})\/?$/;

const youtube = new YouTubeManager(config.youtube);
// Match results persist across restarts, so a restart costs no Spotify or YouTube requests.
const matchStore = new PersistentMap(path.join(config.dataDir, "matches.json"), { maxEntries: config.cache.maxEntries });
const resolver = createResolver({ youtube, lookupTrack, lookupLocalizedTrack, degraded: spotifyDegraded, store: matchStore, ...config.cache });

async function handle(url) {
  if (url.pathname === "/health") {
    const yt = youtube.health();
    return [yt.ok ? 200 : 503, { status: yt.ok ? "ok" : "degraded", youtube: yt, spotify: spotifyStatus(), cacheEntries: resolver.cacheSize() }];
  }

  const m = url.pathname.match(ROUTE);
  if (!m) throw new HttpError(404, "request", "Not found. Use GET /spotify/{track|album|playlist}/{id}");
  const [, type, id] = m;
  const opts = parseOptions(url.searchParams);
  const item = await getSpotifyItem(type, id);

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
  const url = new URL(req.url, "http://localhost");
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
    flushStores();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

if (spotifyStatus().mode !== "api") log("spotify: SPOTIFY_CLIENT_ID/SECRET not set; using the public embed page only");
await youtube.start();
server.listen(config.port, () => log(`listening on :${config.port}`));
