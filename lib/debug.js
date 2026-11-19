// Debug log attached to every resolve response.
// Purpose (user, 2026-11-19): the API exists so failures are caught HERE by
// direct testing — not only on the user's phone. A failure must be
// diagnosable from the response alone.
//
// Rules:
// - Hostnames only in debug — NEVER full stream URLs (those live in
//   qualities[] as before).
// - Cookie COUNT + NAMES only — NEVER cookie values.
// - One entry per upstream attempt: what was tried, which host, the
//   upstream HTTP status, how many cookies were sent, how long it took.
// - Total time taken for the whole resolve.
//
// Mirrors the mobile app v1.0.7 per-file log:
//   probe: host=<host> cookies=<n>  /  trying next URL

import { cookieNames, hostOf } from "./http.js";

export class DebugLog {
  constructor(platform) {
    this.platform = platform;
    this.startedAt = Date.now();
    this.attempts = [];
  }

  /** Record one upstream attempt. `cookieHeader` is counted/named only. */
  attempt(step, url, status, cookieHeader, ms) {
    this.attempts.push({
      step,
      host: hostOf(url),
      status: typeof status === "number" ? status : 0,
      cookies: cookieHeader ? cookieNames(cookieHeader).length : 0,
      cookieNames: cookieHeader ? cookieNames(cookieHeader) : [],
      ms: typeof ms === "number" ? Math.round(ms) : undefined,
    });
    return this;
  }

  /** Merge probe results (see lib/probe.js) into the log. */
  addProbes(probes) {
    for (const p of probes) {
      this.attempts.push({
        step: "probe",
        host: p.host,
        status: p.status,
        cookies: p.cookies,
        cookieNames: p.cookieNames,
        ms: p.ms,
      });
    }
    return this;
  }

  finish() {
    return {
      platform: this.platform,
      ms: Date.now() - this.startedAt,
      attempts: this.attempts,
    };
  }
}

/** Run `fn(dbg)` with a fresh DebugLog. On success the caller includes
 *  `debug: dbg.finish()` in its response; on failure the log is attached
 *  to the thrown error as `err.debug` so error responses carry it too. */
export async function withDebug(platform, fn) {
  const dbg = new DebugLog(platform);
  try {
    return await fn(dbg);
  } catch (err) {
    err.debug = dbg.finish();
    throw err;
  }
}
