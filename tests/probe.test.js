// Stream probing tests — against a local loopback HTTP server (no internet).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probeStream, probeQualities, sortWorkingFirst } from "../lib/probe.js";

let base;
let server;

test.before(async () => {
  server = createServer((req, res) => {
    const url = req.url;
    if (url === "/ok.mp4") {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": "1000", "Content-Type": "video/mp4" });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end("x".repeat(100));
      }
    } else if (url === "/head403.mp4") {
      if (req.method === "HEAD") {
        res.writeHead(403);
        res.end();
      } else if (req.headers.range === "bytes=0-0") {
        res.writeHead(206, { "Content-Range": "bytes 0-0/1000", "Content-Length": "1" });
        res.end("x");
      } else {
        res.writeHead(200);
        res.end("x".repeat(100));
      }
    } else if (url === "/headhang.mp4") {
      // HEAD never answers (TikTok v16 sometimes hangs HEAD) — ranged GET serves.
      if (req.method === "HEAD") {
        return; // hang on purpose; the client's HEAD timeout must not end the probe
      }
      if (req.headers.range === "bytes=0-0") {
        res.writeHead(206, { "Content-Range": "bytes 0-0/1000", "Content-Length": "1" });
        res.end("x");
      } else {
        res.writeHead(200);
        res.end("x".repeat(100));
      }
    } else if (url === "/head404.mp4") {
      // HEAD fails AND ranged GET fails — a dead URL.
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("probeStream: HEAD 200 is ok", async () => {
  const r = await probeStream(`${base}/ok.mp4`);
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.host, "127.0.0.1");
});

test("probeStream: HEAD 403 falls back to ranged GET 206 (TikTok v16 behaviour)", async () => {
  const r = await probeStream(`${base}/head403.mp4`);
  assert.equal(r.status, 206);
  assert.equal(r.ok, true);
});

test("probeStream: hanging HEAD falls back to ranged GET 206", async () => {
  const r = await probeStream(`${base}/headhang.mp4`);
  assert.equal(r.status, 206);
  assert.equal(r.ok, true);
});

test("probeStream: HEAD 404 + GET 404 is not ok", async () => {
  const r = await probeStream(`${base}/head404.mp4`);
  assert.equal(r.status, 404);
  assert.equal(r.ok, false);
});

test("probeStream: unreachable host reports status 0, not a throw", async () => {
  const r = await probeStream("http://127.0.0.1:1/nope.mp4");
  assert.equal(r.status, 0);
  assert.equal(r.ok, false);
});

test("probeQualities + sortWorkingFirst keep all qualities, working first", async () => {
  const qualities = [
    { id: "dead", url: `${base}/head404.mp4` },
    { id: "good", url: `${base}/ok.mp4` },
    { id: "fallback", url: `${base}/head403.mp4` },
  ];
  const probes = await probeQualities(qualities);
  assert.equal(probes.length, 3);
  assert.equal(probes.find((p) => p.qualityId === "good").ok, true);
  assert.equal(probes.find((p) => p.qualityId === "dead").ok, false);
  const sorted = sortWorkingFirst(qualities, probes);
  assert.equal(sorted[2].id, "dead"); // dead last, but still present
  assert.deepEqual(sorted.map((q) => q.id).sort(), ["dead", "fallback", "good"]);
});

test("probeQualities limit probes only the first N (YouTube sample)", async () => {
  const qualities = [
    { id: "q1", url: `${base}/ok.mp4` },
    { id: "q2", url: `${base}/ok.mp4` },
    { id: "q3", url: `${base}/ok.mp4` },
    { id: "q4", url: `${base}/ok.mp4` },
    { id: "q5", url: `${base}/ok.mp4` },
  ];
  const probes = await probeQualities(qualities, { limit: 3 });
  assert.equal(probes.length, 3);
  assert.deepEqual(probes.map((p) => p.qualityId), ["q1", "q2", "q3"]);
  // Unprobed qualities are not dropped by the sort — they keep position.
  const sorted = sortWorkingFirst(qualities, probes);
  assert.deepEqual(sorted.map((q) => q.id).sort(), ["q1", "q2", "q3", "q4", "q5"]);
});

test("probeStream counts cookies by name only, never values", async () => {
  const r = await probeStream(`${base}/ok.mp4`, { Cookie: "ttwid=SECRETVALUE; tt_csrf_token=SECRET2" });
  assert.equal(r.cookies, 2);
  assert.deepEqual(r.cookieNames, ["ttwid", "tt_csrf_token"]);
  assert.equal(JSON.stringify(r).includes("SECRETVALUE"), false);
});
