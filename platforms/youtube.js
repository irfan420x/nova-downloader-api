// YouTube resolver via youtubei.js (Innertube).
// Returns combined video+audio formats where available plus separate
// video-only / audio-only ones, clearly flagged.
// Every returned format URL is probe-checked and working ones sort first;
// probes are recorded in debug. Only a representative sample is probed:
// all of YouTube's formats share one googlevideo host and one expiry, and
// probing all 27 in parallel stalls the egress (see lib/probe.js).

import vm from "node:vm";
import { Innertube, Player, Platform } from "youtubei.js";
import { notFound, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

// youtubei.js v18 ships a throwing stub JS evaluator, so signature /
// n-sig deciphering fails ("you must provide your own JavaScript
// evaluator"). Provide a Node `vm` evaluator: Player.decipher calls
// Platform.shim.eval with the extracted player code ending in
// `return process(...)`; wrapping it in a function makes that return
// legal and returns { sig, n }.
if (typeof Platform.shim.eval !== "function" || Platform.shim.eval.name === "evaluate") {
  Platform.shim.eval = async (data) => {
    const sandbox = { URL };
    vm.createContext(sandbox);
    const script = new vm.Script(`(function(){\n${data.output}\n})()`, { timeout: 5000 });
    return script.runInContext(sandbox);
  };
}

// The WEB client returns SABR formats with NO usable URL in 2026 (the
// adaptive formats have neither `url` nor `signature_cipher` — only a
// server_abr_streaming_url). The TV_SIMPLY client still returns classic
// formats with plain URLs / signature_cipher for all 27 formats of a
// test video. getBasicInfo (player-only) is used instead of getInfo:
// getInfo's watch-next parse crashes youtubei.js for non-WEB clients
// (VideoInfo.js: `item().as(...)` on null).
const YT_CLIENT = "TV_SIMPLY";

// Warm-instance caches: Innertube.create() and Player.create() are slow on
// a cold start, so a warm serverless instance reuses them for later calls.
let ytClient = null;
async function getClient() {
  // NOTE: retrieve_player:false is NOT an option — without the session
  // player's signatureTimestamp YouTube returns a player response with
  // ZERO formats. The session downloads base.js once; deciphering uses
  // our own cached Player (a second base.js download on cold start only).
  if (!ytClient) ytClient = await Innertube.create();
  return ytClient;
}

let ytPlayer = null;
async function getPlayer() {
  if (!ytPlayer) ytPlayer = await Player.create();
  return ytPlayer;
}

/** Extract the 11-char video id from any YouTube URL form. */
export function extractVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  const m = u.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[2] : null;
}

function extFromMime(mime) {
  if (!mime) return "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("mp3") || mime.includes("mpeg")) return "mp3";
  return "mp4";
}

function hasAudioCodec(mime) {
  return mime.includes("mp4a") || mime.includes("opus") || mime.includes("vorbis");
}

/** Map youtubei.js streaming data (plain shape) to the quality list.
 *  Pure — unit-tested without network. Accepts both snake_case and
 *  camelCase property names because youtubei.js versions differ. */
export function mapYouTubeFormats(streamingData, basicInfo) {
  const pick = (f, snake, camel) => f[snake] ?? f[camel];
  const qualities = [];
  const combined = streamingData?.formats ?? [];
  const adaptive = streamingData?.adaptiveFormats ?? streamingData?.adaptive_formats ?? [];

  for (const f of combined) {
    const mime = pick(f, "mime_type", "mimeType") || "";
    if (!mime.startsWith("video/")) continue;
    if (!f.url) continue; // undeciphered / unusable format
    const height = Number(pick(f, "height", "height") || 0);
    const label = pick(f, "quality_label", "qualityLabel") || (height ? `${height}p` : "video");
    qualities.push({
      id: `yt-${f.itag}`,
      label,
      ext: extFromMime(mime),
      url: f.url,
      size: Number(pick(f, "content_length", "contentLength") || 0) || undefined,
    });
  }
  for (const f of adaptive) {
    const mime = pick(f, "mime_type", "mimeType") || "";
    const url = f.url;
    if (!url) continue;
    if (mime.startsWith("video/")) {
      if (hasAudioCodec(mime)) continue; // combined adaptive — already covered above
      const height = Number(pick(f, "height", "height") || 0);
      const label = pick(f, "quality_label", "qualityLabel") || (height ? `${height}p` : "video");
      qualities.push({
        id: `yt-${f.itag}`,
        label: `${label} (video only)`,
        ext: extFromMime(mime),
        url,
        size: Number(pick(f, "content_length", "contentLength") || 0) || undefined,
        videoOnly: true,
      });
    } else if (mime.startsWith("audio/")) {
      const bitrate = Number(pick(f, "bitrate", "bitrate") || 0);
      qualities.push({
        id: `yt-${f.itag}`,
        label: bitrate ? `audio ${Math.round(bitrate / 1000)}k` : "audio",
        ext: extFromMime(mime),
        url,
        size: Number(pick(f, "content_length", "contentLength") || 0) || undefined,
        audioOnly: true,
      });
    }
  }
  // Best first: combined by height desc, then video-only, then audio.
  const heightOf = (q) => {
    const m = q.label.match(/^(\d+)p/);
    return m ? Number(m[1]) : 0;
  };
  qualities.sort((a, b) => {
    const rank = (q) => (q.videoOnly ? 1 : q.audioOnly ? 2 : 0);
    return rank(a) - rank(b) || heightOf(b) - heightOf(a);
  });
  return {
    title: basicInfo?.title || "YouTube video",
    thumbnail: basicInfo?.thumbnail?.[0]?.url || undefined,
    source: "youtube",
    qualities,
  };
}

/** One full Innertube lookup: player response -> decipher -> mapped qualities.
 *  Records the attempt and format counts in dbg so a zero-format failure is
 *  diagnosable from the response alone. Throws notFound/upstream on lookup
 *  failure; returns the mapped result (possibly with zero qualities) otherwise. */
async function lookupFormats(id, dbg) {
  const lookupStart = Date.now();
  let info;
  try {
    const yt = await getClient();
    info = await yt.getBasicInfo(id, { client: YT_CLIENT });
  } catch (err) {
    dbg.attempt("innertube", "https://www.youtube.com/", 0, undefined, Date.now() - lookupStart);
    const message = String(err?.message || err);
    if (/not found|private|unavailable|deleted/i.test(message)) {
      throw notFound("YouTube video not found, private, or unavailable");
    }
    throw upstream(`YouTube lookup failed: ${message.slice(0, 120)}`);
  }
  dbg.attempt("innertube", "https://www.youtube.com/", 200, undefined, Date.now() - lookupStart);
  const streamingData = info.streaming_data ?? info.streamingData ?? {};
  const basicInfo = info.basic_info ?? info.basicInfo ?? {};
  const playability =
    info.playability_status?.status ?? basicInfo.playability_status ?? "unknown";
  // Formats arrive ciphered (no usable URL) — decipher every format's
  // URL with the player script before mapping. Undecipherable formats
  // are dropped by the mapper (it skips formats without a URL).
  const player = await getPlayer();
  const allFormats = [
    ...(streamingData.formats ?? []),
    ...(streamingData.adaptiveFormats ?? streamingData.adaptive_formats ?? []),
  ];
  let deciphered = 0;
  await Promise.all(
    allFormats.map(async (f) => {
      try {
        f.url = await f.decipher(player);
        if (f.url) deciphered += 1;
      } catch {
        f.url = f.url || "";
      }
    }),
  );
  const result = mapYouTubeFormats(streamingData, basicInfo);
  dbg.note({
    playability,
    formatsIn: allFormats.length,
    deciphered,
    qualities: result.qualities.length,
  });
  return result;
}

export async function resolveYouTube(url) {
  return withDebug("youtube", async (dbg) => {
    const id = extractVideoId(url);
    if (!id) throw notFound("Could not find a video id in this YouTube link");
    let result = await lookupFormats(id, dbg);
    if (result.qualities.length === 0) {
      // A warm serverless instance reuses its Innertube session; when
      // YouTube rotates the player the stale session's signatureTimestamp
      // yields a player response with ZERO formats (the same video returns
      // 31 formats on a fresh session). Drop the cached session + player
      // and retry once before giving up.
      ytClient = null;
      ytPlayer = null;
      dbg.note({ sessionRetried: true });
      result = await lookupFormats(id, dbg);
    }
    if (result.qualities.length === 0) {
      throw upstream("YouTube returned no downloadable formats for this video");
    }
    // Probe only a representative sample, straight to ranged GET:
    // all 27 URLs share one host and one expiry, 27 parallel probes stall
    // the egress (see probe.js), and googlevideo HEAD takes ~3s here.
    const probes = await probeQualities(result.qualities, { limit: 3, headFirst: false });
    dbg.addProbes(probes);
    return { ...result, qualities: sortWorkingFirst(result.qualities, probes), debug: dbg.finish() };
  });
}
