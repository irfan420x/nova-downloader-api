// Facebook resolver.
//
// What actually works (proven on the real reel 1121767350734551, 2026-11-19):
// yt-dlp rewrites a reel/watch URL to
//   https://m.facebook.com/watch/?v=<id>&_rdr
// and reads the video streams from the page it lands on (after redirects,
// the www.facebook.com/<page>/videos/<id>/ page). The old mbasic-first
// approach got a 400 error page, so the extractor — not Facebook — was the
// problem. This page has NO playable_url fields any more; the streams live in
//   videoDeliveryLegacyFields.dash_manifest_xml_string  (full DASH MPD XML)
//   videoDeliveryLegacyFields.dash_manifest_url        (MPD fetch fallback)
//   videoDeliveryLegacyFields.browser_native_hd_url    (combined h264 mp4)
//   videoDeliveryLegacyFields.browser_native_sd_url    (combined h264 mp4)
// DASH video reps are video-ONLY (separate audio rep) — flagged as such;
// the native hd/sd URLs are combined video+audio, so they sort first: they
// are the best single-file download. No login, no cookies.

import { BROWSER_HEADERS, DESKTOP_UA, fetchWithTimeout } from "../lib/http.js";
import { blocked, notFound, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

/** Page request headers: full browser set (the yt-dlp request carries the
 *  same Sec-Fetch-* / Upgrade-Insecure-Requests headers). */
export const FACEBOOK_HEADERS = {
  ...BROWSER_HEADERS,
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/** Extract a video id from reel / watch / video.php / videos / share URLs.
 *  fb.watch short links return their short code (not numeric) — those are
 *  fetched as-is instead of via m.facebook.com/watch/?v=. */
export function extractFacebookVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const v = u.searchParams.get("v");
  if (v) return v;
  const m = u.pathname.match(
    /\/(?:reel|videos|share\/(?:v|r)|watch)\/([A-Za-z0-9_-]+)/,
  );
  if (m) return m[1];
  if (u.hostname === "fb.watch") {
    return u.pathname.split("/").filter(Boolean)[0] || null;
  }
  return null;
}

/** Pull a JSON-escaped string field (e.g. "dash_manifest_xml_string") out
 *  of page HTML and unescape it. Returns the decoded string or null.
 *  Pure — unit-tested without network. */
export function extractJsonStringField(html, key) {
  const re = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`);
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/** Pull playable_url / playable_url_quality_hd out of page HTML (legacy
 *  pages only — the current page format carries no such fields).
 *  Pure — unit-tested without network. */
export function parsePlayableUrls(html) {
  const out = {};
  for (const [key, name] of [
    ["playable_url_quality_hd", "hd"],
    ["playable_url", "sd"],
  ]) {
    const value = extractJsonStringField(html, key);
    if (value) out[name] = value;
  }
  return out;
}

/** Unescape the few XML entities a DASH BaseURL can carry. */
export function unescapeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Decode the HTML entities an og:title value can carry. */
export function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

/** Read an attribute out of a tag's attribute string. */
function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

/** Height label for one DASH Representation: FBQualityLabel ("720p") when
 *  present, else the smaller dimension (vertical video: width), else the
 *  resolution in FBEncodingTag ("dash_vp9-basic-gen2_720p"). */
function dashLabel(attrs) {
  const ql = attr(attrs, "FBQualityLabel");
  if (ql) return ql;
  const width = Number(attr(attrs, "width") || 0);
  const height = Number(attr(attrs, "height") || 0);
  if (width > 0 && height > 0) return `${Math.min(width, height)}p`;
  const tag = attr(attrs, "FBEncodingTag") || "";
  const m = tag.match(/(\d{3,4})p/);
  if (m) return `${m[1]}p`;
  return null;
}

/** Parse a DASH MPD document into quality entries.
 *  Video reps are video-only, audio reps audio-only (DASH splits them).
 *  Pure — unit-tested without network. */
export function parseDashManifest(xml) {
  const out = [];
  if (typeof xml !== "string" || !xml) return out;
  for (const m of xml.matchAll(
    /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g,
  )) {
    const attrs = m[1];
    const inner = m[2];
    const base = inner.match(/<BaseURL>([^<]+)<\/BaseURL>/);
    if (!base) continue;
    const url = unescapeXmlEntities(base[1].trim());
    if (!url) continue;
    const mimeType = (attr(attrs, "mimeType") || "").toLowerCase();
    const isAudio = mimeType.startsWith("audio/");
    const isVideo = mimeType.startsWith("video/");
    if (!isAudio && !isVideo) continue;
    const label = isAudio ? "audio" : dashLabel(attrs);
    if (!label) continue;
    const bandwidth = Number(attr(attrs, "bandwidth") || 0) || undefined;
    const width = Number(attr(attrs, "width") || 0) || undefined;
    const height = Number(attr(attrs, "height") || 0) || undefined;
    const q = {
      id: `fb-dash-${isAudio ? "audio" : label}-${bandwidth || 0}`,
      label,
      ext: "mp4",
      url,
      headers: { "User-Agent": DESKTOP_UA },
      bitrate: bandwidth,
    };
    if (isVideo) q.videoOnly = true;
    if (isAudio) q.audioOnly = true;
    if (width) q.width = width;
    if (height) q.height = height;
    out.push(q);
  }
  return out;
}

/** Label for a browser_native_* URL: the efg query param is base64 JSON
 *  whose vencode_tag names the resolution ("..._720p", "...360...").
 *  Falls back to `fallback` ("HD"/"SD") when the tag is missing/unreadable.
 *  Pure — unit-tested without network. */
export function nativeLabelFromUrl(url, fallback) {
  try {
    const efg = new URL(url).searchParams.get("efg");
    if (efg) {
      const decoded = JSON.parse(Buffer.from(efg, "base64").toString("utf8"));
      const tag = typeof decoded?.vencode_tag === "string" ? decoded.vencode_tag : "";
      const m = tag.match(/(\d{3,4})p/);
      if (m) return `${m[1]}p`;
      const sd = tag.match(/(\d{3,4})/);
      if (sd && /sd/i.test(tag)) return `${sd[1]}p`;
    }
  } catch {
    // Fall through to the fallback label.
  }
  return fallback;
}

/** Page title from og:title, else null. Pure. */
export function extractPageTitle(html) {
  const m = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (!m) return null;
  const title = decodeHtmlEntities(m[1]).trim();
  return title || null;
}

/** Build the quality list from one fetched video page.
 *  Order: combined native HD, combined native SD, DASH video (tallest
 *  first), DASH audio last. Deduped by URL (native wins on a clash).
 *  Pure — unit-tested without network. */
export function buildFacebookQualities(html) {
  const seen = new Set();
  const qualities = [];
  const add = (q) => {
    if (!q || !q.url || seen.has(q.url)) return;
    seen.add(q.url);
    qualities.push(q);
  };

  // 1. Combined native URLs — video+audio in one file.
  const hdUrl = extractJsonStringField(html, "browser_native_hd_url");
  const sdUrl = extractJsonStringField(html, "browser_native_sd_url");
  if (hdUrl) {
    add({
      id: "fb-native-hd",
      label: nativeLabelFromUrl(hdUrl, "HD"),
      ext: "mp4",
      url: hdUrl,
      headers: { "User-Agent": DESKTOP_UA },
    });
  }
  if (sdUrl) {
    add({
      id: "fb-native-sd",
      label: nativeLabelFromUrl(sdUrl, "SD"),
      ext: "mp4",
      url: sdUrl,
      headers: { "User-Agent": DESKTOP_UA },
    });
  }

  // 2. DASH manifest (inline XML string; the URL fallback is fetched by
  //    the resolver when the string is absent).
  const manifestXml = extractJsonStringField(html, "dash_manifest_xml_string");
  const dash = parseDashManifest(manifestXml || "");
  const dashVideo = dash
    .filter((q) => q.videoOnly)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  for (const q of dashVideo) add(q);
  for (const q of dash.filter((x) => x.audioOnly)) add(q);

  // 3. Legacy playable_url fields (older page format).
  const legacy = parsePlayableUrls(html);
  if (legacy.hd) {
    add({
      id: "fb-hd",
      label: "HD",
      ext: "mp4",
      url: legacy.hd,
      headers: { "User-Agent": DESKTOP_UA },
    });
  }
  if (legacy.sd) {
    add({
      id: "fb-sd",
      label: "SD",
      ext: "mp4",
      url: legacy.sd,
      headers: { "User-Agent": DESKTOP_UA },
    });
  }
  return qualities;
}

export async function resolveFacebook(url) {
  return withDebug("facebook", async (dbg) => {
    const id = extractFacebookVideoId(url);
    const candidates = [];
    // yt-dlp's rewrite: m.facebook.com/watch/?v=<numeric id>&_rdr.
    if (id && /^\d+$/.test(id)) {
      candidates.push(`https://m.facebook.com/watch/?v=${id}&_rdr`);
    }
    if (!candidates.includes(url)) candidates.push(url);
    let lastStatus = 0;
    for (const pageUrl of candidates) {
      const start = Date.now();
      let res;
      try {
        res = await fetchWithTimeout(pageUrl, { headers: FACEBOOK_HEADERS }, 8000);
      } catch (err) {
        dbg.attempt("page", pageUrl, 0, undefined, Date.now() - start);
        if (err?.name === "AbortError") throw upstream("Facebook page request timed out");
        continue;
      }
      dbg.attempt("page", pageUrl, res.status, undefined, Date.now() - start);
      lastStatus = res.status;
      if (res.status === 404) throw notFound("Facebook video not found or deleted");
      if (res.status === 403 || res.status === 429) {
        throw blocked(`Facebook blocked this request (HTTP ${res.status})`);
      }
      if (!res.ok) continue;
      const html = await res.text();
      let qualities = buildFacebookQualities(html);
      // DASH manifest URL fallback: the page names the MPD but does not
      // embed the XML string (older/newer page variant).
      if (qualities.length === 0) {
        const manifestUrl = extractJsonStringField(html, "dash_manifest_url");
        if (manifestUrl) {
          const mStart = Date.now();
          try {
            const mRes = await fetchWithTimeout(
              manifestUrl,
              { headers: FACEBOOK_HEADERS },
              5000,
            );
            dbg.attempt("dash-manifest", manifestUrl, mRes.status, undefined, Date.now() - mStart);
            if (mRes.ok) {
              qualities = parseDashManifest(await mRes.text());
            }
          } catch {
            dbg.attempt("dash-manifest", manifestUrl, 0, undefined, Date.now() - mStart);
          }
        }
      }
      if (qualities.length === 0) continue;
      const probes = await probeQualities(qualities);
      dbg.addProbes(probes);
      return {
        title: extractPageTitle(html) || "Facebook video",
        source: "facebook",
        qualities: sortWorkingFirst(qualities, probes),
        debug: dbg.finish(),
      };
    }
    if (lastStatus === 404) throw notFound("Facebook video not found or deleted");
    if (lastStatus === 403 || lastStatus === 429) {
      throw blocked(`Facebook blocked this request (HTTP ${lastStatus})`);
    }
    // The page loaded but carried no video data: private, login-walled,
    // or an unsupported page shape. Honest UPSTREAM_ERROR, not a fake hit.
    throw upstream(
      "Facebook returned a page without video data (private or login-walled video?)",
    );
  });
}
