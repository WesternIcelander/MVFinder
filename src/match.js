// Scores YouTube Music search results against a Spotify track.

export function normalize(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const tokens = (s) => normalize(s).split(" ").filter(Boolean);
const squash = (s) => normalize(s).replace(/ /g, "");

// Strip things Spotify appends to titles: " - Remastered 2011", "(feat. X)", "[Radio Edit]".
export function coreTitle(title) {
  return String(title)
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s*[([][^)\]]*\b(feat|ft|with|remaster(ed)?|version|edit|mono|stereo|deluxe|bonus)\b[^)\]]*[)\]]/gi, "")
    .trim();
}

// Strip things YouTube video titles add: "Artist - ", "(Official Video)", "[4K]", "| Vevo".
const VIDEO_NOISE = /\b(official|music|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|1080p|mv|m\/v|remaster(ed)?|feat|ft|explicit|clean|vevo)\b/i;
function cleanVideoTitle(title, artists) {
  let t = String(title)
    .replace(/\s*[([][^)\]]*[)\]]/g, (m) => (VIDEO_NOISE.test(m) ? "" : m))
    .replace(/\s*[|｜].*$/, "");
  for (const a of artists) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*${esc}\\s*[-–—:]\\s*`, "i"), "").replace(new RegExp(`\\s*[-–—]\\s*${esc}\\s*$`, "i"), "");
  }
  return t.trim();
}

function dice(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hits = 0;
  for (const t of A) {
    const i = pool.indexOf(t);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

function titleScore(spotifyTitle, ytTitle, artists, aliases) {
  // Aliases: other known titles for the same recording, e.g. the native-script title YouTube
  // Music uses ("アイスドロップ") when Spotify gives an English one ("Ice Drop").
  const candidates = [spotifyTitle, ...aliases].flatMap((t) => [t, coreTitle(t)]);
  const yt = cleanVideoTitle(ytTitle, artists);
  let best = 0;
  for (const c of candidates) {
    if (squash(c) && squash(c) === squash(yt)) return 1;
    best = Math.max(best, dice(c, yt));
  }
  return best;
}

// aliasArtists: other known names for the main artist(s), e.g. "ポリスピカデリー" for
// "Police Piccadilly", or "Asyu" for "阿修"; they count as much as the primary artist.
function artistScore(spotifyArtists, yt, aliasArtists) {
  const ytArtists = yt.artists.map(squash);
  const matches = (a) => ytArtists.some((y) => y && (y === a || y.includes(a) || a.includes(y)));
  const [primary, ...rest] = spotifyArtists.map(squash).filter(Boolean);
  if (!primary) return 0;
  const primaries = [primary, ...aliasArtists.map(squash).filter(Boolean)];
  if (primaries.some(matches)) return 1;
  // Videos are often on a label/broadcaster channel with the artist only in the title.
  const ytTitle = squash(yt.title);
  if (primaries.some((p) => ytTitle.includes(p))) return 0.85;
  if (rest.some(matches)) return 0.7;
  return 0;
}

function durationScore(spotifyMs, ytMs, isVideo) {
  if (spotifyMs == null || ytMs == null) return 0.5;
  const diff = (ytMs - spotifyMs) / 1000;
  const d = Math.abs(diff);
  if (!isVideo) return d <= 3 ? 1 : Math.max(0, 1 - (d - 3) / 27);
  // Music videos often have intros/outros, so allow them to run long.
  if (d <= 10) return 1;
  return Math.max(0, 1 - (d - 10) / (diff > 0 ? 240 : 40));
}

// Words that signal a different recording when they're in the YouTube title but not on Spotify.
const VARIANTS = [
  "live", "acoustic", "remix", "cover", "karaoke", "instrumental", "sped up", "slowed", "reverb",
  "nightcore", "8d", "tutorial", "lesson", "reaction", "piano", "guitar", "drum", "bass boosted", "loop",
  "extended", "minutes", "hour", "hours", "432hz", "lofi", "mashup", "medley", "parody", "dance practice",
  "drumless", "vs",
];

function variantPenalty(spotifyTitle, ytTitle) {
  const s = ` ${normalize(spotifyTitle)} `;
  const y = ` ${normalize(ytTitle)} `;
  const hits = VARIANTS.filter((w) => y.includes(` ${w} `) && !s.includes(` ${w} `));
  // Unexplained "(Something Edition)" style suffixes usually mean a different version.
  const extras = (String(ytTitle).match(/[([][^)\]]*[)\]]/g) ?? [])
    .filter((p) => !VIDEO_NOISE.test(p) && !s.includes(` ${normalize(p)} `))
    .map((p) => p.slice(1, -1).trim());
  const penalty = hits.length * 0.35 + extras.length * 0.15;
  return { penalty: Math.min(0.6, penalty), flags: [...hits, ...extras.map((e) => `extra:${e}`)] };
}

/**
 * Returns { confidence (0-1), breakdown } for one YT result vs a Spotify track.
 * aliases: { titles, artists } — other known names for this recording and its artist.
 */
export function scoreMatch(track, yt, aliases = {}) {
  const aliasTitles = aliases.titles ?? [];
  const aliasArtists = aliases.artists ?? [];
  const isVideo = yt.kind !== "song";
  const title = titleScore(track.title, yt.title, [...track.artists, ...aliasArtists], aliasTitles);
  const artist = artistScore(track.artists, yt, aliasArtists);
  const duration = durationScore(track.durationMs, yt.durationMs, isVideo);
  const { penalty, flags } = variantPenalty(track.title, yt.title);
  const raw = 0.45 * title + 0.35 * artist + 0.2 * duration - penalty;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    confidence: round(Math.min(1, Math.max(0, raw))),
    breakdown: { title: round(title), artist: round(artist), duration: round(duration), variantFlags: flags },
  };
}

const KANA = /[぀-ヿㇰ-ㇿ]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HAN = /[㐀-䶿一-鿿]/;

/** Languages whose script appears in text: kana → ja, hangul → ko, kanji/hanzi alone → ja and zh. */
export function scriptLangs(text) {
  const s = String(text ?? "");
  const langs = [];
  if (KANA.test(s)) langs.push("ja");
  if (HANGUL.test(s)) langs.push("ko");
  if (HAN.test(s) && !KANA.test(s)) langs.push("ja", "zh");
  return langs;
}

export function searchQuery(track, title = track.title) {
  return `${track.artists[0] ?? ""} ${coreTitle(title)}`.trim();
}
