// TikTok resolver.
//
// Hard-won learning from the mobile app (v1.0.6/v1.0.7, proven on real links):
// - The page sets session cookies (ttwid / tt_csrf_token / tt_chain_token,
//   all Domain=.tiktok.com). The client MUST send them back.
// - UrlList has several CDN hosts (v16-webapp-prime, v19-webapp-prime,
//   www.tiktok.com). v19 works with cookies alone; v16 needs cookies +
//   Referer (origin https://www.tiktok.com/) AND its HEAD fails (403/404/504)
//   while ranged GET serves. So: return ALL UrlList entries as separate
//   qualities/alternates — NEVER pick only urls.first() — and attach the
//   captured cookies + Referer to every quality. The client tries each URL.
// - Cookie VALUES go in the response (the client needs them) but are NEVER
//   logged server-side. The debug object records cookie NAMES + COUNT only.
// - Every returned stream URL is probe-checked (HEAD, ranged-GET fallback)
//   and working ones sort first; probes are recorded in debug.

import { ANDROID_UA, BROWSER_HEADERS, cookieHeaderFromResponse, fetchWithTimeout } from "../lib/http.js";
import { blocked, notFound, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

export const TIKTOK_REFERER = "https://www.tiktok.com/";

/** Extract the __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON object from page HTML.
 *  Returns the parsed object, or null when the page has no such data
 *  (e.g. a bot-check page). Handles both the <script type="application/json">
 *  form and the `window.__UNIVERSAL_DATA... = {...}` form. */
export function extractRehydrationJson(html) {
  const marker = "__UNIVERSAL_DATA_FOR_REHYDRATION__";
  let start = html.indexOf(marker);
  if (start === -1) return null;
  // Move to the first '{' after the marker.
  const brace = html.indexOf("{", start);
  if (brace === -1) return null;
  const end = matchJsonEnd(html, brace);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(brace, end + 1));
  } catch {
    return null;
  }
}

/** Find the index of the '}' that closes the JSON object starting at `open`.
 *  String-aware: braces inside "..." (with \" escapes) are ignored. */
export function matchJsonEnd(text, open) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Deep-search a parsed object for the first itemStruct-like video object:
 *  an object with a `video` that has usable streams — either bitrateInfo
 *  entries with PlayAddr.UrlList, or a plain playAddr URL string.
 *  Returns { video, desc } or null.
 *
 *  NOTE: in the real page JSON `video.playAddr` is a STRING (the single
 *  no-watermark URL) and the per-quality URLs live in
 *  `video.bitrateInfo[].PlayAddr.UrlList` (capital U) — never look for a
 *  lowercase `playAddr.urlList` object. */
export function findTikTokVideo(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const video = node.video;
    if (video && typeof video === "object") {
      const hasBitrates =
        Array.isArray(video.bitrateInfo) &&
        video.bitrateInfo.some(
          (e) => Array.isArray(e?.PlayAddr?.UrlList) && e.PlayAddr.UrlList.length > 0,
        );
      const hasPlayAddr = typeof video.playAddr === "string" && video.playAddr.length > 0;
      if (hasBitrates || hasPlayAddr) {
        return { video, desc: typeof node.desc === "string" ? node.desc : "" };
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

/** Height from a GearName like "normal_540_0" / "adapt_lowest_1080_1". */
export function heightFromGearName(gearName) {
  if (typeof gearName !== "string") return 0;
  const m = gearName.match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

/** `cover` is usually a plain URL string; some pages nest url_list instead. */
export function coverUrl(video) {
  if (typeof video.cover === "string" && video.cover) return video.cover;
  if (typeof video.originCover === "string" && video.originCover) return video.originCover;
  if (typeof video.dynamicCover === "string" && video.dynamicCover) return video.dynamicCover;
  const coverObj = video.cover;
  if (coverObj && typeof coverObj === "object" && Array.isArray(coverObj.url_list)) {
    return coverObj.url_list[0] || "";
  }
  return "";
}

/** Build the quality list from a found video object + captured Cookie header.
 *  One quality per height (highest bitrate wins per height); the label is
 *  the SMALLER dimension ("576p" for a 576x1090 vertical video — the same
 *  convention the mobile app uses). Every quality keeps its whole UrlList:
 *  the hosts differ in what they demand (v16 needs cookies+Referer, v19
 *  cookies alone), so the client tries each URL in turn.
 *  Pure — unit-tested without network. */
export function buildTikTokQualities(video, cookieHeader) {
  const headers = { "User-Agent": ANDROID_UA, Referer: TIKTOK_REFERER };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const byHeight = new Map();
  const bitrateInfo = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
  for (const entry of bitrateInfo) {
    const playAddr = entry?.PlayAddr;
    const urls = Array.isArray(playAddr?.UrlList)
      ? playAddr.UrlList.filter((u) => typeof u === "string" && u)
      : [];
    if (urls.length === 0) continue;
    const width = Number(playAddr.Width || 0);
    let height = Number(playAddr.Height || 0);
    if (!height) height = heightFromGearName(entry.GearName);
    if (!height) continue;
    // Quality label is the smaller dimension (see above).
    const quality = width > 0 ? Math.min(width, height) : height;
    const bitrate = Number(entry.Bitrate || 0);
    const size = Number(playAddr.DataSize || 0) || undefined;
    const q = {
      id: `tiktok-${height}-${bitrate}`,
      label: `${quality}p`,
      ext: "mp4",
      url: urls[0],
      alternates: urls.slice(1),
      headers: { ...headers },
      size,
      _height: height,
      _bitrate: bitrate,
    };
    const existing = byHeight.get(height);
    if (!existing || bitrate > existing._bitrate) byHeight.set(height, q);
  }
  let qualities = [...byHeight.values()]
    .sort((a, b) => b._height - a._height)
    .map(({ _height, _bitrate, ...q }) => q);
  if (qualities.length === 0 && typeof video.playAddr === "string" && video.playAddr) {
    // Fallback: the single playAddr URL.
    const width = Number(video.width || 0);
    const height = Number(video.height || 0);
    const quality = width > 0 && height > 0 ? Math.min(width, height) : height;
    qualities = [
      {
        id: "tiktok-video",
        label: quality > 0 ? `${quality}p` : "video",
        ext: "mp4",
        url: video.playAddr,
        headers: { ...headers },
      },
    ];
  }
  return qualities;
}

export async function resolveTikTok(url) {
  return withDebug("tiktok", async (dbg) => {
    const pageStart = Date.now();
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, 8000);
    } catch (err) {
      dbg.attempt("page", url, 0, undefined, Date.now() - pageStart);
      if (err?.name === "AbortError") throw upstream("TikTok page request timed out");
      throw upstream("Could not reach TikTok");
    }
    const cookieHeader = cookieHeaderFromResponse(res);
    dbg.attempt("page", url, res.status, cookieHeader, Date.now() - pageStart);
    if (res.status === 404) throw notFound("TikTok video not found or deleted");
    if (res.status === 403 || res.status === 429) {
      throw blocked(`TikTok blocked this request (HTTP ${res.status})`);
    }
    if (!res.ok) throw upstream(`TikTok returned HTTP ${res.status}`);
    const html = await res.text();
    const data = extractRehydrationJson(html);
    if (!data) {
      throw blocked("TikTok returned a page without video data (bot check?)");
    }
    const found = findTikTokVideo(data);
    if (!found) throw notFound("No video found at this TikTok link");
    const { video, desc } = found;
    const qualities = buildTikTokQualities(video, cookieHeader);
    const probes = await probeQualities(qualities);
    dbg.addProbes(probes);
    return {
      title: desc || "TikTok video",
      thumbnail: coverUrl(video) || undefined,
      source: "tiktok",
      qualities: sortWorkingFirst(qualities, probes),
      debug: dbg.finish(),
    };
  });
}
