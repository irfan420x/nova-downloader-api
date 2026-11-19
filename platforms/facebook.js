// Facebook resolver (best effort — Facebook guards video URLs heavily).
// Fetches the video page (mbasic first, then the original URL) and reads
// the playable_url / playable_url_quality_hd fields embedded in the page.
// No login, no cookies. When Facebook bot-checks or demands login, the
// error says so honestly (BLOCKED) instead of returning a web page.

import { BROWSER_HEADERS, fetchWithTimeout } from "../lib/http.js";
import { blocked, notFound } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

/** Extract a video id from watch / reel / videos / fb.watch URLs. */
export function extractFacebookVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const v = u.searchParams.get("v");
  if (v) return v;
  const m = u.pathname.match(/\/(?:reel|videos|share\/v|watch)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (u.hostname === "fb.watch") {
    return u.pathname.split("/").filter(Boolean)[0] || null;
  }
  return null;
}

/** Pull playable_url / playable_url_quality_hd out of page HTML.
 *  Pure — unit-tested without network. */
export function parsePlayableUrls(html) {
  const out = {};
  for (const [key, name] of [
    ["playable_url_quality_hd", "hd"],
    ["playable_url", "sd"],
  ]) {
    const re = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`);
    const m = html.match(re);
    if (!m) continue;
    try {
      out[name] = JSON.parse(`"${m[1]}"`);
    } catch {
      // Ignore a malformed match — the other quality may still work.
    }
  }
  return out;
}

export async function resolveFacebook(url) {
  return withDebug("facebook", async (dbg) => {
    const id = extractFacebookVideoId(url);
    const candidates = [];
    if (id) candidates.push(`https://mbasic.facebook.com/watch/?v=${id}`);
    if (!candidates.includes(url)) candidates.push(url);
    let lastStatus = 0;
    for (const pageUrl of candidates) {
      const start = Date.now();
      let res;
      try {
        res = await fetchWithTimeout(pageUrl, { headers: BROWSER_HEADERS }, 8000);
      } catch {
        continue;
      }
      dbg.attempt("page", pageUrl, res.status, undefined, Date.now() - start);
      lastStatus = res.status;
      if (!res.ok) continue;
      const html = await res.text();
      const found = parsePlayableUrls(html);
      if (!found.sd && !found.hd) continue;
      const qualities = [];
      if (found.hd) qualities.push({ id: "fb-hd", label: "HD", ext: "mp4", url: found.hd });
      if (found.sd) qualities.push({ id: "fb-sd", label: "SD", ext: "mp4", url: found.sd });
      const probes = await probeQualities(qualities);
      dbg.addProbes(probes);
      return {
        title: "Facebook video",
        source: "facebook",
        qualities: sortWorkingFirst(qualities, probes),
        debug: dbg.finish(),
      };
    }
    if (lastStatus === 404) throw notFound("Facebook video not found or deleted");
    throw blocked("Facebook blocked this request or the video needs login");
  });
}
