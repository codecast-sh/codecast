// Nothing spells out the CLI state directory for itself. Every reader and
// writer resolves it through codecastDir()/codecastPath(), because a source
// that joins a home directory with ".codecast" by hand ignores CODECAST_DIR:
// a test that redirected the variable then still wrote the human's real files.
// positionTracker was one of those — running the CLI suite rewrote
// ~/.codecast/positions.json and could drop a position the live daemon had
// just written (ct-49597, same class as the browser pairing loss in ct-49576).
//
// When this fails on your code, import codecastDir/codecastPath from
// codecastDir.js instead of building the path.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "./test-helpers/sourceRegion.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(THIS_FILE));

/** The resolver itself, and the test helper that names the real directory on purpose. */
const EXEMPT = new Set(["codecastDir.ts", path.join("test-helpers", "codecastDir.ts")]);

const HOME = String.raw`(?:process\.env\.HOME(?:\s*\|\|\s*"[^"]*")?|os\.homedir\(\)|homedir\(\)|homeDir\(\))`;

/** Every hand-rolled spelling of the state directory. */
const HANDROLLED = [
  new RegExp(String.raw`process\.env\.HOME\s*\+\s*"/?\.codecast`),
  new RegExp(String.raw`path\.join\(\s*` + HOME + String.raw`\s*,\s*"\.codecast"`),
];

/** Naming one of these writes positions.json or sync-ledger.json. */
const STATE_WRITERS = ["setPosition(", "clearPosition(", "markSynced(", "updateSyncRecord(", "processSessionFile("];

/** Any of these puts the writes somewhere other than the human's ~/.codecast. */
const REDIRECTS = [/process\.env\.CODECAST_DIR\s*=/, /CODECAST_DIR\s*:/, /isolateCodecastDir\s*\(/];

const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__"]);

function walk(dir: string, out: string[] = [], opts: { tests?: boolean } = {}): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out, opts);
    } else if (entry.name.endsWith(".ts") && entry.name.endsWith(".test.ts") === !!opts.tests) {
      out.push(full);
    }
  }
  return out;
}

describe("the CLI state directory has one resolver", () => {
  const scanned = walk(SRC);
  const offenders: string[] = [];
  for (const file of scanned) {
    const rel = path.relative(SRC, file);
    if (file === THIS_FILE || EXEMPT.has(rel)) continue;
    for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
      if (HANDROLLED.some((re) => re.test(line))) {
        offenders.push(`${rel}:${n} builds the state directory by hand — use codecastDir()/codecastPath()`);
      }
    }
  }

  test("no source builds ~/.codecast without the resolver", () => {
    expect(offenders).toEqual([]);
  });

  test("the guard is looking at real files", () => {
    expect(scanned.some((f) => f.endsWith(path.join("src", "positionTracker.ts")))).toBe(true);
  });

  test("the patterns still catch a hand-rolled path", () => {
    const samples = [
      'const CONFIG_DIR = process.env.HOME + "/.codecast";',
      'const d = path.join(os.homedir(), ".codecast", "positions.json");',
      'const d = path.join(process.env.HOME || "", ".codecast", "agent-status");',
    ];
    for (const s of samples) expect(HANDROLLED.some((re) => re.test(s))).toBe(true);
  });
});

// Routing every source through the resolver is only half the fix. A test that
// calls a state writer without redirecting CODECAST_DIR still writes the human's
// real positions.json — daemon.create-retry-params.test.ts wrote its scratch
// transcript path there on every run (ct-49597).
describe("no test writes the human's sync state", () => {
  const tests = walk(SRC, [], { tests: true });
  const offenders: string[] = [];
  for (const file of tests) {
    if (file === THIS_FILE) continue; // this guard names every writer it looks for
    const lines = codeLines(fs.readFileSync(file, "utf8"));
    const writes = lines.filter(({ line }) => STATE_WRITERS.some((w) => line.includes(w)));
    if (writes.length === 0) continue;
    if (lines.some(({ line }) => REDIRECTS.some((re) => re.test(line)))) continue;
    offenders.push(`${path.relative(SRC, file)}:${writes[0].n} writes sync state with no CODECAST_DIR redirect`);
  }

  test("every test that records a position or a sync record redirects CODECAST_DIR first", () => {
    expect(offenders).toEqual([]);
  });

  test("the guard is looking at real files", () => {
    expect(tests.some((f) => f.endsWith(path.join("src", "fileRotation.test.ts")))).toBe(true);
  });
});
