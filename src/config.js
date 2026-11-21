import path from "node:path";

const env = process.env;
const num = (v, fallback) => (v === undefined || v === "" ? fallback : Number(v));

// Persistent state: auto-updated youtubei.js versions and caches. Mount it as a volume.
const dataDir = path.resolve(env.DATA_DIR || "/data");

export const config = {
  port: num(env.PORT, 8080),
  dataDir,
  spotify: {
    clientId: env.SPOTIFY_CLIENT_ID ?? "",
    clientSecret: env.SPOTIFY_CLIENT_SECRET ?? "",
    // Development Mode apps get roughly 750 requests a day, possibly shared with other tools on
    // the same app; past this many in 24 h the service stops using the API (no ISRCs).
    dailyRequestBudget: num(env.SPOTIFY_DAILY_REQUEST_BUDGET, 250),
    maxRequestsPerSecond: num(env.SPOTIFY_MAX_REQUESTS_PER_SECOND, 3),
  },
  youtube: {
    // Which youtubei.js versions to run: "latest", a major like "18", or an exact "18.3.0".
    packageSpec: env.YTJS_VERSION || "latest",
    // Only adopt releases at least this old (guards against hijacked/broken releases).
    minReleaseAgeHours: num(env.YTJS_MIN_RELEASE_AGE_HOURS, 24),
    updateIntervalHours: num(env.YTJS_UPDATE_INTERVAL_HOURS, 6),
    baselineDir: path.resolve(env.YTJS_BASELINE_DIR || "/opt/ytjs"),
    dataDir,
    location: env.YT_LOCATION || "US",
    lang: "en",
    concurrency: num(env.YT_CONCURRENCY, 4),
  },
  cache: {
    ttlHours: num(env.CACHE_TTL_HOURS, 24),
    maxEntries: num(env.CACHE_MAX_ENTRIES, 20000),
  },
};
