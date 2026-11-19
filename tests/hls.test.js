// HLS playlist parser tests — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseM3u8 } from "../platforms/hls.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="audio"
1080p.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"
`;

test("parseM3u8 returns one quality per variant with resolved URLs", () => {
  const q = parseM3u8(MASTER, "https://cdn.example.com/hls/master.m3u8");
  assert.equal(q.length, 3);
  assert.equal(q[0].label, "360p");
  assert.equal(q[0].url, "https://cdn.example.com/hls/360p.m3u8");
  assert.equal(q[0].videoOnly, false); // mp4a in codecs -> combined
  assert.equal(q[1].label, "720p");
  assert.equal(q[2].label, "1080p");
  // AUDIO group + no mp4a in codecs -> video-only.
  assert.equal(q[2].videoOnly, true);
});

test("parseM3u8 falls back to bandwidth label without resolution", () => {
  const q = parseM3u8(
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\nlow.m3u8\n`,
    "https://x.example.com/a/master.m3u8",
  );
  assert.equal(q.length, 1);
  assert.equal(q[0].label, "1500k");
  assert.equal(q[0].url, "https://x.example.com/a/low.m3u8");
});

test("parseM3u8 returns [] for a media playlist", () => {
  const q = parseM3u8(
    `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n`,
    "https://x.example.com/a/media.m3u8",
  );
  assert.deepEqual(q, []);
});
