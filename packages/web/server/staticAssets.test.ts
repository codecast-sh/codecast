import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isBuildArtifactPath, registerHashedAssets, registerMissingArtifactGuard } from "./staticAssets";

// Mirrors the prod registration order in index.ts: hashed assets first, the
// missing-artifact guard after static serving, the SPA shell last.
let dist: string;
let app: Hono;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "cc-static-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "assets", "CommandPalette-DoysUxap.js"), "export const live = 1;\n");
  app = new Hono();
  registerHashedAssets(app, dist);
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
    for (const path of ["/workbox-fed2bdfe.js", "/sw.js", "/registerSW.js", "/manifest.webmanifest"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
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
