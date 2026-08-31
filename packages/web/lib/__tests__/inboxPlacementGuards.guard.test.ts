import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// THE PLACEMENT CHOKEPOINT GUARD (docs/architecture/sync-convergence.md C5).
//
// `placeInboxRows` (store/inboxStore.ts) is the ONE function that places the
// replica's rows for every counting surface — panel, sidebar/dock badges,
// active-agents pill, fleet board, thread cards, palette, mobile inbox. The
// classifiers it replaced are DELETED; any reappearance of their names in code
// is a parallel counting path being reborn — the divergence class (panel 24 /
// badge 25 / mobile 50) the chokepoint exists to end:
//
//   categorizeSessions / categorizeMineSessions  the pre-chokepoint section
//                                                builders (panel vs badge split)
//   partitionOldSessions                         the per-device liveInboxIds
//                                                counting gate
//   liftQuestions                                the client-only question pass
//                                                (now the `questions` bucket)
//
// If this fails on new code, call placeInboxRows (or read its returned
// sections/placements/tally) — do not re-create a classifier.

const WEB_ROOT = join(import.meta.dir, "..", "..");
const MOBILE_ROOT = join(WEB_ROOT, "..", "mobile");

const BANNED = /\b(categorizeSessions|categorizeMineSessions|partitionOldSessions|liftQuestions)\b/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "__tests__" || name === ".next" || name === ".expo") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function offendersIn(root: string, dirs: string[]): string[] {
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const file of walk(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (BANNED.test(line)) offenders.push(`${rel}:${i + 1}: ${t}`);
      });
    }
  }
  return offenders;
}

describe("the deleted classifiers stay deleted (placeInboxRows is the chokepoint)", () => {
  test("web: no source file references a deleted classifier", () => {
    expect(offendersIn(WEB_ROOT, ["app", "components", "hooks", "lib", "store", "src", "shortcuts", "tips"])).toEqual([]);
  }, 120_000);

  test("mobile: no source file references a deleted classifier", () => {
    expect(offendersIn(MOBILE_ROOT, ["app", "components", "lib", "hooks"])).toEqual([]);
  }, 120_000);

  test("the chokepoint itself exists and exports the placed sections", () => {
    const store = readFileSync(join(WEB_ROOT, "store", "inboxStore.ts"), "utf8");
    expect(store).toContain("export function placeInboxRows(");
    for (const section of ["questions", "pinned", "newSessions", "needsInput", "done", "dormant", "working", "stashed", "dismissed"]) {
      expect(store.includes(`${section}:`)).toBe(true);
    }
  });
});
