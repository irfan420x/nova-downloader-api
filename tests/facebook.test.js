// Facebook parser tests — no network; fixtures copy the REAL page shape
// (verified against a live m.facebook.com → www.facebook.com video page
// 2026-11-19, reel 1121767350734551):
//   videoDeliveryLegacyFields.dash_manifest_xml_string — full DASH MPD XML
//     (4 Representations: 360p/540p/720p video-only + audio; FBQualityLabel
//     names the height; BaseURL is an fbcdn mp4 URL)
//   videoDeliveryLegacyFields.browser_native_hd_url / _sd_url — combined
//     h264 mp4s; the efg query param is base64 JSON whose vencode_tag names
//     the resolution ("..._720p", "...360...sd")
//   og:title carries HTML entities (&#x1f631;)
// The current page format has NO playable_url fields — that legacy path is
// tested separately with an old-shape fixture.
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractFacebookVideoId,
  extractJsonStringField,
  parsePlayableUrls,
  parseDashManifest,
  nativeLabelFromUrl,
  extractPageTitle,
  buildFacebookQualities,
  unescapeXmlEntities,
} from "../platforms/facebook.js";

const FBCDN_360 = "https://video-lax3-2.xx.fbcdn.net/o1/v/t2/f2/m366/AAAA360.mp4";
const FBCDN_540 = "https://video-lax3-2.xx.fbcdn.net/o1/v/t2/f2/m366/AAAA540.mp4";
const FBCDN_720 = "https://video-lax3-2.xx.fbcdn.net/o1/v/t2/f2/m366/AAAA720.mp4";
const FBCDN_AUDIO = "https://video-lax3-2.xx.fbcdn.net/o1/v/t2/f2/m412/BBBB.mp4";

const MPD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10.026667S"><Period id="0" duration="PT10.026667S"><AdaptationSet id="0" contentType="video"><Representation id="1v" bandwidth="536253" codecs="vp09.00.21.08" mimeType="video/mp4" sar="1:1" FBEncodingTag="dash_vp9-basic-gen2_360p" width="360" height="640" FBQualityClass="sd" FBQualityLabel="360p"><BaseURL>${FBCDN_360}?_nc_cat=108&amp;oh=00_ABC&amp;oe=6B04652C</BaseURL><SegmentBase indexRange="0-100" timescale="90000"><Initialization range="0-50"/></SegmentBase></Representation><Representation id="2v" bandwidth="1723092" codecs="vp09.00.30.08" mimeType="video/mp4" sar="1:1" FBEncodingTag="dash_vp9-basic-gen2_540p" width="540" height="960" FBQualityClass="sd" FBQualityLabel="540p"><BaseURL>${FBCDN_540}</BaseURL></Representation><Representation id="3v" bandwidth="4545116" codecs="vp09.00.31.08" mimeType="video/mp4" sar="1:1" FBEncodingTag="dash_vp9-basic-gen2_720p" width="720" height="1280" FBQualityClass="hd" FBQualityLabel="720p"><BaseURL>${FBCDN_720}</BaseURL></Representation></AdaptationSet><AdaptationSet id="1" contentType="audio"><Representation id="4a" bandwidth="26858" codecs="mp4a.40.5" mimeType="audio/mp4" FBAvgBitrate="26858" audioSamplingRate="24000" FBEncodingTag="dash_ln_heaac_vbr3_audio"><BaseURL>${FBCDN_AUDIO}</BaseURL></Representation></AdaptationSet></Period></MPD>`;

// A page fragment in the real shape: JSON blob with the manifest string,
// native URLs, and an og:title. JSON.stringify escapes it the way the
// page's own JSON does (the real page also uses \u003C — see the
// extractJsonStringField test below).
function efgBase64(vencodeTag) {
  return Buffer.from(JSON.stringify({ vencode_tag: vencodeTag })).toString("base64");
}

function pageHtml({ manifestXml = MPD_XML, hdTag = "xpv_progressive.FACEBOOK..C3.720.dash_h264-basic-gen2_720p", sdTag = "xpv_progressive.FACEBOOK..C3.360.sve_sd", title = "&#x1f631; #fyp&#x30b7; #viral | JawDrop World" } = {}) {
  const blob = {
    comet_video_player_nextgendash_availability: "AVAILABLE",
    videoDeliveryLegacyFields: {
      dash_manifest_xml_string: manifestXml,
      dash_manifest_url: "https://www.facebook.com/dash_mpd_debug.mpd?v=1121767350734551&dummy=.mpd",
      browser_native_hd_url: `https://video-den2-1.xx.fbcdn.net/o1/v/t2/f2/m366/HD.mp4?efg=${encodeURIComponent(efgBase64(hdTag))}&oh=00_HD`,
      browser_native_sd_url: `https://video-den2-1.xx.fbcdn.net/o1/v/t2/f2/m412/SD.mp4?efg=${encodeURIComponent(efgBase64(sdTag))}&oh=00_SD`,
    },
  };
  return `<html><head><meta property="og:title" content="${title}"></head><body><script>${JSON.stringify(blob)}</script></body></html>`;
}

test("extractFacebookVideoId handles reel/watch/video.php/videos/share URLs", () => {
  assert.equal(extractFacebookVideoId("https://www.facebook.com/reel/1121767350734551/"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/watch/?v=1121767350734551"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/watch?v=1121767350734551&_rdr"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/video.php?v=1121767350734551"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/JawDropWorld/videos/1121767350734551/"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/share/v/AbC123xYz/"), "AbC123xYz");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/share/r/AbC123xYz/"), "AbC123xYz");
  assert.equal(extractFacebookVideoId("https://m.facebook.com/watch/?v=1121767350734551&_rdr"), "1121767350734551");
  assert.equal(extractFacebookVideoId("https://fb.watch/AbC123xYz/"), "AbC123xYz");
  assert.equal(extractFacebookVideoId("https://www.facebook.com/"), null);
  assert.equal(extractFacebookVideoId("not a url"), null);
});

test("extractJsonStringField unescapes JSON string fields incl. \\u003C", () => {
  const html = `"dash_manifest_xml_string":"\\u003C?xml version=\\"1.0\\"?>\\n\\u003CMPD>"`;
  assert.equal(extractJsonStringField(html, "dash_manifest_xml_string"), '<?xml version="1.0"?>\n<MPD>');
  assert.equal(extractJsonStringField(html, "missing_key"), null);
  assert.equal(extractJsonStringField("no json here", "dash_manifest_xml_string"), null);
});

test("unescapeXmlEntities handles the entities a BaseURL can carry", () => {
  assert.equal(
    unescapeXmlEntities("https://x.fbcdn.net/a.mp4?a=1&amp;b=2&lt;3&gt;4&quot;5&#39;6"),
    "https://x.fbcdn.net/a.mp4?a=1&b=2<3>4\"5'6",
  );
});

test("parseDashManifest returns video reps + audio rep with flags and labels", () => {
  const quals = parseDashManifest(MPD_XML);
  assert.equal(quals.length, 4);
  const q720 = quals.find((q) => q.label === "720p");
  assert.ok(q720);
  assert.equal(q720.videoOnly, true);
  assert.equal(q720.audioOnly, undefined);
  assert.equal(q720.bitrate, 4545116);
  assert.equal(q720.width, 720);
  assert.equal(q720.height, 1280);
  // &amp; in the 360p BaseURL must be unescaped to a real query string.
  const q360 = quals.find((q) => q.label === "360p");
  assert.ok(q360.url.includes("_nc_cat=108&oh=00_ABC&oe=6B04652C"));
  assert.equal(q360.url.includes("&amp;"), false);
  const audio = quals.find((q) => q.audioOnly);
  assert.ok(audio);
  assert.equal(audio.label, "audio");
  assert.equal(audio.url, FBCDN_AUDIO);
  assert.deepEqual(parseDashManifest(""), []);
  assert.deepEqual(parseDashManifest(null), []);
});

test("parseDashManifest falls back to smaller dimension / encoding tag", () => {
  const xml = `<MPD><Period><AdaptationSet><Representation bandwidth="1000" mimeType="video/mp4" width="480" height="854"><BaseURL>${FBCDN_540}</BaseURL></Representation><Representation bandwidth="2000" mimeType="video/mp4" FBEncodingTag="dash_vp9-basic-gen2_1080p"><BaseURL>${FBCDN_720}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  const quals = parseDashManifest(xml);
  assert.equal(quals[0].label, "480p");
  assert.equal(quals[1].label, "1080p");
});

test("nativeLabelFromUrl reads the resolution out of the efg tag", () => {
  const hd = `https://video-den2-1.xx.fbcdn.net/x.mp4?efg=${encodeURIComponent(efgBase64("xpv_progressive.FACEBOOK..C3.720.dash_h264-basic-gen2_720p"))}`;
  assert.equal(nativeLabelFromUrl(hd, "HD"), "720p");
  const sd = `https://video-den2-1.xx.fbcdn.net/x.mp4?efg=${encodeURIComponent(efgBase64("xpv_progressive.FACEBOOK..C3.360.sve_sd"))}`;
  assert.equal(nativeLabelFromUrl(sd, "SD"), "360p");
  assert.equal(nativeLabelFromUrl("https://video-den2-1.xx.fbcdn.net/x.mp4", "HD"), "HD");
  assert.equal(nativeLabelFromUrl("not a url", "SD"), "SD");
});

test("extractPageTitle decodes og:title entities", () => {
  assert.equal(
    extractPageTitle(pageHtml()),
    "\u{1F631} #fyp\u30b7 #viral | JawDrop World",
  );
  assert.equal(extractPageTitle("<html></html>"), null);
});

test("buildFacebookQualities orders combined native first, then DASH video, then audio", () => {
  const quals = buildFacebookQualities(pageHtml());
  // 2 native + 3 DASH video + 1 DASH audio = 6.
  assert.equal(quals.length, 6);
  assert.equal(quals[0].label, "720p");
  assert.equal(quals[0].videoOnly, undefined);
  assert.match(quals[0].url, /HD\.mp4/);
  assert.equal(quals[1].label, "360p");
  assert.match(quals[1].url, /SD\.mp4/);
  assert.equal(quals[2].label, "720p");
  assert.equal(quals[2].videoOnly, true);
  assert.equal(quals[3].label, "540p");
  assert.equal(quals[3].videoOnly, true);
  assert.equal(quals[4].label, "360p");
  assert.equal(quals[4].videoOnly, true);
  assert.equal(quals[5].label, "audio");
  assert.equal(quals[5].audioOnly, true);
  for (const q of quals) {
    assert.match(q.url, /^https:\/\//);
    assert.ok(q.headers["User-Agent"].includes("Chrome/"));
  }
});

test("buildFacebookQualities dedupes identical URLs (native wins)", () => {
  // Point the DASH 720p BaseURL at the exact native-HD URL: the DASH
  // entry must be dropped and only the native (combined) one kept.
  const nativeHd = `https://video-den2-1.xx.fbcdn.net/o1/v/t2/f2/m366/HD.mp4?efg=${encodeURIComponent(efgBase64("xpv_progressive.FACEBOOK..C3.720.dash_h264-basic-gen2_720p"))}&oh=00_HD`;
  const dup = pageHtml().replaceAll(FBCDN_720, nativeHd);
  const quals = buildFacebookQualities(dup);
  assert.equal(quals.length, 5);
  const withUrl = quals.filter((q) => q.url === nativeHd);
  assert.equal(withUrl.length, 1);
  assert.equal(withUrl[0].id, "fb-native-hd");
});

test("buildFacebookQualities works from the legacy playable_url shape", () => {
  const blob = {
    playable_url_quality_hd: "https://video-lax3-2.xx.fbcdn.net/legacy-hd.mp4",
    playable_url: "https://video-lax3-2.xx.fbcdn.net/legacy-sd.mp4",
  };
  const html = `<html><body>${JSON.stringify(blob)}</body></html>`;
  const quals = buildFacebookQualities(html);
  assert.equal(quals.length, 2);
  assert.equal(quals[0].label, "HD");
  assert.equal(quals[0].url, "https://video-lax3-2.xx.fbcdn.net/legacy-hd.mp4");
  assert.equal(quals[1].label, "SD");
  assert.equal(quals[1].url, "https://video-lax3-2.xx.fbcdn.net/legacy-sd.mp4");
});

test("parsePlayableUrls still reads the legacy fields", () => {
  const html = JSON.stringify({
    playable_url_quality_hd: "https://x.fbcdn.net/hd.mp4",
    playable_url: "https://x.fbcdn.net/sd.mp4",
  });
  assert.deepEqual(parsePlayableUrls(html), {
    hd: "https://x.fbcdn.net/hd.mp4",
    sd: "https://x.fbcdn.net/sd.mp4",
  });
  assert.deepEqual(parsePlayableUrls("<html></html>"), {});
});

test("buildFacebookQualities returns [] on a page with no video data", () => {
  assert.deepEqual(buildFacebookQualities("<html><body>login to continue</body></html>"), []);
  assert.deepEqual(buildFacebookQualities(""), []);
});
