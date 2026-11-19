# NOVA Downloader API

Central resolve API for the NOVA desktop and mobile downloaders. One API,
one domain, one endpoint per platform. The desktop and mobile apps call it
to resolve a public link into downloadable stream URLs — then they download
the bytes **directly from the CDN** themselves.

- Repo: https://github.com/irfan420x/nova-downloader-api
- Runtime: plain JavaScript (Node ≥ 20), no build step, no TypeScript.
- Hosting: Vercel serverless (one function, `index.js`) — and the same file
  runs standalone anywhere (`node index.js`).

## Design — the API returns JSON, NOT video bytes

This is a settled decision, not a limitation to work around:

- The API **resolves**: it returns JSON with a title and `qualities[]`
  (stream URL + the headers the client must send per quality). The
  desktop/mobile apps download the video bytes directly from the CDN
  (TikTok / YouTube / …) at full speed.
- The API must **not** proxy/stream video bytes in v1: Vercel serverless
  functions have a ~10s timeout on Hobby and strict response limits — a
  large video download through the function would time out or fail — and
  every byte through Vercel costs bandwidth (100 GB/month on Hobby). JSON
  responses are kilobytes; the heavy bytes never touch Vercel.
- Stream URLs expire (TikTok: minutes; YouTube: hours) — that is fine,
  because the client downloads immediately after resolving.
- Combined video+audio formats are returned where they exist, plus separate
  video-only / audio-only ones clearly flagged, so clients can pick or merge.
- There is **no byte-proxy / video-streaming endpoint in v1**. If some
  platform ever proves impossible to download directly from clients, that
  is a separate future decision, not this build.

## Endpoints

No auth in v1 — every endpoint is callable with plain `curl`.

| Endpoint | Platform | Body |
|---|---|---|
| `POST /youtube` | YouTube | `{ "url": "https://www.youtube.com/watch?v=…" }` |
| `POST /tiktok` | TikTok | `{ "url": "https://www.tiktok.com/@…/video/…" }` |
| `POST /facebook` | Facebook | `{ "url": "https://www.facebook.com/watch/?v=…" }` |
| `POST /x` | X (Twitter) | `{ "url": "https://x.com/…/status/…" }` |
| `POST /soundcloud` | SoundCloud | `{ "url": "https://soundcloud.com/…/…" }` |
| `POST /direct` | Direct file | `{ "url": "https://example.com/file.mp4" }` |
| `POST /hls` | HLS playlist | `{ "url": "https://example.com/master.m3u8" }` |
| `GET /api/health` | — | → `{ "ok": true }` |

Each endpoint only handles its own platform: a YouTube link sent to
`/tiktok` gets `400 UNSUPPORTED` with an honest message.

### Success response

```json
{
  "title": "Video title",
  "thumbnail": "https://…/thumb.jpg",
  "source": "tiktok",
  "qualities": [
    {
      "id": "tiktok-720p",
      "label": "720p",
      "ext": "mp4",
      "url": "https://v16-webapp-prime.us.tiktok.com/…",
      "alternates": ["https://v19-webapp-prime.us.tiktok.com/…"],
      "headers": { "User-Agent": "…", "Referer": "https://www.tiktok.com/", "Cookie": "ttwid=…; …" },
      "size": 12345678,
      "videoOnly": false,
      "audioOnly": false
    }
  ],
  "debug": {
    "platform": "tiktok",
    "ms": 2140,
    "attempts": [
      { "step": "page", "host": "www.tiktok.com", "status": 200, "cookies": 3, "cookieNames": ["ttwid", "tt_csrf_token", "tt_chain_token"], "ms": 812 },
      { "step": "probe", "host": "v16-webapp-prime.us.tiktok.com", "status": 206, "cookies": 3, "cookieNames": ["ttwid", "tt_csrf_token", "tt_chain_token"], "ms": 640 }
    ]
  }
}
```

### `debug` — failures are diagnosable from the response alone

This API exists so problems are caught by direct testing, not only on a
phone. Every response (success **and** error) carries `debug`:

- `platform` detected, `ms` total time taken.
- One entry per upstream attempt: `step` (page / probe / innertube / …),
  `host` (hostname only — never full stream URLs), upstream HTTP `status`,
  `cookies` (COUNT) and `cookieNames` (names only — **never values**).

This mirrors the mobile app's v1.0.7 per-file log
(`probe: host=<host> cookies=<n>`, `trying next URL`).

### Error response

```json
{ "error": { "code": "UNSUPPORTED", "message": "This is not a tiktok URL — the /tiktok endpoint only handles tiktok links." }, "debug": { … } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `UNSUPPORTED` | 400 | Wrong endpoint for this URL, or the link has no downloadable media |
| `NOT_FOUND` | 404 | Video / post / track not found, private, or deleted |
| `BLOCKED` | 502 | The platform blocked the request (bot check / login wall) |
| `UPSTREAM_ERROR` | 502 | Upstream failed, timed out, or returned something unreadable |

The API never returns a web page as a download (`/direct` refuses
`text/html`).

## TikTok — what the mobile app learned the hard way

Proven on real links (mobile v1.0.6/v1.0.7):

- The page sets session cookies (`ttwid`, `tt_csrf_token`,
  `tt_chain_token`, all `Domain=.tiktok.com`). The client **must** send
  them back — they are returned in each quality's `headers.Cookie`.
- The `UrlList` has several CDN hosts (`v16-webapp-prime`,
  `v19-webapp-prime`, `www.tiktok.com`). **v19 works with cookies alone;
  v16 needs cookies + `Referer: https://www.tiktok.com/`**, and its HEAD
  fails (403/404/504) while ranged GET serves. So the API returns **all**
  UrlList entries — never just the first — with cookies + Referer attached,
  and the client tries each URL in turn. Every returned URL is also
  probe-checked by the API (HEAD, ranged-GET fallback) and working ones
  sort first.

## YouTube — what it took (2026-11-19)

Proven live against `dQw4w9WgXcQ` (27 formats, all with real googlevideo
URLs, probes 206):

- **The WEB client returns SABR formats with no usable URL.** In 2026 the
  adaptive formats carry neither `url` nor `signature_cipher` — only a
  `server_abr_streaming_url` (SABR protocol, not a plain download).
  The `TV_SIMPLY` client still returns classic formats with plain URLs /
  `signature_cipher` for all of them, so the resolver uses
  `getBasicInfo(videoId, { client: "TV_SIMPLY" })`.
- **`getBasicInfo`, not `getInfo`.** `getInfo`'s watch-next parse crashes
  youtubei.js for non-WEB clients (`VideoInfo.js`: `item().as(...)` on
  null). The player-only call skips that path and still returns title +
  thumbnail.
- **youtubei.js v18 needs a JS evaluator to decipher.** It ships a
  throwing stub (`Platform.shim.eval`); the API installs a Node `vm`
  evaluator so `format.decipher(player)` works. Formats that still fail
  to decipher are dropped by the mapper.
- **The session player is required.** `retrieve_player: false` makes
  YouTube return a player response with ZERO formats — the
  `signatureTimestamp` from the session player must be sent.
- **Probing is sampled.** All 27 URLs share one googlevideo host and one
  expiry, and 27 parallel probes stall the egress, so only the first 3
  are probe-checked (straight to ranged GET — googlevideo HEAD takes ~3s
  from this VM). Cold resolve ~7.6s, warm ~3s — inside Vercel's 10s
  Hobby limit.

## X — live syndication shape (2026-11-19)

- The endpoint is `cdn.syndication.twimg.com/tweet-result?id=<id>&token=a`
  — the `token=a` param is **required**: `lang=en` alone returns 200
  with an empty `{}`.
- The video lives in top-level `video.variants[]` (`{type, src}`), MP4s
  from 270p to 2160p plus one `application/x-mpegURL` entry (skipped);
  `video.poster` is the thumbnail. The older
  `mediaDetails[].video_info.variants` shape is still accepted as a
  fallback. Verified on the SpaceX Starship-catch tweet: 5 qualities,
  all probes 200, ~2.3s.

## SoundCloud — client_id extraction (2026-11-19)

- The `client_id` is **not** hardcoded (they go stale). It is scraped
  from the SoundCloud web client at runtime and cached per warm
  instance. It lives in the LAST bundle (`55-*.js`, ~3MB) — fetching
  only the first few bundles misses it, so all `a-v2.sndcdn.com`
  bundles are fetched in parallel.
- SoundCloud HLS transcodings return **media** playlists (segment
  lists), not master playlists — the m3u8 URL itself is returned as
  one quality (`aac 160k` / `aac 96k` from the preset). Cold resolve
  ~8.7s (bundle downloads), warm ~3–4s — inside Vercel's 10s limit.

## Facebook — blocked from datacenter IPs (2026-11-19)

- `mbasic.facebook.com` and `www.facebook.com` both return an HTTP
  400 error page from this VM's IP (and the mobile app already saw
  IG/FB reels blocked the same way). The resolver reports this
  honestly as `BLOCKED` — no login, no cookies, no workaround in v1.
  Re-tested from Vercel after deploy; if it is blocked there too, that
  is the honest v1 answer for Facebook.

## Self-hosting

Anyone can run this API themselves — no Vercel account needed, no env vars
required for basic use.

```bash
git clone https://github.com/irfan420x/nova-downloader-api.git
cd nova-downloader-api
npm install
npm start
# NOVA Downloader API listening on http://localhost:3000
```

`PORT` env var overrides the port (default 3000):

```bash
PORT=8080 npm start
```

Try it:

```bash
curl http://localhost:3000/api/health
# {"ok":true}

curl -X POST http://localhost:3000/tiktok \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.tiktok.com/@zachking/video/6768504823336815877"}'
```

## Deploying to Vercel

`index.js` is also the Vercel serverless handler (`api/index.js`
re-exports it) and `vercel.json` rewrites the clean paths
(`/tiktok`, `/youtube`, …) to the single function.

- Dashboard: import the repo `irfan420x/nova-downloader-api` into Vercel
  (framework preset: Other; no build command; no env vars needed).
- Or CLI: `npx vercel --prod` from the repo root.

## Layout

```
index.js            # main entry: routing + Vercel handler + standalone server
api/index.js        # Vercel entry — re-exports index.js
platforms/          # one module per platform (resolver only for that platform)
  youtube.js tiktok.js facebook.js x.js soundcloud.js direct.js hls.js
lib/                # shared helpers
  errors.js http.js detect.js respond.js debug.js probe.js
tests/              # node:test, no network except local loopback (probe test)
vercel.json         # single function, maxDuration 10, clean-path rewrites
```

## Tests

```bash
npm test   # node --test — 41 tests, all green
```

Unit tests cover the parsers (TikTok rehydration JSON incl. multi-host
UrlList, m3u8 variants, YouTube format mapping, X variants, Facebook
playable URLs, direct-file extension/content-type rules), the strict
per-platform routing, the debug object (hostnames only, cookie names only),
and stream probing against a local server (incl. the TikTok v16 case:
HEAD 403 → ranged GET 206).
