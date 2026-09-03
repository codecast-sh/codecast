import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { metadataPathFor, watchOptimizerCache } from "./depsCacheGuard";

function tmpMetadata(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-guard-"));
  const deps = path.join(dir, "deps");
  fs.mkdirSync(deps);
  const file = path.join(deps, "_metadata.json");
  fs.writeFileSync(file, "{}");
  return file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

describe("watchOptimizerCache", () => {
  test("fires once the metadata file stays missing past the grace period", async () => {
    const file = tmpMetadata();
    let fired = 0;
    const stop = watchOptimizerCache({
      metadataPath: file,
      onPurged: () => fired++,
      intervalMs: 20,
      graceMs: 60,
    });
    fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
    expect(await waitFor(() => fired === 1)).toBe(true);
    // Fires once, not on every later poll.
    await sleep(150);
    stop();
    expect(fired).toBe(1);
  });

  test("stays quiet when the file comes back within the grace period", async () => {
    const file = tmpMetadata();
    let fired = 0;
    const stop = watchOptimizerCache({
      metadataPath: file,
      onPurged: () => fired++,
      intervalMs: 20,
      graceMs: 200,
    });
    fs.rmSync(file);
    await sleep(40);
    fs.writeFileSync(file, "{}");
    await sleep(400);
    stop();
    expect(fired).toBe(0);
  });

  test("ignores a cache that never existed (boot before the first optimize)", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deps-guard-")), "deps", "_metadata.json");
    let fired = 0;
    const stop = watchOptimizerCache({ metadataPath: file, onPurged: () => fired++, intervalMs: 20, graceMs: 40 });
    await sleep(150);
    stop();
    expect(fired).toBe(0);
  });

  test("watches the client deps metadata under the resolved cacheDir", () => {
    expect(metadataPathFor({ config: { cacheDir: "/repo/packages/web/node_modules/.vite" } } as any)).toBe(
      "/repo/packages/web/node_modules/.vite/deps/_metadata.json",
    );
  });
});
