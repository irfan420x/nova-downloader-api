// X (Twitter) resolver via the public syndication endpoint — no auth needed:
// GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=a
//
// LIVE SHAPE (verified 2026-11-19, SpaceX Starship-catch tweet): the video
// lives in top-level `video.variants[]` — items `{type, src}`, MP4s from
// 270p up to 2160p, plus one `application/x-mpegURL` entry (skipped).
// `video.poster` is the thumbnail, `video.durationMs` the length.
// The `&token=a` param is REQUIRED — `&lang=en` alone returns 200 with
// an empty `{}`. The older `mediaDetails[].video_info.variants` shape
// (`{content_type, url, bitrate}`) is still accepted as a fallback.
// Every returned variant URL is probe-checked; probes are in debug.

import { DESKTOP_UA, fetchWithTimeout } from "../lib/http.js";
import { notFound, unsupported, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

/** Extract the numeric tweet id from an x.com / twitter.com URL. */
export function extractTweetId(url) {
  const m = url.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

/** Map syndication variants to qualities. Pure — unit-tested without network.
 * Accepts both shapes: new `{type, src}` (video.variants) and old
 * `{content_type, url, bitrate}` (mediaDetails[].video_info.variants). */
export function mapXVariants(variants) {
  const qualities = [];
  for (const v of variants || []) {
    const contentType = v.content_type || v.type;
    const url = v.url || v.src;
    if (contentType !== "video/mp4" || !url) continue;
    const m = url.match(/\/(\d+)x(\d+)\//);
    const height = m ? Number(m[2]) : 0;
    const label = height ? `${height}p` : v.bitrate ? `${Math.round(v.bitrate / 1000)}k` : "video";
    qualities.push({
      id: `x-${label.replace(/[^a-z0-9]+/gi, "").toLowerCase()}-${v.bitrate || 0}`,
      label,
      ext: "mp4",
      url,
      _bitrate: v.bitrate || 0,
      _height: height,
    });
  }
  qualities.sort((a, b) => b._height - a._height || b._bitrate - a._bitrate);
  return qualities.map(({ _bitrate, _height, ...q }) => q);
}

/** Pull the variant list out of a syndication response, either shape. */
export function extractXVariants(data) {
  if (Array.isArray(data?.video?.variants)) return data.video.variants;
  const media = (data?.mediaDetails || []).find((m) => m.video_info?.variants);
  return media ? media.video_info.variants : [];
}

export async function resolveX(url) {
  return withDebug("x", async (dbg) => {
    const id = extractTweetId(url);
    if (!id) throw notFound("Could not find a post id in this X link");
    const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;
    const start = Date.now();
    let res;
    try {
      res = await fetchWithTimeout(
        apiUrl,
        { headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" } },
        8000,
      );
    } catch (err) {
      dbg.attempt("syndication", apiUrl, 0, undefined, Date.now() - start);
      if (err?.name === "AbortError") throw upstream("X request timed out");
      throw upstream("Could not reach X");
    }
    dbg.attempt("syndication", apiUrl, res.status, undefined, Date.now() - start);
    if (res.status === 404) throw notFound("X post not found or deleted");
    if (res.status === 403 || res.status === 429) {
      throw upstream(`X blocked this request (HTTP ${res.status})`);
    }
    if (!res.ok) throw upstream(`X returned HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw upstream("X returned an unreadable response");
    }
    const variants = extractXVariants(data);
    if (!variants.length) throw unsupported("This X post contains no video");
    const qualities = mapXVariants(variants);
    if (qualities.length === 0) throw unsupported("This X post contains no downloadable video");
    const probes = await probeQualities(qualities);
    dbg.addProbes(probes);
    const media = (data.mediaDetails || [])[0];
    return {
      title: typeof data.text === "string" && data.text ? data.text.slice(0, 120) : "X video",
      thumbnail: data.video?.poster || media?.media_url_https || undefined,
      source: "x",
      qualities: sortWorkingFirst(qualities, probes),
      debug: dbg.finish(),
    };
  });
}
