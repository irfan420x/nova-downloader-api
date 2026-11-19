// TikTok parser tests — no network; fixtures copy the REAL page JSON shape
// (verified against a live TikTok page 2026-11-19):
//   video.playAddr is a STRING; per-quality URLs live in
//   video.bitrateInfo[].PlayAddr.UrlList (capital U); GearName looks like
//   "normal_540_0" — the label comes from Width/Height (smaller dimension).
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractRehydrationJson,
  findTikTokVideo,
  buildTikTokQualities,
  matchJsonEnd,
  heightFromGearName,
} from "../platforms/tiktok.js";
import { DebugLog } from "../lib/debug.js";

const VIDEO = {
  playAddr: "https://v16-webapp-prime.us.tiktok.com/video/1/play",
  width: 576,
  height: 1090,
  bitrateInfo: [
    {
      Bitrate: 1916581,
      GearName: "normal_540_0",
      PlayAddr: {
        DataSize: "4392325",
        Width: 576,
        Height: 1090,
        UrlList: [
          "https://v16-webapp-prime.us.tiktok.com/video/1/540p",
          "https://v19-webapp-prime.us.tiktok.com/video/1/540p",
          "https://www.tiktok.com/@u/video/1/540p",
        ],
      },
    },
    {
      Bitrate: 1371670,
      GearName: "adapt_lowest_1080_1",
      PlayAddr: {
        DataSize: "3143526",
        Width: 1080,
        Height: 2044,
        UrlList: ["https://v16-webapp-prime.us.tiktok.com/video/1/1080p"],
      },
    },
    // Same height as the first entry, lower bitrate — must lose the dedupe.
    {
      Bitrate: 1041603,
      GearName: "lower_540_0",
      PlayAddr: {
        DataSize: "2387095",
        Width: 576,
        Height: 1090,
        UrlList: ["https://v16-webapp-prime.us.tiktok.com/video/1/540p-low"],
      },
    },
    { Bitrate: 0, GearName: "empty_0", PlayAddr: { UrlList: [] } }, // skipped
  ],
  cover: "https://p16-sign.tiktokcdn.com/cover.jpg",
  originCover: "https://p16-sign.tiktokcdn.com/origin.jpg",
};

test("matchJsonEnd ignores braces inside strings", () => {
  const text = `{"a": "} { \\" }", "b": {"c": 1}} trailing`;
  assert.equal(matchJsonEnd(text, 0), text.indexOf("} trailing") - 0 + 0);
  assert.equal(JSON.parse(text.slice(0, matchJsonEnd(text, 0) + 1)).b.c, 1);
});

test("extractRehydrationJson finds the script-tag JSON", () => {
  const inner = JSON.stringify({
    __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: { video: VIDEO, desc: "hi" } } } },
  });
  const html = `<html><head></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${inner}</script></body></html>`;
  const data = extractRehydrationJson(html);
  assert.ok(data);
  assert.equal(data.__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.desc, "hi");
});

test("extractRehydrationJson returns null on a bot-check page", () => {
  assert.equal(extractRehydrationJson("<html><body>verify you are human</body></html>"), null);
});

test("heightFromGearName pulls the resolution number out", () => {
  assert.equal(heightFromGearName("normal_540_0"), 540);
  assert.equal(heightFromGearName("adapt_lowest_1080_1"), 1080);
  assert.equal(heightFromGearName(""), 0);
});

test("findTikTokVideo finds the video via bitrateInfo (playAddr is a string)", () => {
  const found = findTikTokVideo({
    __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: { video: VIDEO, desc: "dance video" } } } },
  });
  assert.ok(found);
  assert.equal(found.desc, "dance video");
  assert.equal(found.video.bitrateInfo.length, 4);
  assert.equal(findTikTokVideo({ nothing: { here: 1 } }), null);
  // playAddr string alone is enough for the fallback path.
  assert.ok(findTikTokVideo({ video: { playAddr: "https://v16/x.mp4" } }));
});

test("buildTikTokQualities returns ALL UrlList hosts, never just the first", () => {
  const cookie = "ttwid=abc; tt_csrf_token=def; tt_chain_token=ghi";
  const qualities = buildTikTokQualities(VIDEO, cookie);
  assert.equal(qualities.length, 2);
  // Best (tallest) first; label is the smaller dimension.
  assert.equal(qualities[0].label, "1080p");
  const q540 = qualities.find((q) => q.label === "576p");
  assert.ok(q540);
  // First URL is v16, alternates keep v19 + www — the client tries each.
  assert.match(q540.url, /v16-webapp-prime/);
  assert.equal(q540.alternates.length, 2);
  assert.match(q540.alternates[0], /v19-webapp-prime/);
  assert.match(q540.alternates[1], /www\.tiktok\.com/);
  // Highest bitrate won the 1090-height dedupe; size comes from DataSize.
  assert.equal(q540.size, 4392325);
  // Headers: cookies + Referer on every quality (v16 needs both).
  assert.equal(q540.headers.Cookie, cookie);
  assert.equal(q540.headers.Referer, "https://www.tiktok.com/");
  assert.ok(q540.headers["User-Agent"].includes("Chrome/"));
  assert.equal(qualities[0].headers.Cookie, cookie);
});

test("buildTikTokQualities falls back to the playAddr string", () => {
  const qualities = buildTikTokQualities(
    { playAddr: "https://v16-webapp-prime.us.tiktok.com/video/1/play", width: 576, height: 1090 },
    undefined,
  );
  assert.equal(qualities.length, 1);
  assert.equal(qualities[0].label, "576p");
  assert.equal(qualities[0].url, "https://v16-webapp-prime.us.tiktok.com/video/1/play");
  assert.equal(qualities[0].headers.Cookie, undefined);
});

test("DebugLog records hostnames only, cookie names only, never values", () => {
  const dbg = new DebugLog("tiktok");
  dbg.attempt("page", "https://www.tiktok.com/@u/video/123", 200, "ttwid=SECRET; tt_csrf_token=SECRET2", 123);
  const out = dbg.finish();
  assert.equal(out.platform, "tiktok");
  assert.equal(typeof out.ms, "number");
  assert.equal(out.attempts.length, 1);
  const a = out.attempts[0];
  assert.equal(a.host, "www.tiktok.com");
  assert.equal(a.status, 200);
  assert.equal(a.cookies, 2);
  assert.deepEqual(a.cookieNames, ["ttwid", "tt_csrf_token"]);
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  assert.equal(JSON.stringify(out).includes("video/123"), false);
});
