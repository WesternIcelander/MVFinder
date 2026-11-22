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
  tidal: {
    // Optional (developer.tidal.com). Without them, TIDAL data comes from its public web pages.
    clientId: env.TIDAL_CLIENT_ID ?? "",
    clientSecret: env.TIDAL_CLIENT_SECRET ?? "",
    // The catalog the API answers from; availability differs by country.
    countryCode: (env.TIDAL_COUNTRY_CODE || "US").toUpperCase(),
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
  isrc: {
    // Where /isrc looks when Spotify doesn't have the ISRC or its API can't be used, in order.
    fallbacks: (env.ISRC_FALLBACKS ?? "deezer,musicbrainz").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // MusicBrainz asks clients to identify themselves: "AppName/version ( contact-url-or-email )".
    musicbrainzUserAgent: env.MUSICBRAINZ_USER_AGENT || "isrc-lookup/1.0",
    musicbrainzRetryDelaysMs: env.ISRC_TEST_NO_DELAYS ? [0, 0] : null, // tests only
  },
  cache: {
    ttlHours: num(env.CACHE_TTL_HOURS, 24),
    maxEntries: num(env.CACHE_MAX_ENTRIES, 20000),
  },
};
