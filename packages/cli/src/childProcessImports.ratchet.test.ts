import { describe, expect, test } from "bun:test";
import { checkRatchet, countMatches } from "@codecast/shared/ratchet";
import { join } from "node:path";

// CHILD PROCESS IMPORT RATCHET.
//
// proc.ts is a drop-in replacement for node:child_process that injects
// windowsHide into every call and times every synchronous spawn through
// slowSync. Both decisions are invisible when you get them wrong: a console
// child spawned without windowsHide painted hundreds of windows on a Windows
// user's machine, and a sync spawn under load freezes timers, delivery and
// heartbeats for its whole lifetime with nothing in a stack sample left to
// name it afterwards. Made per call site, those decisions were right in some
// files and wrong in others.
//
// A direct node:child_process import opts out of both. The files below did so
// before the wrapper existed; the count may only fall, and a listed file may
// not add another import. Only the import line changes when you migrate one —
// the exported names and signatures are identical.

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST = join(import.meta.dir, "childProcessImports.allowlist.txt");

// Static import, re-export, bare require and dynamic import alike.
const CHILD_PROCESS_IMPORT = /(?:from\s*["'](?:node:)?child_process["']|(?:require|import)\s*\(\s*["'](?:node:)?child_process["'])/;

/** How many files import node:child_process directly. May only fall.
 *  23 when the ratchet landed (ct-49563); 21 after ct-49901 routed the
 *  nineteen call sites the four merge bases had added through the wrapper —
 *  the cloud mirror, `cast review`, `cast fs browse`, the Grok ACP client,
 *  the worker host, the `cast bench` harness and the fixtures the e2e tests
 *  spawn. Nothing was exempted to get there. */
const PIN = 21;

const result = checkRatchet({
  name: "direct child_process import",
  root: ROOT,
  dirs: ["src"],
  exempt: (rel) =>
    // The wrapper owns the import. Tests may spawn freely: they are not
    // shipped, and several exist to drive a raw child against the wrapper.
    rel === "src/proc.ts" || /\.test\.ts$/.test(rel) || rel.includes("/__tests__/"),
  count: (src) => countMatches(src, CHILD_PROCESS_IMPORT),
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: "Import the same names from src/proc.ts instead — identical signatures, plus windowsHide and the slow-sync spawn report.",
  pruneCommand: "cd packages/cli && RATCHET_WRITE=prune bun test src/childProcessImports.ratchet.test.ts",
  minScanned: 200,
});

describe("child_process import ratchet", () => {
  test("no new direct node:child_process import outside proc.ts", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
