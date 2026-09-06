import { describe, expect, test } from "bun:test";
import { checkRatchet, countMatches } from "@codecast/shared/ratchet";
import { join } from "node:path";

// RAW useQuery RATCHET.
//
// CLAUDE.md, "Local-first is the law": every piece of server data a surface
// renders lives in the store, and the surface reads the store. A live Convex
// query is a FEEDER — it subscribes in a hook, hands each push to syncTable,
// and the component paints synchronously from the cache. A plain useQuery
// inside app/ or components/ is the opposite: the surface waits on a
// round-trip for data the store could already have, and a terminal server
// error re-throws during render and drops the whole subtree into its
// ErrorBoundary (a header pill did exactly that on 2026-08-11).
//
// The offenders below predate the rule. They are pinned, not blessed: the
// count may only fall, and a listed file may not add another call.

const ROOT = join(import.meta.dir, "..", "..");
const ALLOWLIST = join(import.meta.dir, "rawUseQuery.allowlist.txt");

// `useQuery(` on its own — useQueryNoThrow and usePaginatedQuery are the
// sanctioned spellings and must not count.
const RAW_USE_QUERY = /(?<![A-Za-z0-9_$])useQuery\s*\(/;

/** How many files subscribe with a plain useQuery today. May only fall. */
const PIN = 44;

const result = checkRatchet({
  name: "raw useQuery outside hooks",
  root: ROOT,
  dirs: ["app", "components"],
  ignoreDirs: ["__tests__"],
  exempt: (rel) => /\.test\.tsx?$/.test(rel),
  count: (src) => countMatches(src, RAW_USE_QUERY),
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: "Mount the feeder in hooks/ and read the store (useTrackedStore / useCollectionRows / useWorkspaceCollection); if the query only enriches a surface that can paint without it, use useQueryNoThrow.",
  pruneCommand: "cd packages/web && RATCHET_WRITE=prune bun test lib/__tests__/rawUseQuery.ratchet.test.ts",
  minScanned: 400,
});

describe("raw useQuery ratchet", () => {
  test("no new plain useQuery under app/ or components/", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
