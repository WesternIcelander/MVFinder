import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, requestUrl } from "../src/routes.js";

const route = (raw) => parseRoute(requestUrl(raw).pathname);
const ID = "6khnYqsyOTFq1SgpCi3Ucx";

test("a Spotify link minus https:// is the path, leniently", () => {
  const want = { route: "spotify", type: "track", id: ID };
  for (const p of [
    `/open.spotify.com/track/${ID}`,
    `/open.spotify.com/track/${ID}/`,
    `/open.spotify.com/track/${ID}?si=abc123&pt=x`,
    `/https://open.spotify.com/track/${ID}`,
    `/http://open.spotify.com/track/${ID}`,
    `/https:/open.spotify.com/track/${ID}`, // a proxy collapsed the "//"
    `//open.spotify.com/track/${ID}`, // would otherwise be read as a host
    `/open.spotify.com/intl-de/track/${ID}`,
    `/open.spotify.com/intl-pt-BR/track/${ID}`,
    `/open.spotify.com/embed/track/${ID}`,
    `/OPEN.SPOTIFY.COM/Track/${ID}`,
  ]) {
    assert.deepEqual(route(p), want, p);
  }
  assert.deepEqual(route("/open.spotify.com/playlist/33YxQ9R7gaOhNOjA1nKph1"), { route: "spotify", type: "playlist", id: "33YxQ9R7gaOhNOjA1nKph1" });
  assert.deepEqual(route("/open.spotify.com/album/4m2880jivSbbyEGAKfITCa"), { route: "spotify", type: "album", id: "4m2880jivSbbyEGAKfITCa" });
});

test("other paths", () => {
  assert.deepEqual(route("/health"), { route: "health" });
  assert.deepEqual(route("/isrc/us-um7%2012-34567"), { route: "isrc", isrc: "us-um7 12-34567" });
  assert.deepEqual(route("/isrc/%E0%A4%A"), { route: "isrc", isrc: "%E0%A4%A" }); // bad escape: left as is
  for (const p of ["/", `/spotify/track/${ID}`, "/open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF", "/open.spotify.com/track/short", "/evil.com/track/" + ID, "/open.spotify.com.evil/track/" + ID]) {
    assert.equal(route(p), null, p);
  }
  assert.equal(requestUrl(`/open.spotify.com/track/${ID}?si=x&type=song`).searchParams.get("type"), "song");
});
