# MVFinder

An HTTP API that takes a Spotify track, album or playlist and returns the matching
**YouTube Music song** (audio track) and **YouTube music video** for each track, as JSON.

```
GET /spotify/track/6khnYqsyOTFq1SgpCi3Ucx
GET /spotify/album/4m2880jivSbbyEGAKfITCa
GET /spotify/playlist/33YxQ9R7gaOhNOjA1nKph1
```

The path mirrors the Spotify URL: `https://open.spotify.com/playlist/33YxQ9R7gaOhNOjA1nKph1` →
`/spotify/playlist/33YxQ9R7gaOhNOjA1nKph1`.

## Run it

```sh
cp .env.example .env        # add SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
docker compose up -d --build
curl localhost:8080/spotify/track/6khnYqsyOTFq1SgpCi3Ucx
```

Or without compose:

```sh
docker build -t mvfinder .
docker run -d -p 8080:8080 -v mvfinder-data:/data \
  -e SPOTIFY_CLIENT_ID=... -e SPOTIFY_CLIENT_SECRET=... mvfinder
```

Keep the `/data` volume. It holds the Spotify track cache, the match cache, the Spotify
request counter and auto-updated versions of the YouTube library, so a restart costs no
requests. The service also runs without Spotify credentials, using Spotify's public embed pages
only. Matching is less accurate that way (no ISRCs).

## API

### `GET /spotify/{track|album|playlist}/{id}`

| Query parameter | Default | |
|---|---|---|
| `type` | `all` | `song` (YouTube Music audio track), `video` (music video) or `all` |
| `all` | off | Return every candidate above the threshold, ranked, instead of the best song + best video |
| `minConfidence` | `0.7` | Drop matches scoring below this (0–1) |
| `explain` | off | Add a per-match scoring breakdown |
| `pretty` | off | Indented JSON |

A track returns:

```json
{
  "source": {
    "service": "spotify", "type": "track", "id": "6khnYqsyOTFq1SgpCi3Ucx",
    "url": "https://open.spotify.com/track/6khnYqsyOTFq1SgpCi3Ucx",
    "title": "リモコン-NT ver.- (feat. 鏡音リン&鏡音レン)",
    "artists": ["Wonderful★opportunity!", "Kagamine Rin", "Kagamine Len"],
    "album": "リモコン-NT ver.-", "durationMs": 314142, "isrc": "JP92Q2503558",
    "metadataSource": "api"
  },
  "matches": [
    {
      "type": "song",
      "title": "リモコン-NT ver.- - remote controller-NT ver.- (feat. Kagamine Rin&Kagamine Len)",
      "artists": ["Wonderfulopportunity", "Kagamine Rin", "Kagamine Len"],
      "album": "Remote Controller-NT ver.-",
      "durationMs": 315000, "videoId": "b31SNbUxVTU",
      "url": "https://music.youtube.com/watch?v=b31SNbUxVTU",
      "youtubeUrl": "https://www.youtube.com/watch?v=b31SNbUxVTU",
      "youtubeMusicUrl": "https://music.youtube.com/watch?v=b31SNbUxVTU",
      "confidence": 1, "matchedBy": "isrc"
    },
    {
      "type": "music_video",
      "title": "リモコン -NT ver.-/ 鏡音リンレンNT - ワンオポ",
      "artists": ["Wonderfulopportunity"],
      "durationMs": 314000, "videoId": "9OBmDkSlkrQ",
      "url": "https://www.youtube.com/watch?v=9OBmDkSlkrQ",
      "youtubeUrl": "https://www.youtube.com/watch?v=9OBmDkSlkrQ",
      "youtubeMusicUrl": "https://music.youtube.com/watch?v=9OBmDkSlkrQ",
      "confidence": 0.89, "matchedBy": "search"
    }
  ]
}
```

Albums and playlists return `{ "source": {...}, "tracks": [ { "source": track, "matches": [...] }, ... ] }`.
If one track's search fails, that track gets an `"error"` and the rest still return.

`url` points to each match type's natural home (YouTube Music for songs, YouTube for videos),
and both URLs are always included. `matchedBy` is `isrc` for a match on the recording's ISRC
code and `search` for one found by searching for artist and title.

#### Match types

| `type` | Meaning |
|---|---|
| `song` | YouTube Music audio track (album art, no video) |
| `music_video` | Official music video |
| `lyric_video` / `visualizer` | Official lyric video / visualizer |
| `official_audio` | Official static "audio" upload on regular YouTube |
| `official_video` | Other official upload, e.g. a live performance |
| `user_video` | User upload (only with `all`) |

If a track has no music video, an official lyric, visualizer or live upload is returned instead,
but only when it's clearly the same song (confidence ≥ 0.75).

#### Album and playlist `source` fields

| Field | |
|---|---|
| `trackCount` | Tracks returned |
| `totalTracks` | Tracks Spotify says the album or playlist has (`null` if unknown) |
| `truncated` | `true`/`false`, or `null` if unknown. See [Limitations](#limitations) |
| `metadataSource` / `trackListSource` | `api` or `embed`: where the data came from |

#### Errors

`{"error": {"status": 404, "source": "spotify", "message": "Spotify track … not found"}}`, with status
`400` for bad parameters, `404` for an unknown route or Spotify item, `502` when Spotify or YouTube
failed, and `503` when no working YouTube library is loaded yet.

### `GET /health`

Returns `200` when healthy and `503` when degraded. The body shows the YouTube library version in
use, where it came from (`baseline` = baked into the image, `updated` = installed at runtime), and
the results of the last update check and self-test. It also shows Spotify API usage:
`requestsLast24h`, `dailyRequestBudget`, `rateLimitedUntil`, `cachedTracks`, and `apiUnavailable`
(why the API is currently unused, if it is). Docker's `HEALTHCHECK` uses this endpoint.
Every response also includes an `X-YouTube-Client` header such as `youtubei.js@18.3.0`.

## How it works

**Spotify.** Development Mode apps get roughly 750 Web API requests a day. Going over can
mean hours of `429` responses, and the allowance is shared with any other tool using the same
app. So the service spends as few requests as possible:

- **Album and playlist track lists come from the public embed page, which costs no API
  requests.** Since February 2026 the API won't list playlists your app doesn't own anyway. For
  lists that reach the embed page's 100-track cap, the real total comes from the public page.
- **The API is used only per track, at most once per track.** Each lookup fetches the ISRC and
  the canonical names, and records are cached on disk, so repeated or overlapping playlists, and
  restarts, cost nothing. Concurrent requests for the same track share one lookup. A "not found"
  answer is cached for 1 day and then checked again, in case the problem was temporary.
- **Requests are paced and counted against a daily budget** (`SPOTIFY_DAILY_REQUEST_BUDGET`,
  default 250). When the budget is used up, or Spotify answers `429` with a long `Retry-After`,
  the service stops calling the API until it's allowed again, and remembers this across
  restarts. Matching carries on without ISRCs, and those results are cached for only 1 hour.

Typical cost: about 1 request per track never seen before, plus 1 for a token per hour. A
45-track playlist costs about 46 requests the first time and 0 after that.

**YouTube** search uses [youtubei.js](https://github.com/LuanRT/YouTube.js), an unofficial
client for YouTube's internal API. Each result carries YouTube's own classification: audio
track, official video or user upload.

**Matching** for each track:
1. The track's **ISRC** (a code that identifies the exact recording) is searched on YouTube Music.
   The top result is accepted only if its duration agrees and its artist or title matches.
   ISRC search results vary between YouTube sessions, so a failed check is retried on up to four
   more sessions. Those sessions are replaced every 30 minutes, so a later retry doesn't hit the
   same ones.
   Sometimes YouTube lists the song only under native names, such as 「ゼロトーキング」 by
   「はるまきごはん」 where Spotify has "Zero Talking" by "Harumakigohan", so the check fails. If
   such a result has the right length, the service asks Spotify for the track in that language
   (Japanese, Korean or Chinese), adds the native names as aliases, and checks again.
2. Otherwise, the song is found by searching for artist and title. Candidates are scored on title
   similarity (45%), artist (35%) and duration (20%), with penalties for live, remix, cover,
   sped-up and similar versions that the Spotify title doesn't mention.
3. The music video is found the same way. The YouTube title and artist name of the song from
   step 1 count as aliases, so a video titled 「アイスドロップ」 matches Spotify's "Ice Drop".
   Videos titled "Official Video" beat untitled cuts. YouTube tags many static "Official Audio"
   uploads as official videos; those are detected by title and never returned as the music video.

Matches are cached per track on disk for 24 h. Misses, and results computed without the ISRC,
are cached for 1 h. YouTube searches are capped at 4 at a time across all requests.

## Automatic YouTube library updates

YouTube changes its internal API often, and youtubei.js releases fixes, so the service updates the
library itself:

- The image includes a baseline version, so the service works even if npm is unreachable.
- At startup and every 6 h, the service checks npm for the newest version allowed by
  `YTJS_VERSION` and installs it into `/data/ytjs/<version>`.
- The new version is **switched in only after a live self-test passes**. The self-test is a real
  search that has to come back in the expected shape, which also checks this service's own
  parsing. The switch needs no restart and causes no downtime. A version that fails stays
  unused, and the reason appears in `/health`.
- A YouTube search error or a failed self-test triggers an immediate update check, at most once
  per 30 minutes.
- **Supply-chain guard:** only releases at least `YTJS_MIN_RELEASE_AGE_HOURS` (default 24) old are
  used, and their dependencies are held to the same age (`npm install --before`), so a
  hijacked release that gets pulled quickly never reaches the container. Install scripts are
  disabled. You still run new third-party code without reviewing it. Pin
  `YTJS_VERSION=18.3.0` if you'd rather update by hand.
- The active version is remembered across restarts. The previous version is kept for rollback,
  and older ones are deleted.

## Configuration

| Variable | Default | |
|---|---|---|
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | — | From the [Spotify dashboard](https://developer.spotify.com/dashboard) |
| `SPOTIFY_DAILY_REQUEST_BUDGET` | `250` | Max Spotify API requests per rolling 24 h. Leave room for other tools on the same app |
| `SPOTIFY_MAX_REQUESTS_PER_SECOND` | `3` | Pacing for Spotify API requests |
| `PORT` | `8080` | |
| `YTJS_VERSION` | `latest` | `latest`, a major version (`18`), or an exact version (`18.3.0`) |
| `YTJS_MIN_RELEASE_AGE_HOURS` | `24` | Minimum age of a youtubei.js release before it's used |
| `YTJS_UPDATE_INTERVAL_HOURS` | `6` | How often to self-test and check for updates |
| `YT_CONCURRENCY` | `4` | Concurrent YouTube searches, across all requests |
| `YT_LOCATION` | `US` | YouTube region |
| `CACHE_TTL_HOURS` / `CACHE_MAX_ENTRIES` | `24` / `20000` | Per-track match cache (on disk) |
| `DATA_DIR` | `/data` | Caches, request counter and auto-updated library versions |

`YTJS_VERSION` and `YTJS_MIN_RELEASE_AGE_HOURS` are also build args, which control the baseline
version baked into the image.

## Limitations

- **Albums and playlists are capped at 100 tracks.** The embed page lists at most 100 tracks;
  `totalTracks` and `truncated` say whether the list was cut off (`null` if the total couldn't be
  read).
- **Spotify Development Mode** apps need the app owner to have Spotify Premium (since Feb 2026),
  and get a small daily request allowance (see [How it works](#how-it-works)).
- **YouTube is unofficial.** If YouTube breaks youtubei.js, `/health` turns `503` and searches
  return `502` until a fixed release is published and passes the self-test. Spotify's embed
  page is also unofficial. The Web API is the primary source for single tracks and for ISRCs.
- The first request for a playlist takes roughly 0.3–0.7 s per track. Spotify lookups are paced
  at 3 per second, and YouTube searches run 4 at a time. That's about 15–30 s for 45 new tracks;
  cached tracks return almost instantly.

## Development

Needs Node 22+.

```sh
npm test                                          # offline unit tests
node src/ytjs-package.js install .ytjs            # local baseline youtubei.js
YTJS_BASELINE_DIR=.ytjs DATA_DIR=.data PORT=8081 npm start
```
