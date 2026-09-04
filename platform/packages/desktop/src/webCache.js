// A full local copy of the web app, keyed by the release id the site publishes.
//
// The site ships `release.json` (written by templates/vite-release-manifest.js):
// a release id that changes with any file, and every file with its sha256.
// The shell keeps one complete copy of the site under
// userData/web-cache/<release>/ and serves the app host from it. Online, a
// refresh fetches the manifest and, when the id differs, downloads the whole
// release into a staging directory, verifies each file, and swaps the pointer
// in one rename. Offline, the copy is the app. Pure Node: fetch is injected,
// so the whole flow runs under a test without a network or Electron.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The manifest the site publishes. `files` is a map of site-relative path to
// sha256; an array of paths (no hashes) is accepted and verified by presence
// only. Throws on anything that is not a manifest.
function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("release manifest is not JSON");
  }
  if (!data || typeof data.release !== "string" || !/^[A-Za-z0-9._-]{4,128}$/.test(data.release)) {
    throw new Error("release manifest needs a release id");
  }
  let files = {};
  if (Array.isArray(data.files)) {
    for (const f of data.files) files[f] = null;
  } else if (data.files && typeof data.files === "object") {
    files = { ...data.files };
  } else {
    throw new Error("release manifest needs files");
  }
  for (const f of Object.keys(files)) {
    if (typeof f !== "string" || !f || f.startsWith("/") || f.split("/").includes("..")) {
      throw new Error(`release manifest has a bad path: ${f}`);
    }
  }
  if (!("index.html" in files)) throw new Error("release manifest has no index.html");
  return { release: data.release, commit: typeof data.commit === "string" ? data.commit : null, files };
}

// Walk a manifest's files, computing the id the same way the Vite plugin does,
// so a seed copied at build time and a download agree on the name.
function releaseIdFor(files) {
  const lines = Object.keys(files).sort().map((f) => `${f}:${files[f] || ""}`);
  return sha256(lines.join("\n")).slice(0, 20);
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// A fetch failure (no network, DNS, connection refused) is a TypeError from
// fetch itself; an abort is an AbortError. Everything else is a real error.
function isOffline(err) {
  return !!err && (err.name === "AbortError" || err.name === "TypeError" || err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT");
}

// Which files must match the manifest's hash byte for byte.
//
// "all" is the honest default. "assets" exists because a CDN may legitimately
// rewrite the HTML it serves — Cloudflare's email address obfuscation turns a
// mailto: link into a script, so the document on the wire is not the document
// that was built — and a release that can never verify is a desktop app that
// silently stops updating. Under "assets" every script, stylesheet and font is
// still verified, which is where the code lives; the document is trusted to
// the same degree the TLS connection to the origin is.
const DOCUMENT_EXT = new Set([".html", ".htm"]);
const VERIFY_MODES = new Set(["all", "assets"]);

function mustVerify(file, mode) {
  if (mode !== "assets") return true;
  return !DOCUMENT_EXT.has(path.extname(file).toLowerCase());
}

function createWebCache({ dir, origin, manifestPath = "/release.json", fetchImpl = globalThis.fetch, seedDir = null, concurrency = 8, verify = "all", log = () => {} }) {
  if (!dir) throw new Error("webCache: dir is required");
  if (!/^https?:\/\//.test(origin || "")) throw new Error("webCache: origin must be http(s)");
  if (!VERIFY_MODES.has(verify)) throw new Error(`webCache: verify must be "all" or "assets"`);
  origin = origin.replace(/\/+$/, "");
  const pointer = path.join(dir, "current");
  let release = null;
  let releaseDir = null;
  let inflight = null;

  function setCurrent(id) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${pointer}.tmp`;
    fs.writeFileSync(tmp, id);
    fs.renameSync(tmp, pointer);
    release = id;
    releaseDir = path.join(dir, id);
  }

  function readPointer() {
    try {
      const id = fs.readFileSync(pointer, "utf8").trim();
      if (id && fs.existsSync(path.join(dir, id, "index.html"))) {
        release = id;
        releaseDir = path.join(dir, id);
        return true;
      }
    } catch {}
    return false;
  }

  // The packaged seed: a copy of the site from build time, used when nothing
  // has been downloaded yet, so a first launch works without a network.
  function seed() {
    if (!seedDir) return false;
    let manifest;
    try {
      manifest = parseManifest(fs.readFileSync(path.join(seedDir, "release.json"), "utf8"));
    } catch {
      return false;
    }
    const target = path.join(dir, manifest.release);
    if (!fs.existsSync(path.join(target, "index.html"))) {
      const stage = `${target}.partial`;
      rmrf(stage);
      copyTree(seedDir, stage);
      rmrf(target);
      fs.renameSync(stage, target);
    }
    setCurrent(manifest.release);
    log(`web-cache: seeded ${manifest.release}`);
    return true;
  }

  function init() {
    fs.mkdirSync(dir, { recursive: true });
    if (!readPointer()) seed();
    prune();
    return current();
  }

  function current() {
    return release ? { release, dir: releaseDir } : null;
  }

  // Everything but the current release is garbage: the swap is atomic, so a
  // half-downloaded stage or a superseded copy has no use.
  function prune() {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "current" || name === "current.tmp" || name === release) continue;
      rmrf(path.join(dir, name));
    }
  }

  // Site path → file inside the current release, or null. Directories serve
  // their index.html. Traversal cannot escape the release directory.
  function resolve(pathname) {
    if (!releaseDir) return null;
    let rel;
    try {
      rel = decodeURIComponent(pathname || "/");
    } catch {
      return null;
    }
    rel = path.posix.normalize(rel).replace(/^\/+/, "");
    if (rel === "." || rel === "") rel = "";
    const file = path.join(releaseDir, rel);
    if (file !== releaseDir && !file.startsWith(releaseDir + path.sep)) return null;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (st.isDirectory()) {
      const idx = path.join(file, "index.html");
      return fs.existsSync(idx) ? idx : null;
    }
    return file;
  }

  function indexFile() {
    return releaseDir ? path.join(releaseDir, "index.html") : null;
  }

  // bypassCustomProtocolHandlers: in Electron the shell intercepts the app
  // host to serve this very copy; the copy's own downloads must reach the
  // network. Plain fetch ignores the option.
  async function fetchOk(url, opts) {
    const res = await fetchImpl(url, { cache: "no-store", redirect: "follow", bypassCustomProtocolHandlers: true, ...opts });
    if (!res.ok) throw Object.assign(new Error(`${res.status} for ${url}`), { status: res.status });
    return res;
  }

  async function download(manifest, { signal } = {}) {
    const stage = path.join(dir, `${manifest.release}.partial`);
    rmrf(stage);
    fs.mkdirSync(stage, { recursive: true });
    const queue = Object.entries(manifest.files);
    let failed = null;
    async function worker() {
      while (queue.length && !failed) {
        const [file, hash] = queue.shift();
        try {
          const res = await fetchOk(`${origin}/${file.split("/").map(encodeURIComponent).join("/")}`, { signal });
          const buf = Buffer.from(await res.arrayBuffer());
          if (hash && sha256(buf) !== hash && mustVerify(file, verify)) {
            throw new Error(`hash mismatch for ${file}`);
          }
          const dest = path.join(stage, file);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        } catch (err) {
          failed = failed || err;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (failed) {
      rmrf(stage);
      throw failed;
    }
    fs.writeFileSync(path.join(stage, "release.json"), JSON.stringify({ release: manifest.release, commit: manifest.commit, files: manifest.files }));
    const target = path.join(dir, manifest.release);
    rmrf(target);
    fs.renameSync(stage, target);
  }

  // One refresh at a time; a second caller joins the one in flight.
  function refresh(opts = {}) {
    if (inflight) return inflight;
    inflight = runRefresh(opts).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function runRefresh({ signal } = {}) {
    const from = release;
    let manifest;
    try {
      const res = await fetchOk(`${origin}${manifestPath}?r=${Date.now()}`, { signal });
      manifest = parseManifest(await res.text());
    } catch (err) {
      const status = isOffline(err) ? "offline" : "error";
      log(`web-cache: manifest ${status}: ${err.message}`);
      return { status, release: from, error: err.message };
    }
    if (manifest.release === release) return { status: "fresh", release };
    try {
      await download(manifest, { signal });
    } catch (err) {
      const status = isOffline(err) ? "offline" : "error";
      log(`web-cache: download ${status}: ${err.message}`);
      return { status, release: from, error: err.message };
    }
    setCurrent(manifest.release);
    prune();
    log(`web-cache: ${from ? `${from} → ` : ""}${manifest.release}`);
    return { status: "updated", release: manifest.release, from };
  }

  return { init, current, refresh, resolve, indexFile, seed, prune, dir, origin };
}

// Which way a request goes. Pure so the rules can be tested without a
// network: only GET/HEAD for the app host may be served from the copy;
// paths the app reserves for its server (`passthrough`) always go out; a
// navigation that misses the copy gets its index.html (the SPA fallback,
// same as the site's own server); anything else goes to the network.
function planRequest({ method, url, appHosts, cache, passthrough = [], headers = {} }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: "network", fallback: null };
  }
  const get = method === "GET" || method === "HEAD";
  if (!get || !appHosts.has(u.host)) return { kind: "network", fallback: null };
  if (passthrough.some((p) => u.pathname.startsWith(p))) return { kind: "network", fallback: null };
  const file = cache.resolve(u.pathname);
  if (file) return { kind: "file", file };
  const dest = String(headers["sec-fetch-dest"] || "").toLowerCase();
  const accept = String(headers["accept"] || "");
  const navigation = dest === "document" || dest === "iframe" || (!dest && accept.includes("text/html"));
  if (navigation && cache.indexFile()) return { kind: "file", file: cache.indexFile() };
  return { kind: "network", fallback: navigation ? "offline-page" : null };
}

function offlinePage(productName) {
  return `<!doctype html><meta charset="utf-8"><title>${productName} is offline</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333;background:#f6f3ec}main{max-width:32em;text-align:center;line-height:1.5}button{font:inherit;padding:.5em 1.2em;margin-top:1em}</style>
<main><h1>${productName} needs a connection</h1><p>The first launch downloads the app so it can work offline afterwards. Connect to the internet and try again.</p><button onclick="location.reload()">Try again</button></main>`;
}

// The Electron protocol handler: a Request in, a Response out. `net` is
// Electron's net (net.fetch with bypassCustomProtocolHandlers passes the
// request through unchanged); injected so the test can fake it.
function createProtocolHandler({ cache, appHosts, passthrough, net, productName = "This app", onNetworkError = () => {} }) {
  return async function handle(request) {
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    const plan = planRequest({ method: request.method, url: request.url, appHosts: appHosts(), cache, passthrough, headers });
    if (plan.kind === "file") {
      const body = request.method === "HEAD" ? null : fs.readFileSync(plan.file);
      return new Response(body, {
        status: 200,
        headers: { "content-type": mimeFor(plan.file), "cache-control": "no-cache" },
      });
    }
    try {
      return await net.fetch(request, { bypassCustomProtocolHandlers: true });
    } catch (err) {
      onNetworkError(err, request.url);
      if (plan.fallback === "offline-page") {
        return new Response(offlinePage(productName), { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      throw err;
    }
  };
}

module.exports = { createWebCache, parseManifest, planRequest, createProtocolHandler, mimeFor, releaseIdFor, offlinePage, sha256 };
