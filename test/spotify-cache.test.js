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
  const id = u.split("/tracks/")[1];
  requested.push(id);
  if (id === "legacyNull") return Response.json({ id, type: "track", name: "Back", artists: [{ name: "A" }], duration_ms: 1000, external_ids: { isrc: "X" } });
  return Response.json({ error: { status: 404, message: "Not found" } }, { status: 404 });
};

const { lookupTrack } = await import("../src/spotify.js");

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
