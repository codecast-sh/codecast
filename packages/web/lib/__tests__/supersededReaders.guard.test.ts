import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// SUPERSEDED READERS (docs/architecture/line-versions.md LV2).
//
// Superseded line work is hidden by default everywhere because every list and
// count reads it through one chokepoint: the trial hooks on the client
// (hooks/useSyncTrial.ts filters with currentOnly), and on the server the
// decision reads (currentDecisions) and the trial queries (which attach
// `superseded`). A surface that reads the raw store key or drops the filter
// shows debris again, which is the mess this rule exists to prevent. The fix
// for a failure here is to read through the hook (`{ all: true }` for a
// history reader), never to allowlist the file.

const WEB = join(import.meta.dir, "..", "..");
const CONVEX = join(WEB, "..", "convex", "convex");

/** Files under the store machinery that own the keys themselves. */
const OWNERS = new Set(["hooks/useSyncTrial.ts", "store/clientSyncRegistry.ts", "store/inboxStore.ts", "store/trialSlice.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("superseded work is read through its chokepoints", () => {
  test("no web file reads the trial store keys except through the trial hooks", () => {
    const raw = /\b(?:s|st|state)\.(trialCards|trialRuns)\b|["'](trialCards|trialRuns)["']/;
    const offenders = ["app", "components", "lib", "hooks", "store"]
      .flatMap((d) => walk(join(WEB, d)))
      .map((p) => relative(WEB, p))
      .filter((p) => !OWNERS.has(p) && raw.test(readFileSync(join(WEB, p), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the trial hooks filter superseded rows", () => {
    const src = readFileSync(join(WEB, "hooks/useSyncTrial.ts"), "utf8");
    expect(src.match(/currentOnly\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("every server read that lists or counts decisions filters superseded ones", () => {
    const decisions = readFileSync(join(CONVEX, "sessionDecisions.ts"), "utf8");
    const stacks = readFileSync(join(CONVEX, "decisionStacks.ts"), "utf8");
    const body = (src: string, head: string) => src.slice(src.indexOf(head), src.indexOf("\n}\n", src.indexOf(head)));
    for (const [src, head] of [
      [decisions, "export async function listForUserCore("],
      [decisions, "export async function pendingOnLadder("],
      [stacks, "async function listRow("],
      [stacks, "async function getStackCore("],
    ] as const) {
      expect(src.includes(head)).toBe(true);
      expect(body(src, head)).toContain("currentDecisions(");
    }
  });

  test("the trial queries say which cards and runs are superseded", () => {
    const src = readFileSync(join(CONVEX, "lineTrial.ts"), "utf8");
    expect(src).toContain("superseded = supersededCard(");
    expect(src).toContain("superseded: await runSuperseded(");
  });
});
