// HLS (.m3u8) playlist parsing + resolving.
// Shared by the /hls endpoint and by /direct and /soundcloud when they
// discover a playlist instead of a plain file.
// Variant playlist URLs are probe-checked; probes are recorded in debug.

import { fetchWithTimeout } from "../lib/http.js";
import { notFound, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";

/** Parse an m3u8 variant (master) playlist into qualities.
 *  Pure — unit-tested without network. */
export function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const qualities = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    // The URI is the next non-empty, non-comment line.
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        uri = lines[j];
        break;
      }
    }
    if (!uri) continue;
    const url = new URL(uri, baseUrl).toString();
    const resolution = attrs.RESOLUTION || "";
    const height = resolution.includes("x") ? Number(resolution.split("x")[1]) : 0;
    const bandwidth = Number(attrs.BANDWIDTH || 0);
    const codecs = attrs.CODECS || "";
    const label = height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : "hls";
    const hasAudioAttr = Boolean(attrs.AUDIO);
    qualities.push({
      id: `hls-${label.replace(/[^a-z0-9]+/gi, "").toLowerCase()}`,
      label,
      ext: "m3u8",
      url,
      // A variant with a separate AUDIO group, or codecs without mp4a,
      // is video-only — the client needs the audio playlist too.
      videoOnly: hasAudioAttr || (codecs !== "" && !codecs.includes("mp4a")),
    });
  }
  return qualities;
}

function parseAttributes(attrText) {
  const attrs = {};
  // Split on commas not inside quotes.
  const parts = [];
  let cur = "";
  let inQuotes = false;
  for (const c of attrText) {
    if (c === '"') inQuotes = !inQuotes;
    if (c === "," && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[key] = value;
  }
  return attrs;
}

/** Fetch an .m3u8 URL and return its variant qualities (or [] when the
 *  playlist is a media playlist with no variants). `dbg` records the fetch. */
export async function fetchHlsQualities(url, dbg) {
  const start = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" } },
      8000,
    );
  } catch (err) {
    dbg?.attempt("playlist", url, 0, undefined, Date.now() - start);
    if (err?.name === "AbortError") throw upstream("Playlist request timed out");
    throw upstream("Could not fetch the playlist");
  }
  dbg?.attempt("playlist", url, res.status, undefined, Date.now() - start);
  if (res.status === 404) throw notFound("Playlist not found (HTTP 404)");
  if (!res.ok) throw upstream(`Playlist returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("#EXTM3U")) throw upstream("URL did not return an m3u8 playlist");
  return parseM3u8(text, url);
}

export async function resolveHls(url) {
  return withDebug("hls", async (dbg) => {
    const qualities = await fetchHlsQualities(url, dbg);
    if (qualities.length === 0) {
      // A media playlist (single stream, no variants): return it as one quality.
      const single = [{ id: "hls-stream", label: "hls", ext: "m3u8", url }];
      const probes = await probeQualities(single);
      dbg.addProbes(probes);
      return {
        title: fileNameFromUrl(url),
        source: "hls",
        qualities: single,
        debug: dbg.finish(),
      };
    }
    const probes = await probeQualities(qualities);
    dbg.addProbes(probes);
    return {
      title: fileNameFromUrl(url),
      source: "hls",
      qualities: sortWorkingFirst(qualities, probes),
      debug: dbg.finish(),
    };
  });
}

function fileNameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").filter(Boolean).pop() || "stream";
    return decodeURIComponent(name);
  } catch {
    return "stream";
  }
}
