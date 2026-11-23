import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearch, interleave, parseSearchParams } from "../src/search.js";
import { parseRoute } from "../src/routes.js";
import { toYouTubeResult } from "../src/youtube.js";

const p = (q) => parseSearchParams(new URLSearchParams(q));

test("search parameters: query required and tidied; type only with music; limit 1–20", () => {
  assert.deepEqual(parseRoute("/search"), { route: "search" });
  assert.deepEqual(p("query=+beyonce++cuff%20it+"), { query: "beyonce cuff it", music: false, type: "all", limit: 10 });
  assert.deepEqual(p("query=x&music=1&type=song&limit=20"), { query: "x", music: true, type: "song", limit: 20 });
  assert.equal(p("query=x&music").music, true);
  assert.equal(p("query=x&music=0").music, false);
  for (const bad of ["", "query=", "query=%20", `query=${"a".repeat(201)}`, "query=x&type=song", "query=x&music=1&type=album", "query=x&limit=0", "query=x&limit=21", "query=x&limit=2.5"]) {
    assert.throws(() => p(bad), (e) => e.status === 400, bad);
  }
});

// youtubei.js Video nodes, trimmed to the fields we read.
const video = (id, title, author, extra = {}) => ({
  type: "Video",
  video_id: id,
  title: { text: title },
  author,
  duration: { seconds: 233 },
  is_live: false,
  thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hq720.jpg?sqp=x`, width: 720, height: 404 }],
  ...extra,
});
const artistChannel = { name: "Beyoncé", is_verified_artist: true };

test("toYouTubeResult: kind from channel and title", () => {
  const kinds = [
    video("a", "Beyoncé - CUFF IT (Official Lyric Video)", artistChannel),
    video("b", "Beyoncé - CUFF IT (Official Music Video)", artistChannel),
    video("c", "Beyoncé - CUFF IT (WETTER REMIX) - Official Visualizer", artistChannel),
    video("d", "Beyoncé - CUFF IT (Live)", artistChannel),
    video("e", "Beyoncé - CUFF IT (Music Video)", { name: "RENAISSANCE CLUB" }), // fan channel
    video("f", "Cuff It (Beyoncé cover) (Official Video)", { name: "BBCRadio1VEVO", is_verified_artist: false }),
    video("g", "CUFF IT", { name: "Beyoncé - Topic" }),
  ].map(toYouTubeResult);
  assert.deepEqual(kinds.map((r) => r.kind), ["lyric_video", "music_video", "visualizer", "official_video", "video", "music_video", "song"]);
  assert.deepEqual(kinds[6].artists, ["Beyoncé"]); // from the Topic channel's name
  assert.deepEqual(kinds[0].artists, []);
  assert.equal(kinds[0].channel, "Beyoncé");
  assert.equal(kinds[0].durationMs, 233000);
  assert.equal(toYouTubeResult(video("h", "Radio", { name: "X" }, { is_live: true, duration: { seconds: 0 } })).durationMs, null);
  assert.equal(toYouTubeResult({ title: { text: "no id" } }), null);
});

test("interleave alternates and keeps the longer list's tail", () => {
  assert.deepEqual(interleave([1, 2, 3], ["a"]), [1, "a", 2, 3]);
  assert.deepEqual(interleave([], ["a", "b"]), ["a", "b"]);
});

function fakeYouTube() {
  const calls = [];
  const r = (id, kind, extra = {}) => ({ videoId: id, videoType: null, kind, title: id, artists: ["A"], album: null, durationMs: 1000, thumbnail: null, ...extra });
  return {
    calls,
    search: async (query, filter) => {
      calls.push(filter);
      if (filter === "songs") return [r("s1", "song"), r("s2", "song"), r("dup", "song")];
      if (filter === "videos") return [r("v1", "music_video"), r("dup", "user_video"), r("v3", "other")];
      return [r("y1", "video", { channel: "Someone", artists: [] }), r("y2", "lyric_video", { channel: "Artist", artists: [], live: true })];
    },
  };
}

test("search: YouTube by default, YouTube Music with music=1 (alternating, deduplicated, limited), cached", async () => {
  const youtube = fakeYouTube();
  const s = createSearch({ youtube });

  const plain = await s.search(p("query=x"));
  assert.deepEqual(youtube.calls, ["youtube"]);
  assert.deepEqual(plain[0], {
    type: "video", title: "y1", channel: "Someone", durationMs: 1000, videoId: "y1",
    url: "https://www.youtube.com/watch?v=y1", youtubeUrl: "https://www.youtube.com/watch?v=y1", youtubeMusicUrl: "https://music.youtube.com/watch?v=y1",
    thumbnails: [{ url: "https://i.ytimg.com/vi/y1/hqdefault.jpg", width: 480, height: 360 }],
  });
  assert.equal(plain[1].live, true);

  const music = await s.search(p("query=x&music=1&limit=5"));
  assert.deepEqual(music.map((m) => [m.videoId, m.type]), [["s1", "song"], ["v1", "music_video"], ["s2", "song"], ["dup", "user_video"], ["v3", "video"]]); // first copy wins
  assert.equal(music[0].url, "https://music.youtube.com/watch?v=s1");
  assert.deepEqual(music[0].artists, ["A"]);

  youtube.calls.length = 0;
  await s.search(p("query=X&music=1&limit=5")); // same search, other case
  assert.deepEqual(youtube.calls, []);
  await s.search(p("query=x&music=1&type=video"));
  assert.deepEqual(youtube.calls, ["videos"]);
});
