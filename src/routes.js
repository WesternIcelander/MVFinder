// Request paths. A Spotify or TIDAL link works as the path once its "https://" is dropped:
//   https://open.spotify.com/track/6khnYqsyOTFq1SgpCi3Ucx  ->  GET /open.spotify.com/track/6khnYqsyOTFq1SgpCi3Ucx
//   https://tidal.com/browse/track/251380837              ->  GET /tidal.com/browse/track/251380837
// Leniently: a left-in "http(s)://", share parameters like "?si=…" (ignored like any unknown
// parameter), and each service's URL variants (see below) all work.

const SCHEME = String.raw`(?:https?:\/{1,2})?`;
const ROUTES = [
  // open.spotify.com/{type}/{id}, with an optional "intl-xx/" language segment or "embed/"
  {
    service: "spotify",
    re: new RegExp(String.raw`^\/${SCHEME}open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{10,40})\/?$`, "i"),
  },
  // (www.|listen.)tidal.com/(browse/){track|album|playlist}/{id}, album links with a name slug
  // (album/renaissance/251380836), and a track within an album (album/{id}/track/{id}).
  // Share links can end in "/u".
  {
    service: "tidal",
    re: new RegExp(String.raw`^\/${SCHEME}(?:www\.|listen\.)?tidal\.com\/(?:browse\/)?(?:album\/\d+\/)?(track|album|playlist)\/(?:[^/]+\/)?(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/u)?\/?$`, "i"),
  },
];
const ISRC_ROUTE = /^\/isrc\/([^/]+)\/?$/;

export const NOT_FOUND_MESSAGE =
  "Not found. Use a Spotify or TIDAL link without https:// (GET /open.spotify.com/track/{id}, /tidal.com/track/{id}; also albums and playlists), /isrc/{isrc}, or /search?query=…";

/** The request URL, with leading slashes collapsed so "//open.spotify.com/…" isn't read as a host. */
export const requestUrl = (rawUrl) => new URL(String(rawUrl).replace(/^\/+/, "/"), "http://localhost");

/** { route: "health" | "search" } | { route: "item", service, type, id } | { route: "isrc", isrc } | null */
export function parseRoute(pathname) {
  if (pathname === "/health") return { route: "health" };
  if (pathname === "/search" || pathname === "/search/") return { route: "search" };
  for (const { service, re } of ROUTES) {
    const m = pathname.match(re);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const id = service === "tidal" ? m[2].toLowerCase() : m[2];
    // TIDAL tracks and albums have numeric IDs, playlists UUIDs.
    if (service === "tidal" && (type === "playlist") === /^\d+$/.test(id)) return null;
    return { route: "item", service, type, id };
  }
  const isrc = pathname.match(ISRC_ROUTE);
  if (isrc) {
    let raw = isrc[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    return { route: "isrc", isrc: raw };
  }
  return null;
}
