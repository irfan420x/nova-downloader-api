// Shared response helpers: CORS, JSON answers, error mapping, body parsing.
// Used by index.js (and by anything else that answers HTTP here).

import { ApiError, unsupported } from "./errors.js";

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function sendJson(res, status, body) {
  res.status(status).json(body);
}

export function sendError(res, err) {
  // Failures carry the debug log too (attached by withDebug) — a failure
  // must be diagnosable from the response alone.
  if (err instanceof ApiError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.debug) body.debug = err.debug;
    res.status(err.status).json(body);
    return;
  }
  const message =
    err instanceof Error && err.name === "AbortError"
      ? "Upstream request timed out"
      : "Upstream request failed";
  const body = { error: { code: "UPSTREAM_ERROR", message } };
  if (err && err.debug) body.debug = err.debug;
  res.status(502).json(body);
}

/** Read a JSON request body. Works with Vercel (pre-parsed object) and with
 *  a raw Node http server (string/stream) so `npm start` works locally. */
export async function readJsonBody(req) {
  if (req.body === undefined || req.body === null) {
    // Raw Node request: collect the stream.
    if (typeof req.on === "function") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return {};
      return JSON.parse(text);
    }
    return {};
  }
  if (typeof req.body === "string") {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }
  return req.body;
}

/** Pull the { url } string out of a parsed body, or throw 400 UNSUPPORTED. */
export function requireUrl(body) {
  const url = body && typeof body === "object" ? body.url : undefined;
  if (typeof url !== "string" || url.trim() === "") {
    throw unsupported('Send a JSON body { "url": "<public link>" }.');
  }
  return url.trim();
}
