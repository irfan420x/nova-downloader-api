// Stream-URL probing — the API verifies the URLs it returns, the same way
// the mobile app's DownloadEngine probes before downloading.
// HEAD first; on ANY HEAD failure (4xx/5xx code OR timeout/network error)
// fall back to a ranged GET (bytes=0-0), because some CDNs fail HEAD while
// serving GET (TikTok v16: HEAD 403/404/504 — and sometimes a HEAD hang —
// while ranged GET serves 206 with cookies+Referer).
//
// The ranged GET reads at most ONE chunk then cancels, so a server that
// ignores Range and answers 200 can never make the probe download a body.
//
// Returns one entry per URL: { host, status, cookies, cookieNames, ms, ok }.
// `ok` means the URL served (2xx on HEAD or on the ranged-GET fallback).
// `status` is the last HTTP status seen (0 when nothing answered at all).

import { ANDROID_UA, cookieNames, hostOf } from "./http.js";

const HEAD_TIMEOUT_MS = 1200;
const GET_TIMEOUT_MS = 3000;

/** Probe one stream URL. `headers` are the headers the client would send
 *  (Cookie values are counted/named only, never logged). With
 *  `headFirst: false` the ranged GET is tried directly — googlevideo HEAD
 *  takes ~3s from this VM, so the HEAD-first attempt only wastes its
 *  timeout before the GET that actually proves the URL. */
export async function probeStream(url, headers = {}, { headFirst = true } = {}) {
  const started = Date.now();
  const cookieHeader = headers.Cookie || headers.cookie;
  const base = {
    host: hostOf(url),
    cookies: cookieHeader ? cookieNames(cookieHeader).length : 0,
    cookieNames: cookieHeader ? cookieNames(cookieHeader) : [],
  };
  const headHeaders = { ...headers };
  // HEAD must not carry a Range; the fallback GET adds it.
  delete headHeaders.Range;
  delete headHeaders.range;
  let headStatus = 0;
  if (headFirst) {
    try {
      const head = await fetchWithTimeout(url, { method: "HEAD", headers: headHeaders }, HEAD_TIMEOUT_MS);
      headStatus = head.status;
      if (head.status < 400) {
        return { ...base, status: head.status, ms: Date.now() - started, ok: true };
      }
    } catch {
      // HEAD timed out or failed at the network — the ranged GET below is
      // the real test; a hanging HEAD must not end the probe.
    }
  }
  // Ranged GET fallback: covers HEAD 4xx/5xx AND HEAD timeout/network.
  try {
    const get = await fetchWithTimeout(
      url,
      { method: "GET", headers: { ...headers, Range: "bytes=0-0" } },
      GET_TIMEOUT_MS,
    );
    // Read at most one chunk, then cancel — never download a body.
    try {
      const reader = get.body?.getReader();
      if (reader) {
        await reader.read();
        await reader.cancel();
      }
    } catch {
      // Ignore body errors — the status is what the probe reports.
    }
    return {
      ...base,
      status: get.status,
      ms: Date.now() - started,
      ok: get.status >= 200 && get.status < 300,
    };
  } catch {
    return { ...base, status: headStatus, ms: Date.now() - started, ok: false };
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

/** Probe quality URLs in parallel (at most `concurrency` at a time —
// 27 simultaneous TLS+proxy connections stall the VM egress and the
// Vercel function). `limit` probes only the first N qualities: YouTube
// returns 27 URLs on ONE host with one expiry, so probing 3 is
// representative; TikTok has 3 URLs on 2 differently-behaving hosts and
// probes all of them. Returns probe entries in quality order (each entry
// also carries the quality id for matching). */
export async function probeQualities(qualities, { limit = qualities.length, concurrency = 5, headFirst = true } = {}) {
  const subset = qualities.slice(0, limit);
  const results = new Array(subset.length);
  let next = 0;
  async function worker() {
    while (next < subset.length) {
      const i = next++;
      results[i] = await probeStream(subset[i].url, subset[i].headers || {}, { headFirst });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, subset.length) }, worker));
  return results.map((r, i) => ({ ...r, qualityId: subset[i].id }));
}

/** Sort qualities so ones that probed OK come first (stable otherwise).
 *  All qualities are kept — a failed probe demotes, never drops, a URL. */
export function sortWorkingFirst(qualities, probes) {
  const okById = new Map(probes.map((p) => [p.qualityId, p.ok]));
  return [...qualities].sort((a, b) => {
    const ao = okById.get(a.id) ? 0 : 1;
    const bo = okById.get(b.id) ? 0 : 1;
    return ao - bo;
  });
}

export { ANDROID_UA };
