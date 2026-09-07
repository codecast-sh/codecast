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

// A new tab is the fourth way to take the screen, and the quietest.
//
// `Target.createTarget` opens the tab in FRONT unless it is told otherwise:
// over the bridge the host maps the param onto `tabs.create {active: false}`
// (bridge/protocol.ts), and in the managed Chrome the same flag is what keeps a
// pinned tab from raising the window. There is no raise call to grep for, so
// the omission reads as ordinary code — `cast browser open` in real mode
// created its tab with a bare `{ url }` and pulled the human's own Chrome
// forward on every open (found in review of ct-49625).
//
// Two mechanical rules: every create asks for the background, and the params
// objects trusted to carry the flag really carry it.

/** Params objects that are background by construction, and where they are built. */
const BACKGROUND_PARAMS = [
  { expr: "NEW_TAB", file: "browser/cli.ts", decl: "NEW_TAB" },
  { expr: "browser.create", file: "browser/pinnedTab.ts", decl: "create" },
];

/**
 * Does this create open a tab in front of the human? The params can wrap onto
 * the next lines, so the check reads a small window rather than one line.
 */
function createsInForeground(window: string): boolean {
  if (!window.includes('"Target.createTarget"')) return false;
  // The bridge host SERVES the method to its clients; a case label is not a call.
  if (/case\s+"Target\.createTarget"/.test(window)) return false;
  if (/background:\s*true/.test(window)) return false;
  return !BACKGROUND_PARAMS.some((p) => window.includes(`"Target.createTarget", ${p.expr}`));
}

describe("every tab an agent opens comes up behind the human", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
      if (!line.includes('"Target.createTarget"')) continue;
      if (createsInForeground(lines.slice(n - 1, n + 2).join("\n"))) {
        offenders.push(`${rel}:${n} creates a tab in the foreground; pass background: true`);
      }
    }
  }

  test("no create opens a tab in front", () => {
    expect(offenders).toEqual([]);
  });

  test("the params objects trusted as background really are", () => {
    for (const { file, decl } of BACKGROUND_PARAMS) {
      const text = fs.readFileSync(path.join(SRC, file), "utf8");
      const built = [...text.matchAll(new RegExp(`${decl}\\s*[:=]\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
      expect(built.length).toBeGreaterThan(0);
      expect(built.filter((b) => !/background:\s*true/.test(b))).toEqual([]);
    }
  });

  // The scan above only proves the tree is clean today. This proves the rule
  // would catch the regression it was written for.
  test("a create without the flag is caught, one with it is not", () => {
    const bare = 'conn.send<{ targetId: string }>("Target.createTarget", { url })';
    expect(createsInForeground(bare)).toBe(true);
    expect(createsInForeground(bare.replace("{ url }", "{ url, background: true }"))).toBe(false);
    expect(createsInForeground('conn.send("Target.createTarget", NEW_TAB)')).toBe(false);
    expect(createsInForeground('case "Target.createTarget": {')).toBe(false);
  });
});
