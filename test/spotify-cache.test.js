// Runs in its own process (node --test isolates files), so env and module state are private.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvf-spotify-"));
const day = 24 * 3600_000;
fs.writeFileSync(
  path.join(dir, "spotify-tracks.json"),
  JSON.stringify([
    ["freshMissing", { notFound: true, at: Date.now() - 3600_000 }], // 1 h old: still trusted
    ["staleMissing", { notFound: true, at: Date.now() - 2 * day }], // 2 days old: expired
    ["legacyNull", null], // written by an older version: retried
  ]),
);
Object.assign(process.env, { DATA_DIR: dir, SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_MAX_REQUESTS_PER_SECOND: "1000" });

const requested = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("accounts.spotify.com")) return Response.json({ access_token: "t", expires_in: 3600 });
  if (u.includes("/search?")) {
    const isrc = decodeURIComponent(new URL(u).searchParams.get("q")).replace("isrc:", "");
    requested.push(`search:${isrc}`);
    const items = isrc === "USUM71234567" ? [{ id: "fuzzy", type: "track", name: "Other", artists: [], external_ids: { isrc: "USUM71234568" } }, { id: "byIsrc", type: "track", name: "Found", artists: [{ name: "A" }], duration_ms: 1000, external_ids: { isrc: "usum71234567" } }] : [];
    return Response.json({ tracks: { items } });
  }
  const id = u.split("/tracks/")[1];
  requested.push(id);
  if (id === "legacyNull") return Response.json({ id, type: "track", name: "Back", artists: [{ name: "A" }], duration_ms: 1000, external_ids: { isrc: "X" } });
  return Response.json({ error: { status: 404, message: "Not found" } }, { status: 404 });
};

const { lookupIsrc, lookupTrack } = await import("../src/spotify.js");

test("a cached 'not found' is trusted for a day, then retried", async () => {
  assert.equal(await lookupTrack("freshMissing"), null);
  assert.equal(await lookupTrack("staleMissing"), null);
  assert.deepEqual(requested, ["staleMissing"]); // the fresh one cost no request

  // The retry stored a new "not found", so it isn't requested again.
  assert.equal(await lookupTrack("staleMissing"), null);
  assert.deepEqual(requested, ["staleMissing"]);
});

test("legacy null entries are retried, and a found track is cached", async () => {
  requested.length = 0;
  assert.equal((await lookupTrack("legacyNull")).isrc, "X");
  assert.equal((await lookupTrack("legacyNull")).title, "Back");
  assert.deepEqual(requested, ["legacyNull"]);
});

test("ISRC lookup: one search, exact ISRC only, cached (also by track ID); not found for a day", async () => {
  requested.length = 0;
  assert.equal((await lookupIsrc("USUM71234567")).id, "byIsrc");
  assert.equal((await lookupIsrc("USUM71234567")).title, "Found");
  assert.equal((await lookupTrack("byIsrc")).title, "Found");
  assert.deepEqual(requested, ["search:USUM71234567"]);

  await assert.rejects(lookupIsrc("ZZ0000000000"), (e) => e.status === 404);
  await assert.rejects(lookupIsrc("ZZ0000000000"), (e) => e.status === 404);
  assert.deepEqual(requested, ["search:USUM71234567", "search:ZZ0000000000"]);
});
