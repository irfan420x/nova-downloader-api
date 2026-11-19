// HTTP helpers shared by the platform modules.
// Cookie values are NEVER logged anywhere in this module.

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Proven on real TikTok links (mobile app v1.0.7 repro): stream requests
// with this UA + session cookies (+ Referer on v16) serve 200/206.
export const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

export const BROWSER_HEADERS = {
  "User-Agent": DESKTOP_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** One fetch with a hard timeout (serverless functions have a 10s cap). */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

/** Build a Cookie header value from a fetch Response's Set-Cookie headers.
 *  Returns undefined when the response set no cookies. Values are returned
 *  to the CALLER (the client needs them) but must never be logged. */
export function cookieHeaderFromResponse(res) {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length === 0) return undefined;
  const pairs = setCookie
    .map((c) => c.split(";")[0].trim())
    .filter((p) => p.includes("="));
  return pairs.length ? pairs.join("; ") : undefined;
}

/** Parse a Cookie header value into names only (for diagnostics). */
export function cookieNames(cookieHeader) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((p) => p.split("=")[0].trim())
    .filter(Boolean);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
