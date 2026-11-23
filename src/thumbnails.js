// Thumbnails for a match, as a list of { url, width, height } (first is the default choice).
// width and height are left out when unknown.
//
// - YouTube Music album art (*.googleusercontent.com) is resized by its URL suffix ("=w120-h120-…"):
//   544×544 (what YouTube Music's player shows), then the original upload ("=s0", size unknown,
//   so no width or height).
// - Video stills (i.ytimg.com) are built from the video ID: maxresdefault.jpg (1280×720), which
//   not every video has (checked with a HEAD request), then hqdefault.jpg (480×360), which every
//   video has.

import { Semaphore } from "./util.js";

const ART_SIZE = 544;
const ART_SUFFIX = /=(?:[wh]\d+|s\d+)[^/]*$/;
const headSlots = new Semaphore(8);

/** Whether i.ytimg.com has a maxresdefault.jpg for this video. Errors count as no. */
export async function hasMaxresThumbnail(videoId) {
  await headSlots.acquire();
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    headSlots.release();
  }
}

/**
 * @param {{ videoId: string, thumbnail?: { url, width, height } | null }} yt a search result
 * @param {(videoId: string) => Promise<boolean>} hasMaxres
 */
export async function thumbnailsFor(yt, hasMaxres = hasMaxresThumbnail) {
  const t = yt.thumbnail;
  let host = "";
  try {
    host = t?.url ? new URL(t.url).host : "";
  } catch {}
  if (host.endsWith(".googleusercontent.com") && ART_SUFFIX.test(t.url)) {
    const base = t.url.replace(ART_SUFFIX, "");
    return [
      { url: `${base}=w${ART_SIZE}-h${ART_SIZE}-l90-rj`, width: ART_SIZE, height: ART_SIZE },
      { url: `${base}=s0` },
    ];
  }
  if (host === "i.ytimg.com" || !t?.url) {
    const vi = `https://i.ytimg.com/vi/${yt.videoId}`;
    const hq = { url: `${vi}/hqdefault.jpg`, width: 480, height: 360 };
    return (await hasMaxres(yt.videoId)) ? [{ url: `${vi}/maxresdefault.jpg`, width: 1280, height: 720 }, hq] : [hq];
  }
  return [{ url: t.url, ...(t.width && t.height ? { width: t.width, height: t.height } : {}) }];
}
