// Runs in its own process (node --test isolates files), so env and module state are private.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvf-isrc-"));
Object.assign(process.env, { ISRC_TEST_NO_DELAYS: "1", DATA_DIR: dir, SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_MAX_REQUESTS_PER_SECOND: "1000" });

// Fake services: Spotify knows SPOT, Deezer knows DEEZ, MusicBrainz knows MBRZ; Deezer fails on FAIL.
const requested = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.host === "accounts.spotify.com") return Response.json({ access_token: "t", expires_in: 3600 });
  if (u.host === "api.spotify.com") {
    const isrc = u.searchParams.get("q").replace("isrc:", "");
    requested.push(`spotify:${isrc}`);
    const items = isrc === "SPOTA0000001" ? [{ id: "sp1", type: "track", name: "From Spotify", artists: [{ name: "A" }], duration_ms: 200000, external_ids: { isrc } }] : [];
    return Response.json({ tracks: { items } });
  }
  if (u.host === "api.deezer.com") {
    const isrc = u.pathname.split("isrc:")[1];
    requested.push(`deezer:${isrc}`);
    if (isrc === "FAILA0000001") return Response.json({ error: { type: "Exception", message: "Quota limit exceeded", code: 4 } });
    if (isrc !== "DEEZA0000001") return Response.json({ error: { type: "DataException", message: "no data", code: 800 } });
    return Response.json({ id: 42, title: "From Deezer", isrc, duration: 201, link: "https://www.deezer.com/track/42", artist: { name: "B" }, contributors: [{ name: "B" }, { name: "C" }], album: { title: "Alb" } });
  }
  if (u.host === "musicbrainz.org") {
    const isrc = u.pathname.split("/").pop();
    requested.push(`musicbrainz:${isrc}`);
    if (isrc === "BUSYA0000001" || (isrc === "SLOWA0000001" && requested.filter((r) => r === "musicbrainz:SLOWA0000001").length < 3)) {
      return new Response("", { status: 503 }); // MusicBrainz's rate-limit answer
    }
    if (isrc === "SLOWA0000001") return Response.json({ recordings: [{ id: "slow", title: "Eventually", length: 1000, "artist-credit": [] }] });
    if (!["MBRZA0000001", "FAILA0000001"].includes(isrc)) return Response.json({ error: "Not Found" }, { status: 404 });
    return Response.json({ recordings: [{ id: "r0", title: "No Length", "artist-credit": [] }, { id: "r1", title: "From MusicBrainz", length: 202000, "artist-credit": [{ name: "D" }] }] });
  }
  throw new Error(`unexpected fetch ${u}`);
};

const { lookupIsrcSource, normalizeIsrc } = await import("../src/isrc.js");
test("normalizeIsrc is lenient about case, dashes, spaces and a prefix", () => {
  for (const s of ["USUM71234567", "us-um7-12-34567", " US UM7 12 34567 ", "isrc:USUM71234567", "US.UM7.12.34567", "TCJPR2239926"]) {
    assert.match(normalizeIsrc(s), /^(USUM71234567|TCJPR2239926)$/, s);
  }
  for (const s of ["", "USUM7123456", "USUM712345678", "1SUM71234567", "USUM7123456X", "ISRCUSUM7123"]) {
    assert.throws(() => normalizeIsrc(s), (e) => e.status === 400, s);
  }
});

test("ISRC sources: Spotify, then Deezer, then MusicBrainz; answers are cached", async () => {
  assert.equal((await lookupIsrcSource("SPOTA0000001")).title, "From Spotify");
  const dz = await lookupIsrcSource("DEEZA0000001");
  assert.deepEqual([dz.service, dz.id, dz.artists, dz.durationMs, dz.album], ["deezer", "42", ["B", "C"], 201000, "Alb"]);
  const mb = await lookupIsrcSource("MBRZA0000001");
  assert.deepEqual([mb.service, mb.id, mb.title, mb.durationMs], ["musicbrainz", "r1", "From MusicBrainz", 202000]); // the one with a length
  assert.deepEqual(requested, [
    "spotify:SPOTA0000001",
    "spotify:DEEZA0000001", "deezer:DEEZA0000001",
    "spotify:MBRZA0000001", "deezer:MBRZA0000001", "musicbrainz:MBRZA0000001",
  ]);

  requested.length = 0;
  for (const isrc of ["SPOTA0000001", "DEEZA0000001", "MBRZA0000001"]) await lookupIsrcSource(isrc);
  assert.deepEqual(requested, []); // all cached
});

test("ISRC sources: 404 when nobody has it (cached); 502 when a source failed", async () => {
  requested.length = 0;
  await assert.rejects(lookupIsrcSource("NONEA0000001"), (e) => e.status === 404 && /Spotify, Deezer, MusicBrainz/.test(e.message));
  await assert.rejects(lookupIsrcSource("NONEA0000001"), (e) => e.status === 404);
  assert.equal(requested.length, 3); // asked each once

  // Deezer erroring doesn't stop MusicBrainz; the error isn't cached.
  assert.equal((await lookupIsrcSource("FAILA0000001")).service, "musicbrainz");
  requested.length = 0;
  assert.equal((await lookupIsrcSource("FAILA0000001")).service, "musicbrainz");
  assert.deepEqual(requested, ["deezer:FAILA0000001"]);
});

test("MusicBrainz 503 = rate limited: retried twice, then reported as 503 (not cached)", async () => {
  assert.equal((await lookupIsrcSource("SLOWA0000001")).id, "slow"); // 503, 503, then OK
  requested.length = 0;
  await assert.rejects(lookupIsrcSource("BUSYA0000001"), (e) => e.status === 503 && /rate limited/.test(e.message));
  assert.equal(requested.filter((r) => r.startsWith("musicbrainz")).length, 3);
});
