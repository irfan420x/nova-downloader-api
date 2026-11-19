// NOVA Downloader API — main entry (index.js).
//
// Works BOTH ways:
//  (a) Vercel serverless: api/index.js re-exports this default handler.
//      vercel.json rewrites the clean paths (/tiktok, /youtube, …) to
//      /api/index?platform=<name>.
//  (b) Standalone: `node index.js` or `npm start` starts a local HTTP server
//      (PORT env var, default 3000) serving the exact same endpoints.
//      Zero required env vars for basic use.
//
// Every endpoint takes POST { "url": "<public link>" } and returns
// { title, thumbnail?, source, qualities[], debug } — no auth in v1, so the
// endpoints are callable with plain curl. The API only RESOLVES (returns
// stream URLs + headers); clients download bytes directly from CDNs.
// It never proxies file bytes and never returns a web page as a download.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveTikTok } from "./platforms/tiktok.js";
import { resolveYouTube } from "./platforms/youtube.js";
import { resolveFacebook } from "./platforms/facebook.js";
import { resolveX } from "./platforms/x.js";
import { resolveSoundCloud } from "./platforms/soundcloud.js";
import { resolveDirect } from "./platforms/direct.js";
import { resolveHls } from "./platforms/hls.js";
import { PLATFORMS, requirePlatform } from "./lib/detect.js";
import { readJsonBody, requireUrl, sendError, sendJson, setCors } from "./lib/respond.js";

const RESOLVERS = {
  youtube: resolveYouTube,
  tiktok: resolveTikTok,
  facebook: resolveFacebook,
  x: resolveX,
  soundcloud: resolveSoundCloud,
  direct: resolveDirect,
  hls: resolveHls,
};

export const ENDPOINTS = [
  { path: "/youtube", platform: "youtube", description: "YouTube video — combined + video-only + audio-only qualities" },
  { path: "/tiktok", platform: "tiktok", description: "TikTok video — all CDN hosts, session cookies + Referer attached" },
  { path: "/facebook", platform: "facebook", description: "Facebook video — SD / HD playable URLs" },
  { path: "/x", platform: "x", description: "X post video — variants by bitrate" },
  { path: "/soundcloud", platform: "soundcloud", description: "SoundCloud track — progressive mp3 / HLS" },
  { path: "/direct", platform: "direct", description: "Direct file — HEAD probe, refuses web pages" },
  { path: "/hls", platform: "hls", description: "HLS .m3u8 playlist — variant qualities" },
];

/** Platform from a request path: "/tiktok" -> "tiktok", "/api/health" ->
 *  "health", "/" -> null (endpoint list), anything else -> undefined. */
export function platformFromPath(pathname) {
  if (pathname === "/api/health") return "health";
  if (pathname === "/" || pathname === "") return null;
  const seg = pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
  return PLATFORMS.includes(seg) ? seg : undefined;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  // Vercel rewrites pass ?platform=<name>; standalone uses the clean path.
  const platform = req.query?.platform || platformFromPath(url.pathname);
  if (platform === "health") {
    // HEAD must answer 200 with no body: uptime monitors (UptimeRobot)
    // probe /api/health with HEAD, and a 405 there reads as "down".
    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "UNSUPPORTED", message: "GET only for /api/health." } });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (platform === null) {
    sendJson(res, 200, {
      ok: true,
      name: "NOVA Downloader API",
      endpoints: ENDPOINTS.map((e) => e.path),
      health: "/api/health",
    });
    return;
  }
  if (platform === undefined || !RESOLVERS[platform]) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: `Unknown endpoint: ${url.pathname}` } });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, {
      error: {
        code: "UNSUPPORTED",
        message: `POST a JSON body { "url": "..." } to ${ENDPOINTS.find((e) => e.platform === platform).path}.`,
      },
    });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const target = requireUrl(body);
    requirePlatform(target, platform);
    const result = await RESOLVERS[platform](target);
    sendJson(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}

// ---- Standalone mode: `node index.js` / `npm start` ----------------------
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer(async (nodeReq, nodeRes) => {
    const res = {
      status(code) {
        nodeRes.statusCode = code;
        return res;
      },
      setHeader(name, value) {
        nodeRes.setHeader(name, value);
      },
      json(body) {
        nodeRes.setHeader("Content-Type", "application/json");
        nodeRes.end(JSON.stringify(body));
      },
      end(data) {
        nodeRes.end(data);
      },
    };
    try {
      const parsed = new URL(nodeReq.url, "http://localhost");
      let bodyText = "";
      if (nodeReq.method === "POST") {
        const chunks = [];
        for await (const chunk of nodeReq) chunks.push(chunk);
        bodyText = Buffer.concat(chunks).toString("utf8");
      }
      const req = {
        method: nodeReq.method,
        url: nodeReq.url,
        query: Object.fromEntries(parsed.searchParams.entries()),
        body: bodyText || undefined,
      };
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  });
  server.listen(port, () => {
    console.log(`NOVA Downloader API listening on http://localhost:${port}`);
    console.log(`Endpoints: ${ENDPOINTS.map((e) => e.path).join(" ")}  +  /api/health`);
  });
}
