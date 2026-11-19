// X + Facebook + direct-file pure-helper tests — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { extractTweetId, mapXVariants, extractXVariants } from "../platforms/x.js";
import { extractFacebookVideoId, parsePlayableUrls } from "../platforms/facebook.js";
import { extFromContentType, fileNameFromUrl } from "../platforms/direct.js";

test("extractTweetId handles x.com and twitter.com", () => {
  assert.equal(extractTweetId("https://x.com/someone/status/1234567890123456789"), "1234567890123456789");
  assert.equal(extractTweetId("https://twitter.com/a/status/42?s=20"), "42");
  assert.equal(extractTweetId("https://x.com/a/status/"), null);
});

test("mapXVariants labels by resolution from the URL and sorts by bitrate", () => {
  const q = mapXVariants([
    { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1/vid/640x360/a.mp4", bitrate: 832000 },
    { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1/vid/1280x720/b.mp4", bitrate: 2176000 },
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/1/pu/pl/c.m3u8", bitrate: 0 },
    { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1/vid/320x180/c.mp4", bitrate: 288000 },
  ]);
  assert.equal(q.length, 3); // m3u8 variant excluded
  assert.equal(q[0].label, "720p");
  assert.equal(q[1].label, "360p");
  assert.equal(q[2].label, "180p");
  assert.ok(q.every((v) => v.ext === "mp4"));
});

test("mapXVariants handles the live {type, src} shape (no bitrates, sorted by height)", () => {
  // Real shape from the SpaceX Starship-catch tweet, 2026-11-19.
  const q = mapXVariants([
    { type: "application/x-mpegURL", src: "https://video.twimg.com/amplify_video/1/pl/x.m3u8?v=cfc" },
    { type: "video/mp4", src: "https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4" },
    { type: "video/mp4", src: "https://video.twimg.com/amplify_video/1/vid/avc1/3840x2160/b.mp4" },
    { type: "video/mp4", src: "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/c.mp4" },
  ]);
  assert.equal(q.length, 3); // m3u8 variant excluded
  assert.deepEqual(q.map((v) => v.label), ["2160p", "720p", "270p"]);
});

test("extractXVariants prefers video.variants, falls back to mediaDetails", () => {
  const live = { video: { variants: [{ type: "video/mp4", src: "https://video.twimg.com/a.mp4" }] }, mediaDetails: [] };
  assert.equal(extractXVariants(live).length, 1);
  const old = { mediaDetails: [{ video_info: { variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/b.mp4" }] } }] };
  assert.equal(extractXVariants(old)[0].url, "https://video.twimg.com/b.mp4");
  assert.deepEqual(extractXVariants({}), []);
});

test("extractFacebookVideoId handles watch / reel / fb.watch", () => {
  assert.equal(extractFacebookVideoId("https://www.facebook.com/watch/?v=123456789"), "123456789");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/reel/987654321"), "987654321");
  assert.equal(extractFacebookVideoId("https://fb.watch/AbCdEfGh/"), "AbCdEfGh");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/somepage"), null);
});

test("parsePlayableUrls unescapes the JSON-escaped URLs", () => {
  const html = `{"playable_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/sd.mp4","playable_url_quality_hd":"https:\\/\\/video.xx.fbcdn.net\\/v\\/hd.mp4"}`;
  const out = parsePlayableUrls(html);
  assert.equal(out.sd, "https://video.xx.fbcdn.net/v/sd.mp4");
  assert.equal(out.hd, "https://video.xx.fbcdn.net/v/hd.mp4");
  assert.deepEqual(parsePlayableUrls("<html>no video here</html>"), {});
});

test("extFromContentType maps types and falls back to the URL path", () => {
  assert.equal(extFromContentType("video/mp4", "https://x.com/f"), "mp4");
  assert.equal(extFromContentType("audio/mpeg", "https://x.com/f"), "mp3");
  assert.equal(extFromContentType("application/octet-stream", "https://x.com/dl/archive.zip"), "zip");
  assert.equal(extFromContentType("", "https://x.com/dl/clip.webm"), "webm");
  assert.equal(extFromContentType("application/octet-stream", "https://x.com/dl/noext"), "bin");
});

test("fileNameFromUrl decodes the last path segment", () => {
  assert.equal(fileNameFromUrl("https://x.com/files/My%20Video.mp4?token=1"), "My Video.mp4");
  assert.equal(fileNameFromUrl("https://x.com/"), "file");
});
