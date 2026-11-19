// SoundCloud resolver.
// The resolve API needs a client_id. One is NOT hardcoded (they go stale):
// it is extracted from the SoundCloud web client at runtime and cached for
// the life of the (warm) instance. If extraction fails, the error says so
// honestly (UPSTREAM_ERROR) instead of guessing.
// Progressive transcodings return a direct mp3 URL; HLS transcodings are
// parsed into variant qualities. Stream URLs are probe-checked; probes are
// recorded in debug.

import { BROWSER_HEADERS, DESKTOP_UA, fetchWithTimeout } from "../lib/http.js";
import { notFound, unsupported, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";
import { fetchHlsQualities } from "./hls.js";

let cachedClientId = null;

/** Extract a client_id from the SoundCloud web client JS bundles.
 *  Cached module-level (warm instances reuse it). `dbg` records the fetch. */
export async function getSoundCloudClientId(dbg) {
  if (cachedClientId) return cachedClientId;
  const start = Date.now();
  let homeRes;
  try {
    homeRes = await fetchWithTimeout("https://soundcloud.com", { headers: BROWSER_HEADERS }, 8000);
  } catch (err) {
    if (err?.name === "AbortError") throw upstream("SoundCloud homepage timed out");
    throw upstream("Could not reach SoundCloud");
  }
  dbg?.attempt("homepage", "https://soundcloud.com", homeRes.status, undefined, Date.now() - start);
  if (!homeRes.ok) throw upstream(`SoundCloud returned HTTP ${homeRes.status}`);
  const html = await homeRes.text();
  // ALL client bundles — the client_id lives in the LAST one (bundle 55,
  // ~3MB, verified 2026-11-19); slicing to the first few misses it.
  const scripts = [...new Set(
    [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[A-Za-z0-9_-]+\.js/g)].map((m) => m[0]),
  )];
  if (scripts.length === 0) throw upstream("Could not find SoundCloud web client scripts");
  const bodies = await Promise.allSettled(
    scripts.map((u) =>
      fetchWithTimeout(u, { headers: { "User-Agent": DESKTOP_UA } }, 10000).then((r) => r.text()),
    ),
  );
  for (const b of bodies) {
    if (b.status !== "fulfilled") continue;
    const m = b.value.match(/client_id\s*[=:]\s*["']([A-Za-z0-9]{32})["']/);
    if (m) {
      cachedClientId = m[1];
      return cachedClientId;
    }
  }
  throw upstream("Could not extract a SoundCloud client_id");
}

export async function resolveSoundCloud(url) {
  return withDebug("soundcloud", async (dbg) => {
    const clientId = await getSoundCloudClientId(dbg);
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`;
    const start = Date.now();
    let res;
    try {
      res = await fetchWithTimeout(resolveUrl, {
        headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
      }, 8000);
    } catch (err) {
      if (err?.name === "AbortError") throw upstream("SoundCloud resolve timed out");
      throw upstream("Could not reach SoundCloud");
    }
    dbg.attempt("resolve", resolveUrl, res.status, undefined, Date.now() - start);
    if (res.status === 404) throw notFound("SoundCloud track not found or private");
    if (res.status === 401 || res.status === 403) {
      throw upstream(`SoundCloud rejected the client_id (HTTP ${res.status})`);
    }
    if (!res.ok) throw upstream(`SoundCloud returned HTTP ${res.status}`);
    const track = await res.json();
    const transcodings = track?.media?.transcodings ?? [];
    if (transcodings.length === 0) {
      throw unsupported("This SoundCloud track has no downloadable stream");
    }
    const qualities = [];
    for (const t of transcodings) {
      const tUrl = `${t.url}${t.url.includes("?") ? "&" : "?"}client_id=${clientId}`;
      const tStart = Date.now();
      let tRes;
      try {
        tRes = await fetchWithTimeout(tUrl, {
          headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
        }, 8000);
      } catch {
        continue;
      }
      dbg.attempt("transcoding", tUrl, tRes.status, undefined, Date.now() - tStart);
      if (!tRes.ok) continue;
      const data = await tRes.json().catch(() => null);
      if (!data?.url) continue;
      const protocol = t.format?.protocol || "";
      const mime = t.format?.mime_type || "";
      if (protocol === "hls" || mime.includes("mpegurl") || data.url.includes(".m3u8")) {
        try {
          const variants = await fetchHlsQualities(data.url, dbg);
          if (variants.length === 0) {
            // Media playlist (single stream, no #EXT-X-STREAM-INF variants):
            // the m3u8 URL itself IS the stream — return it as one quality.
            // SoundCloud HLS transcodings are always media playlists.
            const kbps = (t.preset || "").match(/(\d+)k/)?.[1];
            qualities.push({
              id: `sc-${(t.preset || "hls").replace(/[^a-z0-9]+/gi, "").toLowerCase()}`,
              label: kbps ? `aac ${kbps}k` : "hls",
              ext: "m3u8",
              url: data.url,
              audioOnly: true,
            });
          } else {
            for (const v of variants) qualities.push({ ...v, audioOnly: true });
          }
        } catch {
          continue;
        }
      } else {
        qualities.push({
          id: "sc-mp3",
          label: "mp3",
          ext: mime.includes("mp4") ? "m4a" : "mp3",
          url: data.url,
          audioOnly: true,
        });
      }
    }
    if (qualities.length === 0) throw upstream("SoundCloud returned no playable stream URL");
    const probes = await probeQualities(qualities);
    dbg.addProbes(probes);
    return {
      title: track.title || "SoundCloud track",
      thumbnail: track.artwork_url || undefined,
      source: "soundcloud",
      qualities: sortWorkingFirst(qualities, probes),
      debug: dbg.finish(),
    };
  });
}
