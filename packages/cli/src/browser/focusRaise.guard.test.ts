// An agent never takes the human's focus. On macOS a browser-level
// `Target.activateTarget`, a page-level `Page.bringToFront` and the HTTP
// `/json/activate` each pull the whole Chrome in front of whatever the human
// is working in, and the per-call focus guard (focusGuard.ts) only brackets
// calls that go through runEngine. A raw CDP driver inside cast that sends one
// of these is invisible to that guard, and the daemon's sentinel can only
// bounce it a second later, so the human sees the window flash on every call
// (2026-09-03: `cast app sweep` raised the agent Chrome about forty times in
// four minutes).
//
// This guard scans every CLI source for the three raise calls and fails on
// any file outside the allowlist. When it fails on your code, drop the raise:
// CDP drives a background tab fine, screenshots included. Do not widen the
// allowlist; an entry needs a reason the raise is the human's own ask, and a
// stale entry (a file that no longer raises) fails the guard too.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "../test-helpers/sourceRegion.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RAISES = ["Page.bringToFront", "Target.activateTarget", "/json/activate"];

/** Files allowed to raise, each with the reason it is the human's own ask. */
const ALLOWED: Record<string, string> = {
  "browser/focusHttp.ts": "the web's open-tab link: a deliberate raise, stamped with noteDeliberateRaise so the sentinel spares it",
  "browser/cli.ts": "`tab --show` and `bringtofront`: raises the human asked for by flag",
  "browser/bridge/host.ts": "serves Target.activateTarget to bridge clients; the method name in a switch, not a call",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__", "test-helpers"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("no code path raises a browser window over the human", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
      const hit = RAISES.find((raise) => line.includes(raise));
      if (!hit) continue;
      if (rel in ALLOWED) {
        seenAllowed.add(rel);
        continue;
      }
      offenders.push(`${rel}:${n} sends ${hit}`);
    }
  }

  test("every raise outside the allowlist is a focus steal", () => {
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still raises (no stale entries)", () => {
    expect(Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel))).toEqual([]);
  });
});
