// Direct-file resolver.
// HEAD probe (browser UA + Accept */*), falling back to a ranged GET on
// 403/405/501 — the same rule the mobile app uses. A text/html response is
// REFUSED ("web page, not a file") — the API never returns a web page as a
// download. An .m3u8 URL (or an mpegurl content type) is handed to the HLS
// parser instead.

import { DESKTOP_UA, fetchWithTimeout } from "../lib/http.js";
import { unsupported, upstream } from "../lib/errors.js";
import { withDebug } from "../lib/debug.js";
import { probeQualities, sortWorkingFirst } from "../lib/probe.js";
import { fetchHlsQualities } from "./hls.js";

const EXT_BY_TYPE = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/octet-stream": null,
};

/** File extension from a content type, falling back to the URL path.
 *  Pure — unit-tested without network. */
export function extFromContentType(contentType, url) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct];
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop() || "";
    const dot = last.lastIndexOf(".");
    if (dot > 0 && dot < last.length - 1 && last.length - dot <= 6) {
      return last.slice(dot + 1).toLowerCase();
    }
  } catch {
    // fall through
  }
  return "bin";
}

export function fileNameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").filter(Boolean).pop() || "file";
    return decodeURIComponent(name);
  } catch {
    return "file";
  }
}

/** Probe one direct URL: HEAD, ranged-GET fallback on 403/405/501.
 *  `dbg` records both attempts when given. Returns the final Response. */
export async function probeDirect(url, dbg) {
  const headers = { "User-Agent": DESKTOP_UA, Accept: "*/*" };
  const start = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(url, { method: "HEAD", headers }, 8000);
  } catch (err) {
    dbg?.attempt("probe-head", url, 0, undefined, Date.now() - start);
    if (err?.name === "AbortError") throw upstream("File request timed out");
    throw upstream("Could not reach the file URL");
  }
  if ([403, 405, 501].includes(res.status)) {
    dbg?.attempt("probe-head", url, res.status, undefined, Date.now() - start);
    const getStart = Date.now();
    try {
      res = await fetchWithTimeout(url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-0" },
      }, 8000);
      try {
        await res.arrayBuffer();
      } catch {
        // Ignore body errors — headers are what we needed.
      }
    } catch (err) {
      dbg?.attempt("probe-get", url, 0, undefined, Date.now() - getStart);
      if (err?.name === "AbortError") throw upstream("File request timed out");
      throw upstream("Could not reach the file URL");
    }
    dbg?.attempt("probe-get", url, res.status, undefined, Date.now() - getStart);
  } else {
    dbg?.attempt("probe-head", url, res.status, undefined, Date.now() - start);
  }
  return res;
}

export async function resolveDirect(url) {
  return withDebug("direct", async (dbg) => {
    if (url.toLowerCase().includes(".m3u8")) {
      const qualities = await fetchHlsQualities(url, dbg);
      const probes = await probeQualities(qualities);
      dbg.addProbes(probes);
      return {
        title: fileNameFromUrl(url),
        source: "hls",
        qualities: sortWorkingFirst(qualities, probes),
        debug: dbg.finish(),
      };
    }
    const res = await probeDirect(url, dbg);
    if (!res.ok) throw upstream(`File server returned HTTP ${res.status}`);
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (ct.includes("text/html")) {
      throw unsupported("This link is a web page, not a file — the API never returns web pages as downloads.");
    }
    if (ct.includes("mpegurl") || ct.includes("x-mpegurl")) {
      const qualities = await fetchHlsQualities(url, dbg);
      const probes = await probeQualities(qualities);
      dbg.addProbes(probes);
      return {
        title: fileNameFromUrl(url),
        source: "hls",
        qualities: sortWorkingFirst(qualities, probes),
        debug: dbg.finish(),
      };
    }
    const length = Number(res.headers.get("content-length") || 0) || undefined;
    const ext = extFromContentType(ct, url);
    return {
      title: fileNameFromUrl(url),
      source: "direct",
      qualities: [{ id: "direct-file", label: ext, ext, url, size: length }],
      debug: dbg.finish(),
    };
  });
}
