import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import {
  POOL_BURST_WINDOW_MS,
  POOL_MAX_SLOTS,
  clearDemand,
  demandFile,
  desiredPoolSize,
  desiredPoolSizeForRepo,
  readDemand,
  recordWorkspaceCreate,
} from "./demand.js";

let repoRoot: string;
let home: IsolatedCodecastDir;

beforeEach(() => {
  home = isolateCodecastDir();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-demand-"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  home.restore();
});

describe("desiredPoolSize — an isolated create earns no warm slot", () => {
  const now = 1_000_000;

  test("no creates at all means no pool", () => {
    expect(desiredPoolSize([], now)).toBe(0);
  });

  test("one create is isolated: the pool stays empty", () => {
    expect(desiredPoolSize([now], now)).toBe(0);
  });

  test("a second create inside the window arms one slot", () => {
    expect(desiredPoolSize([now - 1000, now], now)).toBe(1);
  });

  test("a burst walks the pool up, and stops at the cap", () => {
    const burst = [0, 1, 2, 3, 4, 5, 6].map((i) => now - i * 1000);
    expect(desiredPoolSize(burst, now)).toBe(POOL_MAX_SLOTS);
    expect(POOL_MAX_SLOTS).toBe(3);
  });

  test("an explicit cap below the default is honoured", () => {
    expect(desiredPoolSize([now, now, now, now], now, 1)).toBe(1);
  });

  test("creates older than the burst window do not count", () => {
    const stale = now - POOL_BURST_WINDOW_MS - 1;
    expect(desiredPoolSize([stale, stale, stale, now], now)).toBe(0);
  });
});

describe("recordWorkspaceCreate — the file the maintainer watches", () => {
  test("records a stamp and reports the pruned history", async () => {
    const kept = await recordWorkspaceCreate(repoRoot, 1_000);
    expect(kept).toEqual([1_000]);
    expect(readDemand(repoRoot)).toEqual([1_000]);
    expect(fs.existsSync(demandFile(repoRoot))).toBe(true);
  });

  test("drops stamps that fell out of the burst window", async () => {
    await recordWorkspaceCreate(repoRoot, 1_000);
    const kept = await recordWorkspaceCreate(repoRoot, 1_000 + POOL_BURST_WINDOW_MS + 1);
    expect(kept).toEqual([1_000 + POOL_BURST_WINDOW_MS + 1]);
  });

  test("two creates in a row size the pool at one slot", async () => {
    await recordWorkspaceCreate(repoRoot, 5_000);
    expect(desiredPoolSizeForRepo(repoRoot, 5_000)).toBe(0);
    await recordWorkspaceCreate(repoRoot, 6_000);
    expect(desiredPoolSizeForRepo(repoRoot, 6_000)).toBe(1);
  });

  test("a corrupt file reads as no demand rather than throwing", async () => {
    await recordWorkspaceCreate(repoRoot, 1_000);
    fs.writeFileSync(demandFile(repoRoot), "{not json");
    expect(readDemand(repoRoot)).toEqual([]);
    expect(desiredPoolSizeForRepo(repoRoot)).toBe(0);
  });

  test("clearDemand forgets the history", async () => {
    await recordWorkspaceCreate(repoRoot, 1_000);
    clearDemand(repoRoot);
    expect(readDemand(repoRoot)).toEqual([]);
    clearDemand(repoRoot); // idempotent on a missing file
  });
});
