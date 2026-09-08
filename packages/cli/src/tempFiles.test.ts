/**
 * The scratch-file policy: where an agent's screenshots land, who can read
 * them, and when they go.
 *
 * These are the three claims the security fix rests on (ct-49556) — a 0700
 * directory under the CLI state dir, 0600 files, and a sweep that removes a
 * day-old capture without scanning the directory on every shot. Every case
 * runs with CODECAST_DIR pointed at a throwaway directory, so the suite never
 * reads or writes the real ~/.codecast (bridge.json included).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  agentTempDir, agentTempPath, secureTempFile, sweepTempDir,
  TEMP_FILE_MODE, TEMP_SWEEP_MARKER, TEMP_TTL_MS,
} from "./tempFiles.js";

let home: string;
let priorDir: string | undefined;

beforeEach(() => {
  priorDir = process.env.CODECAST_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-temp-test-"));
  process.env.CODECAST_DIR = path.join(home, ".codecast");
});

afterEach(() => {
  if (priorDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("agentTempDir", () => {
  test("lives under the CLI state directory, at 0700", () => {
    const dir = agentTempDir("shots");
    expect(dir).toBe(path.join(process.env.CODECAST_DIR!, "tmp", "shots"));
    expect(mode(dir)).toBe(0o700);
  });

  test("tightens a directory somebody left open", () => {
    const dir = agentTempDir("shots");
    fs.chmodSync(dir, 0o755);
    expect(mode(agentTempDir("shots"))).toBe(0o700);
  });

  test("refuses a path that is a symlink rather than our directory", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cast-temp-decoy-"));
    fs.mkdirSync(path.join(process.env.CODECAST_DIR!, "tmp"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(process.env.CODECAST_DIR!, "tmp", "shots"));
    expect(() => agentTempDir("shots")).toThrow(/not a directory/);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("file mode", () => {
  test("a shot path is inside the 0700 directory", () => {
    const file = agentTempPath("shots", "cast-shot-1.png");
    expect(path.dirname(file)).toBe(agentTempDir("shots"));
  });

  test("a name with path separators cannot escape the directory", () => {
    const file = agentTempPath("shots", "../../escape.png");
    expect(path.dirname(file)).toBe(agentTempDir("shots"));
  });

  test("secureTempFile makes a file owner-only", () => {
    const file = agentTempPath("shots", "loose.png");
    fs.writeFileSync(file, "x", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    secureTempFile(file);
    expect(mode(file)).toBe(TEMP_FILE_MODE);
  });
});

describe("sweepTempDir", () => {
  const age = (file: string, ms: number): void => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(file, when, when);
  };

  test("removes files past the TTL and keeps the rest", () => {
    const dir = agentTempDir("shots");
    const old = path.join(dir, "old.png");
    const fresh = path.join(dir, "fresh.png");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(fresh, "x");
    age(old, TEMP_TTL_MS + 60_000);

    expect(sweepTempDir(dir)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test("writes a marker and skips the next scan behind it", () => {
    const dir = agentTempDir("shots");
    sweepTempDir(dir);
    const marker = path.join(dir, TEMP_SWEEP_MARKER);
    expect(fs.existsSync(marker)).toBe(true);

    // A shot taken right after: the old file stays, because the sweep is not
    // due again. This is the loop cost the marker exists to remove.
    const old = path.join(dir, "old.png");
    fs.writeFileSync(old, "x");
    age(old, TEMP_TTL_MS + 60_000);
    expect(sweepTempDir(dir)).toBe(0);
    expect(fs.existsSync(old)).toBe(true);

    // Once the interval has passed, the same file goes.
    expect(sweepTempDir(dir, { now: Date.now() + 2 * 60 * 60 * 1000 })).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  test("never deletes its own marker", () => {
    const dir = agentTempDir("shots");
    sweepTempDir(dir);
    const marker = path.join(dir, TEMP_SWEEP_MARKER);
    age(marker, TEMP_TTL_MS * 3);
    sweepTempDir(dir);
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("the marker is owner-only too", () => {
    const dir = agentTempDir("shots");
    sweepTempDir(dir);
    expect(mode(path.join(dir, TEMP_SWEEP_MARKER))).toBe(TEMP_FILE_MODE);
  });
});
