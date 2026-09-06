import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isBuildArtifactPath, registerHashedAssets, registerMissingArtifactGuard, registerStableEntryPoints, STABLE_ENTRY_POINTS } from "./staticAssets";

// Mirrors the prod registration order in index.ts: hashed assets first, the
// missing-artifact guard after static serving, the SPA shell last.
let dist: string;
let app: Hono;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "cc-static-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "assets", "CommandPalette-DoysUxap.js"), "export const live = 1;\n");
  await writeFile(join(dist, "sw.js"), "// worker\n");
  await writeFile(join(dist, "registerSW.js"), "// register\n");
  await writeFile(join(dist, "manifest.webmanifest"), "{}\n");
  await writeFile(join(dist, "workbox-abc12345.js"), "// workbox\n");
  app = new Hono();
  registerHashedAssets(app, dist);
  registerStableEntryPoints(app);
  // Stands in for serveStatic: answers any file that exists in dist, and — like
  // serveStatic — sets no Cache-Control of its own, which is the condition that
  // let Cloudflare impose its four-hour TTL on the worker.
  app.use("*", async (c, next) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname).slice(1);
    try {
      const body = await readFile(join(dist, rel), "utf-8");
      return c.body(body);
    } catch {
      return next();
    }
  });
  registerMissingArtifactGuard(app);
  app.get("*", (c) => c.html("<!DOCTYPE html><html>shell</html>"));
});

afterAll(() => rm(dist, { recursive: true, force: true }));

describe("build artifacts never fall through to the SPA shell", () => {
  test("a present hashed asset is served immutable as JavaScript", async () => {
    const res = await app.request("/assets/CommandPalette-DoysUxap.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("live");
  });

  test("a chunk from another build is an uncacheable 404, not 200 text/html", async () => {
    // The stale-tab / mid-rollout case: this hash exists in a different build.
    const res = await app.request("/assets/CommandPalette-BoCs8I5T.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("a missing root build file (workbox, sw, manifest) is also a 404", async () => {
    // Its own app: the shared fixture ships these files, and the point here is
    // what happens when the build did NOT emit them.
    const empty = new Hono();
    registerStableEntryPoints(empty);
    registerMissingArtifactGuard(empty);
    empty.get("*", (c) => c.html("<!DOCTYPE html><html>shell</html>"));
    for (const path of ["/workbox-fed2bdfe.js", "/sw.js", "/registerSW.js", "/manifest.webmanifest"]) {
      const res = await empty.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control") ?? "").toContain("no-store");
    }
  });

  test("app routes still reach the shell, including dotted paths outside /assets", async () => {
    for (const path of ["/inbox", "/conversation/abc123", "/repo/owner/name/src/index.js", "/u/first.last"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("shell");
    }
  });

  test("isBuildArtifactPath stays narrow", () => {
    expect(isBuildArtifactPath("/assets/x.js")).toBe(true);
    expect(isBuildArtifactPath("/assets/nested/x.woff2")).toBe(true);
    expect(isBuildArtifactPath("/sw.js")).toBe(true);
    expect(isBuildArtifactPath("/docs/guide.js")).toBe(false);
    expect(isBuildArtifactPath("/favicon.ico")).toBe(false);
    expect(isBuildArtifactPath("/inbox")).toBe(false);
  });
});

// A service worker served from a cacheable stable URL pins every existing
// client to the bundle it precached. codecast.sh shipped a good build on
// 2026-09-06 and kept serving the previous day's worker for 95 minutes,
// because the origin sent no Cache-Control and Cloudflare supplied a
// four-hour one of its own.
describe("stable entry points are never cached", () => {
  for (const path of STABLE_ENTRY_POINTS) {
    test(`${path} forbids storing, so no edge can serve a superseded copy`, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc).toContain("no-store");
      // The empty header is the actual bug: Cloudflare fills the gap itself.
      expect(cc).not.toBe("");
      expect(cc).not.toContain("max-age=14400");
    });
  }

  test("the hashed workbox chunk keeps ordinary caching — its name already busts", async () => {
    const res = await app.request("/workbox-abc12345.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store");
  });

  test("a missing stable entry point is still an uncacheable 404, not the shell", async () => {
    const fresh = new Hono();
    registerStableEntryPoints(fresh);
    registerMissingArtifactGuard(fresh);
    fresh.get("*", (c) => c.html("<!DOCTYPE html><html>shell</html>"));
    const res = await fresh.request("/sw.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
