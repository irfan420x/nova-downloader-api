// Platform detection + per-endpoint validation tests — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, requirePlatform } from "../lib/detect.js";

test("detectPlatform identifies each platform host", () => {
  assert.equal(detectPlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
  assert.equal(detectPlatform("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(detectPlatform("https://www.tiktok.com/@u/video/123"), "tiktok");
  assert.equal(detectPlatform("https://vm.tiktok.com/abc/"), "tiktok");
  assert.equal(detectPlatform("https://www.facebook.com/watch/?v=1"), "facebook");
  assert.equal(detectPlatform("https://fb.watch/abc/"), "facebook");
  assert.equal(detectPlatform("https://x.com/u/status/1"), "x");
  assert.equal(detectPlatform("https://twitter.com/u/status/1"), "x");
  assert.equal(detectPlatform("https://soundcloud.com/artist/track"), "soundcloud");
  assert.equal(detectPlatform("https://example.com/file.mp4"), "direct");
  assert.equal(detectPlatform("https://example.com/hls/master.m3u8"), "hls");
});

test("requirePlatform accepts a platform's own URLs", () => {
  requirePlatform("https://youtu.be/dQw4w9WgXcQ", "youtube");
  requirePlatform("https://www.tiktok.com/@u/video/1", "tiktok");
  requirePlatform("https://example.com/file.mp4", "direct");
  requirePlatform("https://example.com/master.m3u8", "hls");
});

test("requirePlatform rejects other platforms' URLs with UNSUPPORTED", () => {
  assert.throws(() => requirePlatform("https://www.tiktok.com/@u/video/1", "youtube"), (e) => e.code === "UNSUPPORTED" && e.status === 400);
  assert.throws(() => requirePlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "tiktok"), (e) => e.code === "UNSUPPORTED");
  assert.throws(() => requirePlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "direct"), (e) => e.code === "UNSUPPORTED");
  assert.throws(() => requirePlatform("https://example.com/file.mp4", "hls"), (e) => e.code === "UNSUPPORTED");
  assert.throws(() => requirePlatform("not a url", "youtube"), (e) => e.code === "UNSUPPORTED");
});
