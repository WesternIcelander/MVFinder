// Runs in its own process (node --test isolates files), so env and module state are private.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvf-tidal-"));
Object.assign(process.env, { DATA_DIR: dir, TIDAL_CLIENT_ID: "id", TIDAL_CLIENT_SECRET: "secret", TIDAL_COUNTRY_CODE: "is" });

// JSON:API documents shaped like openapi.tidal.com/v2's.
const artist = (id, name) => ({ id, type: "artists", attributes: { name } });
const track = (id, title, { version = null, isrc = `TEST0000000${id}`, artists = ["a1"], album = null } = {}) => ({
  id,
  type: "tracks",
  attributes: { title, version, isrc, duration: "PT3M28S" },
  relationships: {
    artists: { data: artists.map((a) => ({ id: a, type: "artists" })) },
    ...(album ? { albums: { data: [{ id: album, type: "albums" }] } } : {}),
  },
});
const ref = (id, type = "tracks") => ({ id, type });

const requested = [];
let failApi = false;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === "auth.tidal.com") {
    assert.equal(init.headers.authorization, "Basic " + Buffer.from("id:secret").toString("base64"));
    return Response.json({ access_token: "tok", expires_in: 14400 });
  }
  if (u.host === "openapi.tidal.com") {
    requested.push(u.pathname + (u.searchParams.has("page[cursor]") ? "#2" : ""));
    assert.equal(u.searchParams.get("countryCode"), "IS");
    if (failApi) return new Response("", { status: 500 });
    if (u.pathname === "/v2/tracks/11") {
      return Response.json({ data: track("11", "Song", { version: "Live", album: "al1", artists: ["a1", "a2"] }), included: [artist("a1", "First"), artist("a2", "Second"), { id: "al1", type: "albums", attributes: { title: "The Album" } }] });
    }
    if (u.pathname === "/v2/playlists/00000000-0000-0000-0000-000000000001") {
      return Response.json({
        data: {
          id: "00000000-0000-0000-0000-000000000001",
          type: "playlists",
          attributes: { name: "Mix", numberOfItems: 4, numberOfTrackItems: 3, playlistType: "EDITORIAL" },
          relationships: {
            owners: { data: [] },
            items: { data: [ref("1"), ref("9", "videos")], links: { next: "/playlists/00000000-0000-0000-0000-000000000001/relationships/items?countryCode=IS&page%5Bcursor%5D=abc" } },
          },
        },
        included: [track("1", "One", { version: "Remix" }), track("2", "Already (Remix)", { version: "Remix" }), artist("a1", "First")],
      });
    }
    if (u.pathname === "/v2/playlists/00000000-0000-0000-0000-000000000001/relationships/items") {
      assert.equal(u.searchParams.get("include"), "items,items.artists,items.albums");
      // "3" is unavailable in this country: referenced, but not included.
      return Response.json({ data: [ref("2"), ref("3")], links: {}, included: [track("2", "Already (Remix)", { version: "Remix" }), artist("a1", "First")] });
    }
    return Response.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  if (u.host === "embed.tidal.com") {
    requested.push(`embed${u.pathname}`);
    return new Response(`<script>
window.tidalMediaSessionMetadata={"5":{"album":"P","artist":"X","title":"From Embed"}};
</script><list-item product-id="5" product-type="track"><time slot="duration">1:00</time></list-item>`);
  }
  if (u.host === "tidal.com") {
    requested.push(`page${u.pathname}`);
    return new Response("<html></html>");
  }
  throw new Error(`unexpected fetch ${u}`);
};

const { getTidalItem, tidalStatus } = await import("../src/tidal.js");

test("TIDAL API: a track with its version, artists and album; cached afterwards", async () => {
  assert.deepEqual(tidalStatus(), { mode: "api", countryCode: "IS" });
  const { source, tracks } = await getTidalItem("track", "11");
  assert.deepEqual(source, {
    service: "tidal", type: "track", id: "11", url: "https://tidal.com/track/11",
    title: "Song (Live)", artists: ["First", "Second"], album: "The Album", durationMs: 208000, isrc: "TEST000000011",
    metadataSource: "api",
  });
  assert.equal(tracks[0].metadataSource, undefined);
  requested.length = 0;
  await getTidalItem("track", "11");
  assert.deepEqual(requested, []);
});

test("TIDAL API: a playlist across pages, skipping videos and unavailable tracks", async () => {
  requested.length = 0;
  const { source, tracks } = await getTidalItem("playlist", "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(requested, ["/v2/playlists/00000000-0000-0000-0000-000000000001", "/v2/playlists/00000000-0000-0000-0000-000000000001/relationships/items#2"]);
  assert.deepEqual(tracks.map((t) => [t.id, t.title, t.artists, t.isrc]), [
    ["1", "One (Remix)", ["First"], "TEST00000001"],
    ["2", "Already (Remix)", ["First"], "TEST00000002"],
  ]);
  assert.deepEqual(
    { title: source.title, owner: source.owner, trackCount: source.trackCount, totalTracks: source.totalTracks, truncated: source.truncated, m: source.metadataSource, l: source.trackListSource },
    { title: "Mix", owner: "TIDAL", trackCount: 2, totalTracks: 3, truncated: false, m: "api", l: "api" },
  );
});

test("TIDAL API failure falls back to the public pages", async () => {
  failApi = true;
  requested.length = 0;
  try {
    const { source, tracks } = await getTidalItem("album", "77");
    assert.equal(requested[0], "/v2/albums/77");
    assert.ok(requested.includes("embed/albums/77"));
    assert.deepEqual(tracks.map((t) => t.title), ["From Embed"]);
    assert.equal(source.trackListSource, "embed");
  } finally {
    failApi = false;
  }
});
