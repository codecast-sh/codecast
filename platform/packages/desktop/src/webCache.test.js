// The offline copy under a fake site: refresh, fresh, offline, a bad hash, the
// seed, request planning and the protocol handler. No network, no Electron.
const { test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWebCache, parseManifest, planRequest, createProtocolHandler, releaseIdFor, sha256 } = require("./webCache");
const { buildManifest, writeManifest } = require("../templates/vite-release-manifest");

const ORIGIN = "https://whisk.email";

// A site is a map of path → content; the fake fetch serves it and counts.
function fakeSite(files, { offline = false } = {}) {
  const hashes = {};
  for (const [f, c] of Object.entries(files)) hashes[f] = sha256(Buffer.from(c));
  const manifest = { release: releaseIdFor(hashes), commit: "abc123", files: hashes };
  const site = {
    files,
    manifest,
    offline,
    requests: [],
    fetch: async (url) => {
      site.requests.push(url);
      if (site.offline) throw new TypeError("fetch failed");
      const u = new URL(url);
      const p = decodeURIComponent(u.pathname).replace(/^\//, "");
      if (p === "release.json") return new Response(JSON.stringify(site.manifest), { status: 200 });
      if (p in site.files) return new Response(site.files[p], { status: 200 });
      return new Response("nope", { status: 404 });
    },
  };
  return site;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webcache-"));
}

const SITE_V1 = { "index.html": "<html>v1</html>", "assets/app-1.js": "console.log(1)", "privacy/index.html": "<p>privacy</p>" };
const SITE_V2 = { "index.html": "<html>v2</html>", "assets/app-2.js": "console.log(2)", "privacy/index.html": "<p>privacy</p>" };

test("first refresh downloads the whole release; a second is fresh; a new release swaps atomically", async () => {
  const site = fakeSite(SITE_V1);
  const dir = tmp();
  const cache = createWebCache({ dir, origin: ORIGIN, fetchImpl: site.fetch });
  expect(cache.init()).toBeNull();
  expect(cache.resolve("/")).toBeNull();

  const r1 = await cache.refresh();
  expect(r1.status).toBe("updated");
  expect(r1.release).toBe(site.manifest.release);
  expect(fs.readFileSync(cache.resolve("/"), "utf8")).toBe("<html>v1</html>");
  expect(fs.readFileSync(cache.resolve("/assets/app-1.js"), "utf8")).toBe("console.log(1)");
  expect(cache.resolve("/privacy/")).toEndWith(path.join("privacy", "index.html"));
  expect(cache.resolve("/privacy")).toEndWith(path.join("privacy", "index.html"));
  expect(fs.readFileSync(path.join(dir, "current"), "utf8")).toBe(site.manifest.release);

  const r2 = await cache.refresh();
  expect(r2.status).toBe("fresh");
  // Only the manifest was fetched the second time.
  expect(site.requests.filter((u) => !u.includes("release.json")).length).toBe(3);

  const v1 = site.manifest.release;
  Object.assign(site, fakeSite(SITE_V2));
  const r3 = await cache.refresh();
  expect(r3).toMatchObject({ status: "updated", from: v1 });
  expect(fs.readFileSync(cache.resolve("/index.html"), "utf8")).toBe("<html>v2</html>");
  expect(cache.resolve("/assets/app-1.js")).toBeNull();
  // The old release and any stage directory are gone.
  expect(fs.readdirSync(dir).sort()).toEqual(["current", site.manifest.release].sort());

  // A fresh instance over the same directory picks the pointer up.
  const again = createWebCache({ dir, origin: ORIGIN, fetchImpl: site.fetch });
  expect(again.init()).toEqual({ release: site.manifest.release, dir: path.join(dir, site.manifest.release) });
});

test("offline keeps the current copy and reports offline; a bad hash rejects the download", async () => {
  const site = fakeSite(SITE_V1);
  const dir = tmp();
  const cache = createWebCache({ dir, origin: ORIGIN, fetchImpl: site.fetch });
  cache.init();
  await cache.refresh();
  const v1 = site.manifest.release;

  site.offline = true;
  expect(await cache.refresh()).toMatchObject({ status: "offline", release: v1 });
  expect(fs.readFileSync(cache.resolve("/"), "utf8")).toBe("<html>v1</html>");

  site.offline = false;
  site.manifest = { release: "tampered-0001", commit: null, files: { ...site.manifest.files, "index.html": "0".repeat(64) } };
  const r = await cache.refresh();
  expect(r.status).toBe("error");
  expect(r.error).toContain("hash mismatch");
  expect(cache.current().release).toBe(v1);
  expect(fs.existsSync(path.join(dir, "tampered-0001.partial"))).toBe(false);
});

test("a packaged seed serves a first launch with no network", async () => {
  const seedDir = tmp();
  for (const [f, c] of Object.entries(SITE_V1)) {
    fs.mkdirSync(path.dirname(path.join(seedDir, f)), { recursive: true });
    fs.writeFileSync(path.join(seedDir, f), c);
  }
  const seedManifest = writeManifest(seedDir, { commit: "seed" });
  const site = fakeSite(SITE_V1, { offline: true });
  const cache = createWebCache({ dir: tmp(), origin: ORIGIN, fetchImpl: site.fetch, seedDir });
  expect(cache.init().release).toBe(seedManifest.release);
  expect(fs.readFileSync(cache.resolve("/"), "utf8")).toBe("<html>v1</html>");
  expect((await cache.refresh()).status).toBe("offline");
  // The seed's id equals the site's for the same bytes, so going online is a no-op.
  site.offline = false;
  expect((await cache.refresh()).status).toBe("fresh");
});

test("resolve never leaves the release directory", async () => {
  const site = fakeSite(SITE_V1);
  const cache = createWebCache({ dir: tmp(), origin: ORIGIN, fetchImpl: site.fetch });
  cache.init();
  await cache.refresh();
  expect(cache.resolve("/../current")).toBeNull();
  expect(cache.resolve("/assets/../../current")).toBeNull();
  expect(cache.resolve("/%2e%2e/current")).toBeNull();
  expect(cache.resolve("/missing.js")).toBeNull();
});

test("parseManifest rejects what is not a manifest", () => {
  expect(() => parseManifest("nope")).toThrow("not JSON");
  expect(() => parseManifest(JSON.stringify({ files: {} }))).toThrow("release id");
  expect(() => parseManifest(JSON.stringify({ release: "abcd", files: { "a.js": "x" } }))).toThrow("index.html");
  expect(() => parseManifest(JSON.stringify({ release: "abcd", files: { "index.html": "x", "../x": "y" } }))).toThrow("bad path");
  expect(parseManifest(JSON.stringify({ release: "abcd", files: ["index.html"] })).files).toEqual({ "index.html": null });
});

test("buildManifest is deterministic over content and changes with any byte", () => {
  const a = tmp();
  fs.writeFileSync(path.join(a, "index.html"), "x");
  fs.mkdirSync(path.join(a, "assets"));
  fs.writeFileSync(path.join(a, "assets", "a.js"), "1");
  const m1 = buildManifest(a, { commit: "c" });
  const m2 = buildManifest(a, { commit: "c" });
  expect(m1.release).toBe(m2.release);
  expect(Object.keys(m1.files)).toEqual(["assets/a.js", "index.html"]);
  fs.writeFileSync(path.join(a, "assets", "a.js"), "2");
  expect(buildManifest(a, { commit: "c" }).release).not.toBe(m1.release);
  // The manifest itself is never part of its own hash.
  writeManifest(a, { commit: "c" });
  expect(buildManifest(a, { commit: "c" }).release).toBe(buildManifest(a, { commit: "c" }).release);
});

test("planRequest: app host GETs come from the copy, navigations fall back to index, the rest goes out", async () => {
  const site = fakeSite(SITE_V1);
  const cache = createWebCache({ dir: tmp(), origin: ORIGIN, fetchImpl: site.fetch });
  cache.init();
  await cache.refresh();
  const hosts = new Set(["whisk.email"]);
  const plan = (o) => planRequest({ appHosts: hosts, cache, passthrough: ["/api/"], method: "GET", headers: {}, ...o });
  expect(plan({ url: "https://whisk.email/" }).kind).toBe("file");
  expect(plan({ url: "https://whisk.email/assets/app-1.js" }).kind).toBe("file");
  expect(plan({ url: "https://whisk.email/inbox/42", headers: { "sec-fetch-dest": "document" } })).toEqual({ kind: "file", file: cache.indexFile() });
  expect(plan({ url: "https://whisk.email/inbox/42", headers: { accept: "text/html,*/*" } }).kind).toBe("file");
  expect(plan({ url: "https://whisk.email/missing.js", headers: { "sec-fetch-dest": "script" } })).toEqual({ kind: "network", fallback: null });
  expect(plan({ url: "https://whisk.email/api/thing", headers: { "sec-fetch-dest": "document" } })).toEqual({ kind: "network", fallback: null });
  expect(plan({ url: "https://whisk.email/", method: "POST" }).kind).toBe("network");
  expect(plan({ url: "https://determined-fox.convex.cloud/api" }).kind).toBe("network");
  expect(plan({ url: "not a url" }).kind).toBe("network");
});

test("the protocol handler serves files with a mime type and answers an offline first launch with a page", async () => {
  const site = fakeSite(SITE_V1);
  const cache = createWebCache({ dir: tmp(), origin: ORIGIN, fetchImpl: site.fetch });
  cache.init();
  const passed = [];
  let netOffline = false;
  const net = {
    fetch: async (req) => {
      passed.push(req.url);
      if (netOffline) throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
      return new Response("from network", { status: 200 });
    },
  };
  const handle = createProtocolHandler({ cache, appHosts: () => new Set(["whisk.email"]), passthrough: [], net, productName: "Whisk" });

  // Empty copy, offline: a navigation gets the offline page, not a crash.
  netOffline = true;
  const first = await handle(new Request("https://whisk.email/", { headers: { "sec-fetch-dest": "document" } }));
  expect(first.status).toBe(503);
  expect(await first.text()).toContain("Whisk needs a connection");
  // A non-navigation miss surfaces the network error to Chromium.
  await expect(handle(new Request("https://whisk.email/x.js", { headers: { "sec-fetch-dest": "script" } }))).rejects.toThrow();

  netOffline = false;
  await cache.refresh();
  const page = await handle(new Request("https://whisk.email/"));
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toBe("<html>v1</html>");
  const js = await handle(new Request("https://whisk.email/assets/app-1.js"));
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const head = await handle(new Request("https://whisk.email/assets/app-1.js", { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  // Third-party and POST requests pass through untouched.
  await handle(new Request("https://api.example/x", { method: "POST", body: "b" }));
  expect(passed).toEqual(["https://whisk.email/", "https://whisk.email/x.js", "https://api.example/x"]);
});
