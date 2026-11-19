// YouTube mapping tests — no network; fake streaming_data shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { extractVideoId, getInnertubeOptions, mapYouTubeFormats } from "../platforms/youtube.js";

test("extractVideoId handles every URL form", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=30"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=short"), null);
  assert.equal(extractVideoId("not a url"), null);
});

const STREAMING = {
  formats: [
    { itag: 18, mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', quality_label: "360p", height: 360, url: "https://rr1---.googlevideo.com/18", content_length: "123456" },
    { itag: 22, mime_type: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', quality_label: "720p", height: 720, url: "https://rr1---.googlevideo.com/22", content_length: "234567" },
  ],
  adaptive_formats: [
    { itag: 137, mime_type: 'video/mp4; codecs="avc1.640028"', quality_label: "1080p", height: 1080, url: "https://rr1---.googlevideo.com/137", content_length: "345678" },
    { itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, url: "https://rr1---.googlevideo.com/140", content_length: "45678" },
    { itag: 251, mime_type: 'audio/webm; codecs="opus"', bitrate: 160000, url: "https://rr1---.googlevideo.com/251" },
    { itag: 999, mime_type: 'video/mp4; codecs="avc1.640028"', quality_label: "1080p", height: 1080 }, // no url — undeciphered, must be skipped
  ],
};

test("getInnertubeOptions passes YT_COOKIE through, empty without it", () => {
  const prev = process.env.YT_COOKIE;
  try {
    delete process.env.YT_COOKIE;
    assert.deepEqual(getInnertubeOptions(), {});
    process.env.YT_COOKIE = "  SID=abc; HSID=def  ";
    assert.deepEqual(getInnertubeOptions(), { cookie: "SID=abc; HSID=def" });
  } finally {
    if (prev === undefined) delete process.env.YT_COOKIE;
    else process.env.YT_COOKIE = prev;
  }
});

test("getInnertubeOptions passes YT_COOKIE through unchanged, SAPISID included", () => {
  const prev = process.env.YT_COOKIE;
  try {
    process.env.YT_COOKIE =
      "SID=abc; SAPISID=xyz; __Secure-1PAPISID=xyz; HSID=def";
    // SAPISID must stay: youtubei.js derives the SAPISIDHASH Authorization
    // header from it, and that header is what authenticates the request.
    // (A stripped cookie still hits the "Sign in to confirm you're not a
    // bot" wall live; the per-call client override was the 400 cause, and
    // the session-level client in getClient is the fix for that.)
    assert.deepEqual(getInnertubeOptions(), {
      cookie: "SID=abc; SAPISID=xyz; __Secure-1PAPISID=xyz; HSID=def",
    });
  } finally {
    if (prev === undefined) delete process.env.YT_COOKIE;
    else process.env.YT_COOKIE = prev;
  }
});

test("mapYouTubeFormats flags combined / video-only / audio-only", () => {
  const r = mapYouTubeFormats(STREAMING, { title: "Test", thumbnail: [{ url: "https://i.ytimg.com/t.jpg" }] });
  assert.equal(r.source, "youtube");
  assert.equal(r.title, "Test");
  assert.equal(r.thumbnail, "https://i.ytimg.com/t.jpg");
  assert.equal(r.qualities.length, 5);
  const combined = r.qualities.filter((q) => !q.videoOnly && !q.audioOnly);
  assert.equal(combined.length, 2);
  assert.equal(combined[0].label, "720p"); // best combined first
  assert.equal(combined[0].size, 234567);
  const videoOnly = r.qualities.filter((q) => q.videoOnly);
  assert.equal(videoOnly.length, 1);
  assert.match(videoOnly[0].label, /1080p \(video only\)/);
  const audio = r.qualities.filter((q) => q.audioOnly);
  assert.equal(audio.length, 2);
  assert.equal(audio.find((q) => q.id === "yt-140").ext, "mp4");
  assert.equal(audio.find((q) => q.id === "yt-251").ext, "webm");
  assert.match(audio.find((q) => q.id === "yt-140").label, /audio 128k/);
});
