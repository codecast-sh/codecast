// A test never writes the human's browser state. Every browser state path is
// `browserHome()` — `process.env.CODECAST_DIR || ~/.codecast` plus "browser" —
// so a test that does not redirect CODECAST_DIR writes the real files. On
// 2026-09-06 `testBridgeHost` did exactly that: one run of the browser suite
// replaced ~/.codecast/browser/bridge.json with a 64-character test token, the
// human's Chrome extension still held the previous one, and the pairing was
// gone for good (ct-49576).
//
// This guard scans every test file and test helper under packages/cli/src. A
// file that names a writer of browser state must also redirect CODECAST_DIR —
// `process.env.CODECAST_DIR = <temp dir>`, a `CODECAST_DIR:` entry in a child
// process env, or `isolateCodecastDir()` from test-helpers/codecastDir.ts.
// When it fails on your code, redirect; never write the real state file.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "../test-helpers/sourceRegion.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(THIS_FILE), "..");

/** Naming one of these writes a file under `browserHome()`. */
const WRITERS = ["writeBridgeState", "ensureBridgeConfig", "rotateBridgeToken", "testBridgeHost", "browserHome("];

/** Any of these puts the writes somewhere other than the human's ~/.codecast. */
const REDIRECTS = [/process\.env\.CODECAST_DIR\s*=/, /CODECAST_DIR\s*:/, /isolateCodecastDir\s*\(/];

const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__"]);

const isTestSource = (name: string) => name.endsWith(".test.ts") || name.endsWith(".testutil.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    const isHelper = path.basename(dir) === "test-helpers" && (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs"));
    if (isTestSource(entry.name) || isHelper) out.push(full);
  }
  return out;
}

describe("no test writes the human's browser state", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file === THIS_FILE) continue; // this guard names every writer it looks for
    const lines = codeLines(fs.readFileSync(file, "utf8"));
    const writes = lines.filter(({ line }) => WRITERS.some((w) => line.includes(w)));
    if (writes.length === 0) continue;
    if (lines.some(({ line }) => REDIRECTS.some((r) => r.test(line)))) continue;
    const rel = path.relative(SRC, file);
    offenders.push(`${rel}:${writes[0].n} writes browser state with no CODECAST_DIR redirect`);
  }

  test("every test that writes browser state redirects CODECAST_DIR first", () => {
    expect(offenders).toEqual([]);
  });

  test("the guard is looking at real files", () => {
    expect(walk(SRC).some((f) => f.endsWith(path.join("bridge", "host.testutil.ts")))).toBe(true);
  });
});
