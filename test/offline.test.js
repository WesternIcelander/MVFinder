import { test } from "node:test";
import assert from "node:assert/strict";
import { coreTitle, scoreMatch, scriptLangs } from "../src/match.js";
import { refineKind, toResult } from "../src/youtube.js";
import { pickVersion } from "../src/ytjs-package.js";
import { createResolver, parseOptions, pick } from "../src/resolve.js";

test("coreTitle strips Spotify suffixes", () => {
  assert.equal(coreTitle("Bohemian Rhapsody - Remastered 2011"), "Bohemian Rhapsody");
  assert.equal(coreTitle("Instant Crush (feat. Julian Casablancas)"), "Instant Crush");
  assert.equal(coreTitle("Hey Jude [Remastered 2015]"), "Hey Jude");
  assert.equal(coreTitle("(Don't Fear) The Reaper"), "(Don't Fear) The Reaper");
});

test("refineKind separates static uploads from real videos", () => {
  assert.equal(refineKind("music_video", "Blinding Lights (Official Video)"), "music_video");
  assert.equal(refineKind("music_video", "Blinding Lights (Official Audio)"), "official_audio");
  assert.equal(refineKind("music_video", "Song (Official Visualizer)"), "visualizer");
  assert.equal(refineKind("official_video", "Song (Lyric Video)"), "lyric_video");
  assert.equal(refineKind("music_video", "Bohemian Rhapsody (Digital Remaster)"), "music_video");
  assert.equal(refineKind("user_video", "Song (Official Audio)"), "user_video");
});

const endpoint = (type) => ({
  payload: { watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } },
});

test("toResult reads youtubei.js song and video items", () => {
  const song = toResult({
    id: "J7p4bzqLvCw",
    title: "Blinding Lights",
    artists: [{ name: "The Weeknd" }],
    album: { name: "After Hours" },
    duration: { seconds: 202 },
    overlay: { content: { endpoint: endpoint("MUSIC_VIDEO_TYPE_ATV") } },
  });
  assert.deepEqual(song, {
    videoId: "J7p4bzqLvCw",
    videoType: "MUSIC_VIDEO_TYPE_ATV",
    kind: "song",
    title: "Blinding Lights",
    artists: ["The Weeknd"],
    album: "After Hours",
    durationMs: 202000,
  });
  const video = toResult({
    id: "4NRXx6U8ABQ",
    title: "Blinding Lights (Official Video)",
    authors: [{ name: "The Weeknd" }],
    duration: { seconds: 263 },
    flex_columns: [{ title: { endpoint: endpoint("MUSIC_VIDEO_TYPE_OMV") } }],
  });
  assert.equal(video.kind, "music_video");
  assert.deepEqual(video.artists, ["The Weeknd"]);
  assert.equal(toResult({ title: "no id" }), null);
});

const track = { title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 200040 };
const yt = (over) => ({ kind: "song", title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 200000, ...over });

test("scoring: exact, long video, variants, wrong artist", () => {
  assert.equal(scoreMatch(track, yt()).confidence, 1);
  const mv = scoreMatch(track, yt({ kind: "music_video", title: "The Weeknd - Blinding Lights (Official Video)", durationMs: 263000 }));
  assert.ok(mv.confidence >= 0.9, JSON.stringify(mv));
  for (const title of ["Blinding Lights (Live at SoFi)", "Blinding Lights (slowed + reverb)", "Blinding Lights (Drumless Edition)"]) {
    assert.ok(scoreMatch(track, yt({ title })).confidence < 0.9, title);
  }
  assert.ok(scoreMatch(track, yt({ artists: ["Someone Else"] })).confidence < 0.7);
});

test("pick prefers titled official videos and skips user uploads", () => {
  const c = (kind, title, confidence) => ({ yt: { kind, title }, score: { confidence } });
  const scored = [
    c("user_video", "Blinding Lights (Lyrics)", 0.99),
    c("music_video", "Blinding Lights", 0.97),
    c("music_video", "Blinding Lights (Official Video)", 0.95),
    c("song", "Blinding Lights", 0.9),
  ];
  const opts = { type: "all", all: false };
  assert.deepEqual(pick(scored, opts).map((s) => s.yt.title), ["Blinding Lights", "Blinding Lights (Official Video)"]);
  assert.deepEqual(pick([c("user_video", "x", 1)], opts), []);
  assert.equal(pick(scored, { ...opts, type: "song" }).length, 1);
});

test("pickVersion honours spec and minimum release age", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const doc = {
    "dist-tags": { latest: "18.3.0" },
    versions: { "17.0.0": {}, "18.2.0": {}, "18.3.0": {}, "19.0.0-beta.1": {}, "18.1.0": { deprecated: "bad" } },
    time: {
      "17.0.0": "2026-01-01T00:00:00Z",
      "18.1.0": "2026-09-01T00:00:00Z",
      "18.2.0": "2026-10-01T00:00:00Z",
      "18.3.0": "2026-11-19T12:00:00Z", // 12h old
      "19.0.0-beta.1": "2026-11-01T00:00:00Z",
    },
  };
  const day = 24 * 3600_000;
  assert.equal(pickVersion(doc, "latest", now - day), "18.2.0");
  assert.equal(pickVersion(doc, "latest", now), "18.3.0");
  assert.equal(pickVersion(doc, "17", now), "17.0.0");
  assert.equal(pickVersion(doc, "18.3.0", now - day), "18.3.0"); // exact pins skip the age rule
  assert.equal(pickVersion(doc, "16", now), null);
  assert.throws(() => pickVersion(doc, "^18", now));
  assert.throws(() => pickVersion(doc, "99.0.0", now));
});

test("parseOptions validates query parameters", () => {
  const p = (q) => parseOptions(new URLSearchParams(q));
  assert.deepEqual(p(""), { type: "all", all: false, minConfidence: 0.7, explain: false });
  assert.deepEqual(p("type=video&all&explain=1&minConfidence=0.5"), { type: "video", all: true, minConfidence: 0.5, explain: true });
  assert.throws(() => p("type=podcast"), /type must be/);
  assert.throws(() => p("minConfidence=2"), /minConfidence/);
});

// A fake YouTube: ISRC queries return `isrcResults`, video searches return `videos`.
function fakeYouTube(isrc, isrcResults, videos) {
  const queries = [];
  return {
    queries,
    search: async (q, filter) => {
      queries.push([filter, q]);
      if (q === isrc) return isrcResults;
      return filter === "videos" ? videos : [];
    },
  };
}
const ytItem = (over) => ({ videoType: "MUSIC_VIDEO_TYPE_ATV", kind: "song", album: null, ...over });
const opts = { type: "all", all: false, minConfidence: 0.7, explain: false };
const noLookup = async () => null;

test("resolver: verified ISRC hit wins and its title becomes an alias for videos", async () => {
  const song = ytItem({ videoId: "S1", title: "アイスドロップ", artists: ["Aqu3ra"], durationMs: 225000 });
  const video = { ...song, videoId: "V1", videoType: "MUSIC_VIDEO_TYPE_OMV", kind: "music_video" };
  const youtube = fakeYouTube("TCJPR2239926", [song], [video]);
  const track = { id: "x", title: "Ice Drop", artists: ["Aqu3ra"], durationMs: 224856, isrc: "TCJPR2239926" };

  const m = await createResolver({ youtube, lookupTrack: noLookup, ttlHours: 0, maxEntries: 10 }).matchTrack(track, opts);
  assert.deepEqual(m.map((x) => [x.type, x.videoId, x.matchedBy, x.confidence]), [["song", "S1", "isrc", 1], ["music_video", "V1", "search", 1]]);
  assert.deepEqual(youtube.queries, [["songs", "TCJPR2239926"], ["videos", "Aqu3ra アイスドロップ"]]);
});

test("resolver: ISRC hit with nothing in common is rejected, on every session", async () => {
  const wrong = ytItem({ videoId: "W", title: "2422-24", artists: ["Someone"], durationMs: 225000 });
  const youtube = fakeYouTube("TCJPR2239926", [wrong], []);
  const track = { id: "x", title: "Ice Drop", artists: ["Aqu3ra"], durationMs: 224856, isrc: "TCJPR2239926" };
  const m = await createResolver({ youtube, lookupTrack: noLookup, ttlHours: 0, maxEntries: 10 }).matchTrack(track, opts);
  assert.deepEqual(m, []);
  assert.equal(youtube.queries.filter(([, q]) => q === "TCJPR2239926").length, 5);
});

test("resolver: API names replace embed names, which stay usable as aliases", async () => {
  const song = ytItem({ videoId: "S1", title: "キレキャリオン", artists: ["ポリスピカデリー"], durationMs: 181000 });
  const youtube = fakeYouTube("JPA651804421", [song], []);
  const embedTrack = { id: "t1", title: "キレキャリオン", artists: ["Police Piccadilly"], album: null, durationMs: 180493, isrc: null };
  const lookupTrack = async () => ({ ...embedTrack, artists: ["ポリスピカデリー"], album: "キレキャリオン", isrc: "JPA651804421" });
  const m = await createResolver({ youtube, lookupTrack, ttlHours: 0, maxEntries: 10 }).matchTrack(embedTrack, opts);
  assert.deepEqual(m.map((x) => [x.type, x.matchedBy]), [["song", "isrc"]]);
  assert.deepEqual(embedTrack.artists, ["ポリスピカデリー"]); // response shows the API record
  assert.equal(embedTrack.isrc, "JPA651804421");
});

test("resolver: ISRC hit's artist romanisation becomes an alias for videos", async () => {
  const song = ytItem({ videoId: "S1", title: "天使のニューゲーム - Angel's New Game", artists: ["Asyu"], durationMs: 208000 });
  const video = { ...song, videoId: "V1", videoType: "MUSIC_VIDEO_TYPE_OMV", kind: "music_video", durationMs: 206000 };
  const youtube = fakeYouTube("JP92U2400187", [song], [video]);
  const track = { id: "x", title: "Angel's New Game", artists: ["阿修"], durationMs: 207195, isrc: "JP92U2400187" };
  const m = await createResolver({ youtube, lookupTrack: noLookup, ttlHours: 0, maxEntries: 10 }).matchTrack(track, opts);
  assert.deepEqual(m.map((x) => [x.type, x.videoId, x.matchedBy]), [["song", "S1", "isrc"], ["music_video", "V1", "search"]]);
});

test("scriptLangs detects CJK scripts", () => {
  assert.deepEqual(scriptLangs("ゼロトーキング"), ["ja"]);
  assert.deepEqual(scriptLangs("はるまきごはん"), ["ja"]);
  assert.deepEqual(scriptLangs("천국"), ["ko"]);
  assert.deepEqual(scriptLangs("帝国少女"), ["ja", "zh"]);
  assert.deepEqual(scriptLangs("Zero Talking"), []);
});

test("resolver: native artist name from Spotify unlocks an all-Japanese ISRC hit and its video", async () => {
  // Zero Talking: YouTube has 「ゼロトーキング」 by 「はるまきごはん」; Spotify says "Zero Talking" by "Harumakigohan".
  const song = ytItem({ videoId: "S1", title: "ゼロトーキング", artists: ["はるまきごはん"], durationMs: 222000 });
  const garbage = ytItem({ videoId: "G", title: "NO BATIDÃO (Slowed)", artists: ["ZXKAI"], durationMs: 108000 });
  const mv = ytItem({ videoId: "2INYgH-Gcjk", title: "ゼロトーキング", artists: ["Harumaki Gohan"], durationMs: 227000, videoType: "MUSIC_VIDEO_TYPE_OMV", kind: "music_video" });
  const queries = [];
  let isrcCalls = 0;
  const youtube = {
    search: async (q, filter) => {
      queries.push([filter, q]);
      if (q === "TCJPX2384889") return ++isrcCalls === 2 ? [song] : [garbage]; // only one session gets it right
      return filter === "videos" ? (q.includes("ゼロトーキング") ? [mv] : []) : [];
    },
  };
  const langsAsked = [];
  const lookupLocalizedTrack = async (id, lang) => {
    langsAsked.push(lang);
    return lang === "ja" ? { title: "Zero Talking", artists: ["はるまきごはん"] } : null;
  };
  const track = { id: "3dku", title: "Zero Talking", artists: ["Harumakigohan"], durationMs: 219329, isrc: "TCJPX2384889" };
  const m = await createResolver({ youtube, lookupTrack: noLookup, lookupLocalizedTrack, ttlHours: 0, maxEntries: 10 }).matchTrack(track, opts);
  assert.deepEqual(m.map((x) => [x.type, x.videoId, x.matchedBy, x.confidence]), [["song", "S1", "isrc", 1], ["music_video", "2INYgH-Gcjk", "search", 1]]);
  assert.deepEqual(langsAsked, ["ja"]);
  assert.ok(queries.some(([f, q]) => f === "videos" && q === "Harumakigohan ゼロトーキング"));
});

test("resolver: no localisation lookups when names are comparable", async () => {
  const song = ytItem({ videoId: "S1", title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 202000 });
  const youtube = fakeYouTube("USUG11904206", [song], []);
  let lookups = 0;
  const track = { id: "x", title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 200040, isrc: "USUG11904206" };
  await createResolver({ youtube, lookupTrack: noLookup, lookupLocalizedTrack: async () => (lookups++, null), ttlHours: 0, maxEntries: 10 }).matchTrack(track, opts);
  assert.equal(lookups, 0);
});

test("PersistentMap saves, reloads, and evicts oldest entries", async () => {
  const { PersistentMap } = await import("../src/store.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mvf-")), "s.json");
  const a = new PersistentMap(file, { maxEntries: 2 });
  a.set("x", 1).set("y", { z: [1] }).set("x", 3).set("w", 4); // "y" is now the oldest → evicted
  a.save();
  const b = new PersistentMap(file);
  assert.deepEqual([...b.keys()], ["x", "w"]);
  assert.equal(b.get("x"), 3);
});
