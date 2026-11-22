import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, requestUrl } from "../src/routes.js";

const route = (raw) => parseRoute(requestUrl(raw).pathname);
const ID = "6khnYqsyOTFq1SgpCi3Ucx";

test("a Spotify link minus https:// is the path, leniently", () => {
  const want = { route: "item", service: "spotify", type: "track", id: ID };
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
  assert.deepEqual(route("/open.spotify.com/playlist/33YxQ9R7gaOhNOjA1nKph1"), { route: "item", service: "spotify", type: "playlist", id: "33YxQ9R7gaOhNOjA1nKph1" });
  assert.deepEqual(route("/open.spotify.com/album/4m2880jivSbbyEGAKfITCa"), { route: "item", service: "spotify", type: "album", id: "4m2880jivSbbyEGAKfITCa" });
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

test("TIDAL links, in their variants", () => {
  const track = { route: "item", service: "tidal", type: "track", id: "251380837" };
  for (const p of [
    "/tidal.com/track/251380837",
    "/tidal.com/browse/track/251380837",
    "/tidal.com/browse/track/251380837/u",
    "/tidal.com/browse/track/251380837?u",
    "/listen.tidal.com/track/251380837",
    "/www.tidal.com/track/251380837",
    "/https://tidal.com/browse/track/251380837",
    "/listen.tidal.com/album/251380836/track/251380837",
  ]) {
    assert.deepEqual(route(p), track, p);
  }
  const album = { route: "item", service: "tidal", type: "album", id: "251380836" };
  assert.deepEqual(route("/tidal.com/album/251380836"), album);
  assert.deepEqual(route("/tidal.com/album/renaissance/251380836"), album);
  assert.deepEqual(route("/listen.tidal.com/album/251380836/"), album);
  const uuid = "36ea71a8-445e-41a4-82ab-6628c581535d";
  assert.deepEqual(route(`/tidal.com/browse/playlist/${uuid.toUpperCase()}`), { route: "item", service: "tidal", type: "playlist", id: uuid });
  for (const p of ["/tidal.com/artist/1566", "/tidal.com/playlist/123", `/tidal.com/track/${uuid}`, "/tidal.com.evil/track/1", "/eviltidal.com/track/1"]) {
    assert.equal(route(p), null, p);
  }
});
