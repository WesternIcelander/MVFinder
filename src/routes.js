// Request paths. A Spotify link works as the path once its "https://" is dropped:
//   https://open.spotify.com/track/6khnYqsyOTFq1SgpCi3Ucx  ->  GET /open.spotify.com/track/6khnYqsyOTFq1SgpCi3Ucx
// Leniently: a left-in "http(s)://", an "intl-xx/" language segment, "embed/" links and share
// parameters like "?si=…" (ignored like any unknown parameter) all work.

const SPOTIFY_ROUTE =
  /^\/(?:https?:\/{1,2})?open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{10,40})\/?$/i;
const ISRC_ROUTE = /^\/isrc\/([^/]+)\/?$/;

export const NOT_FOUND_MESSAGE =
  "Not found. Use GET /open.spotify.com/{track|album|playlist}/{id} (a Spotify link without https://) or /isrc/{isrc}";

/** The request URL, with leading slashes collapsed so "//open.spotify.com/…" isn't read as a host. */
export const requestUrl = (rawUrl) => new URL(String(rawUrl).replace(/^\/+/, "/"), "http://localhost");

/** { route: "health" } | { route: "spotify", type, id } | { route: "isrc", isrc } | null */
export function parseRoute(pathname) {
  if (pathname === "/health") return { route: "health" };
  const spotify = pathname.match(SPOTIFY_ROUTE);
  if (spotify) return { route: "spotify", type: spotify[1].toLowerCase(), id: spotify[2] };
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
