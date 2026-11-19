// Platform detection + per-endpoint URL validation.
// Each endpoint only handles its own platform and rejects the others with
// an honest 400 UNSUPPORTED.

import { unsupported } from "./errors.js";
import { hostOf, isHttpUrl } from "./http.js";

export const PLATFORMS = ["youtube", "tiktok", "facebook", "x", "soundcloud", "direct", "hls"];

const PLATFORM_HOSTS = {
  youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"],
  tiktok: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch", "fb.com", "www.fb.com"],
  x: ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com"],
  soundcloud: ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "snd.sc", "on.soundcloud.com"],
};

function hostMatches(host, allowed) {
  return allowed.some((a) => host === a || host.endsWith(`.${a}`));
}

export function detectPlatform(url) {
  const host = hostOf(url);
  if (!host) return null;
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hostMatches(host, hosts)) return platform;
  }
  if (url.toLowerCase().includes(".m3u8")) return "hls";
  return "direct";
}

/** Validate that `url` belongs to `platform`. Throws ApiError(UNSUPPORTED) otherwise. */
export function requirePlatform(url, platform) {
  if (!isHttpUrl(url)) {
    throw unsupported(`Not a valid http(s) URL: ${truncateUrl(url)}`);
  }
  if (platform === "direct") {
    // /direct handles direct files only — the named platforms have their own routes.
    const detected = detectPlatform(url);
    if (detected !== "direct" && detected !== "hls") {
      throw unsupported(
        `This is a ${detected} link — use the /${detected} endpoint for it, not /direct.`,
      );
    }
    return;
  }
  if (platform === "hls") {
    if (!url.toLowerCase().includes(".m3u8")) {
      throw unsupported("The /hls endpoint needs an .m3u8 playlist URL.");
    }
    return;
  }
  const allowed = PLATFORM_HOSTS[platform];
  if (!hostMatches(hostOf(url), allowed)) {
    throw unsupported(
      `This is not a ${platform} URL — the /${platform} endpoint only handles ${platform} links.`,
    );
  }
}

function truncateUrl(url) {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}
