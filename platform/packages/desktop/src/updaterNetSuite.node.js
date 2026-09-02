// The download behavior that matters when a user stares at a stuck banner:
// resume with Range, hash across attempts, truncation detection, abort.
// Runs against a local http server; no Electron.
//
// This file runs under Node (node --test), driven by updaterNet.test.js. It is
// named so bun test does not collect it directly. The reason it is Node only: the
// updater runs in Electron's Node in production, and bun's http and fs stream
// stand-ins differ in exactly the corners these tests exercise (a WriteStream
// destroyed mid-write can flush stray bytes; a never-ending response can hold
// an abort). `expect` below is a small shim over node:assert.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const expect = (got) => ({
  toBe: (want) => assert.equal(got, want),
  toEqual: (want) => assert.deepEqual(got, want),
  toBeTruthy: () => assert.ok(got),
  toBeUndefined: () => assert.equal(got, undefined),
  toBeGreaterThanOrEqual: (n) => assert.ok(got >= n, `${got} >= ${n}`),
  toBeLessThan: (n) => assert.ok(got < n, `${got} < ${n}`),
  rejects: { toThrow: (re) => assert.rejects(got, re instanceof RegExp ? re : { message: re }) },
});
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { fetchText, downloadResumable } = require("./updaterNet");

const BODY = crypto.randomBytes(200_000);
const SHA = crypto.createHash("sha512").update(BODY).digest("base64");

// Each test gets its own server and its own keep-alive agent, so a socket a
// never-ending response holds open cannot be reused by the next test.
function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
function shutdown(srv) {
  srv.closeAllConnections?.();
  srv.close();
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "updnet-")), "file.zip");
}

test("fetchText follows a redirect and rejects on a non-200", async () => {
  const { srv, url } = await serve((req, res) => {
    if (req.url === "/r") { res.writeHead(302, { location: "/feed" }); res.end(); return; }
    if (req.url === "/feed") { res.end("version: 1.2.3\n"); return; }
    res.writeHead(404); res.end();
  });
  try {
    expect(await fetchText(`${url}/r`)).toBe("version: 1.2.3\n");
    await expect(fetchText(`${url}/nope`)).rejects.toThrow("HTTP 404");
  } finally {
    shutdown(srv);
  }
});

test("a connection cut mid-stream resumes with Range and still yields the whole-file hash", async () => {
  let calls = 0;
  const ranges = [];
  const { srv, url } = await serve((req, res) => {
    calls++;
    const range = req.headers.range;
    ranges.push(range || null);
    if (calls === 1) {
      // First attempt: announce the full size, send half, then drop the socket.
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.write(BODY.subarray(0, 100_000));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    // Second attempt resumes from whatever reached the disk (usually all
    // 100000 bytes; under load possibly fewer, or none, which is a plain GET).
    const start = range ? parseInt(range.replace("bytes=", ""), 10) : 0;
    res.writeHead(206, { "content-length": String(BODY.length - start) });
    res.end(BODY.subarray(start));
  });
  const dest = tmpFile();
  const progress = [];
  try {
    // retryDelayMs stays well above a few ms: under bun (the test runtime, not
    // the app's Electron Node) a WriteStream destroyed mid-write can flush a few
    // stray bytes after the next attempt has already measured the file.
    const got = await downloadResumable(`${url}/f`, dest, { retryDelayMs: 300, onProgress: (p) => progress.push(p) });
    expect(got).toBe(SHA);
    expect(calls).toBe(2);
    if (ranges[1]) expect(/^bytes=\d+-$/.test(ranges[1])).toBe(true);
    expect(fs.readFileSync(dest).equals(BODY)).toBe(true);
    // Progress is whole-file percent. Within one attempt it only rises; a
    // resumed attempt restarts from the bytes that reached the disk, which can
    // be fewer than the cut attempt had counted (the donor behaves the same), so
    // across attempts only the final value is pinned.
    expect(progress[0]).toBeLessThan(100);
    expect(Math.max(...progress)).toBeGreaterThanOrEqual(99);
  } finally {
    shutdown(srv);
  }
});

test("a server that ignores Range restarts the hash from zero", async () => {
  let calls = 0;
  const { srv, url } = await serve((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.write(BODY.subarray(0, 50_000));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.end(BODY);
  });
  const dest = tmpFile();
  try {
    expect(await downloadResumable(`${url}/f`, dest, { retryDelayMs: 10 })).toBe(SHA);
    expect(fs.readFileSync(dest).length).toBe(BODY.length);
  } finally {
    shutdown(srv);
  }
});

test("a response that closes short of content-length fails the attempt, and attempts run out", async () => {
  // Node's http server will not end a response early itself, so write the
  // lying response on the raw socket: 200000 announced, 1000 sent, then close.
  let calls = 0;
  const { srv, url } = await serve((req, res) => {
    calls++;
    const sock = res.socket;
    sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n`);
    sock.write(BODY.subarray(0, 1000));
    sock.end();
  });
  const dest = tmpFile();
  try {
    let err = null;
    try { await downloadResumable(`${url}/f`, dest, { attempts: 2, retryDelayMs: 300 }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.aborted).toBeUndefined();
    expect(calls).toBe(2);
  } finally {
    shutdown(srv);
  }
});

test("abort rejects promptly with e.aborted and does not retry", async () => {
  let calls = 0;
  const { srv, url } = await serve((_req, res) => {
    calls++;
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.flushHeaders();
    res.write(BODY.subarray(0, 1000));
    // never ends; the client must abort
  });
  const dest = tmpFile();
  const ac = new AbortController();
  try {
    const p = downloadResumable(`${url}/f`, dest, { signal: ac.signal, attempts: 3, retryDelayMs: 5, inactivityMs: 5000 });
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    let err = null;
    try { await p; } catch (e) { err = e; }
    expect(err?.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    // The abort may land before or after the server saw the request (0 or 1
    // calls, both prompt); what must not happen is a retry after it.
    expect(calls <= 1).toBe(true);
    const before = calls;
    // An already-aborted signal never starts a request.
    let err2 = null;
    try { await downloadResumable(`${url}/f`, dest, { signal: ac.signal }); } catch (e) { err2 = e; }
    expect(err2?.aborted).toBe(true);
    expect(calls).toBe(before);
  } finally {
    shutdown(srv);
  }
});

test("inactivity kills a stalled attempt", async () => {
  let calls = 0;
  const { srv, url } = await serve((_req, res) => {
    calls++;
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.flushHeaders();
    res.write(BODY.subarray(0, 10));
    // then silence
  });
  const dest = tmpFile();
  try {
    await expect(downloadResumable(`${url}/f`, dest, { attempts: 2, retryDelayMs: 5, inactivityMs: 60 })).rejects.toThrow(/stalled/);
    expect(calls).toBe(2);
  } finally {
    shutdown(srv);
  }
});
