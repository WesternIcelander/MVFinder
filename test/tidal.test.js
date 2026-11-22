import { test } from "node:test";
import assert from "node:assert/strict";
import { isoDurationMs, trackFromPage, tracksFromEmbed } from "../src/tidal.js";

// Trimmed from the real pages (tidal.com/track/251380837, embed.tidal.com/albums/251380836).
const trackPage = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicRecording","url":"https://tidal.com/track/251380837",
"byArtist":[{"@type":"MusicGroup","name":"Beyoncé"}],"duration":"PT3M28S","inAlbum":{"@type":"MusicAlbum","name":"RENAISSANCE"},
"isrcCode":"USSM12209515","name":"I'M THAT GIRL"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"TIDAL"}]}</script>
</head></html>`;

const row = (id, type, title, duration) => `<list-item tabindex="1" role="listitem" product-id="${id}" product-type="${type}" >
  <span slot="index">1</span><span slot="title">${title}</span><span slot="artist"></span>
  <time slot="duration">${duration}</time>
</list-item>`;
const embedPage = `<script>
    window.tidalCountryCode='IS';
    window.tidalMediaSessionMetadata={"251380837":{"album":"RENAISSANCE","artist":"Beyoncé","title":"I'M THAT GIRL"},"1":{"album":"X","artist":"HUNTR/X, EJAE, AUDREY NUNA","title":"Golden"}};
    </script>${row(251380837, "track", "I&#39;M THAT GIRL", "3:28")}${row(99, "video", "Some Video", "4:00")}${row(1, "track", "Golden", "1:03:20")}${row(2, "track", "Tom &amp; Jerry", "2:05")}`;

test("TIDAL track page: JSON-LD gives names, duration and ISRC", () => {
  assert.deepEqual(trackFromPage("251380837", trackPage), {
    service: "tidal", type: "track", id: "251380837", url: "https://tidal.com/track/251380837",
    title: "I'M THAT GIRL", artists: ["Beyoncé"], album: "RENAISSANCE", durationMs: 208000, isrc: "USSM12209515",
  });
  assert.throws(() => trackFromPage("1", "<html></html>"), (e) => e.status === 502);
  assert.equal(isoDurationMs("PT1H2M3.5S"), 3723500);
  assert.equal(isoDurationMs("nonsense"), null);
});

test("TIDAL embed: track rows with metadata, videos skipped", () => {
  const t = tracksFromEmbed(embedPage);
  assert.deepEqual(t.map((x) => [x.id, x.title, x.artists, x.album, x.durationMs, x.isrc]), [
    ["251380837", "I'M THAT GIRL", ["Beyoncé"], "RENAISSANCE", 208000, null],
    ["1", "Golden", ["HUNTR/X", "EJAE", "AUDREY NUNA"], "X", 3800000, null],
    ["2", "Tom & Jerry", [], null, 125000, null], // not in the metadata: title from the row
  ]);
});
