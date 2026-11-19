// Main handler routing tests — fake req/res, no network.
// POSTs that pass validation never reach a resolver here: they use URLs
// that fail validation, or the /direct path with a localhost URL that the
// resolver would probe (avoided — validation tests stop before fetching).
import test from "node:test";
import assert from "node:assert/strict";
import handler, { platformFromPath } from "../index.js";

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: false };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.setHeader = (n, v) => {
    r.headers[n] = v;
  };
  r.json = (b) => {
    r.body = b;
  };
  r.end = () => {
    r.ended = true;
  };
  return r;
}

const req = (method, url, body, query = {}) => ({ method, url, body, query });

test("platformFromPath maps clean paths", () => {
  assert.equal(platformFromPath("/tiktok"), "tiktok");
  assert.equal(platformFromPath("/youtube"), "youtube");
  assert.equal(platformFromPath("/api/health"), "health");
  assert.equal(platformFromPath("/"), null);
  assert.equal(platformFromPath("/nope"), undefined);
});

test("GET /api/health returns { ok: true }", async () => {
  const res = fakeRes();
  await handler(req("GET", "/api/health"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("GET / lists the endpoints", async () => {
  const res = fakeRes();
  await handler(req("GET", "/"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.endpoints.includes("/tiktok"));
  assert.ok(res.body.endpoints.includes("/youtube"));
});

test("OPTIONS answers 204 with CORS headers", async () => {
  const res = fakeRes();
  await handler(req("OPTIONS", "/tiktok"), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});

test("unknown path is 404 NOT_FOUND", async () => {
  const res = fakeRes();
  await handler(req("POST", "/nope", { url: "https://example.com/x" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
});

test("GET on a platform endpoint is 405", async () => {
  const res = fakeRes();
  await handler(req("GET", "/tiktok"), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error.code, "UNSUPPORTED");
});

test("POST without a url is 400 UNSUPPORTED", async () => {
  const res = fakeRes();
  await handler(req("POST", "/tiktok", {}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "UNSUPPORTED");
});

test("POST a YouTube link to /tiktok is 400 UNSUPPORTED (strict routes)", async () => {
  const res = fakeRes();
  await handler(req("POST", "/tiktok", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "UNSUPPORTED");
  assert.match(res.body.error.message, /not a tiktok URL/);
});

test("Vercel-style ?platform= query works the same as the clean path", async () => {
  const res = fakeRes();
  await handler(req("POST", "/api/index?platform=tiktok", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, { platform: "tiktok" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "UNSUPPORTED");
});
