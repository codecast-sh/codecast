import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { walkSources } from "./sourceWalk";
import { join } from "node:path";

// NO-THROW ENRICHMENT GUARD.
//
// These queries enrich a surface that can already paint from a store cache,
// so a terminal server error (the backend's 15 s db-wait cap under
// saturation, "too many system operations") must degrade to the cached
// answer, not unmount the surface. Plain `useQuery` re-throws that error
// during render and drops the subscriber into its ErrorBoundary; on
// 2026-09-06 that took out the whole new-session header through
// ProjectSwitcher. Subscribe through useQueryNoThrow instead.
//
// Add a query here when it gains a cached fallback; the fix for a failure
// is the hook, never widening this list's exemptions.
const CACHED_ENRICHMENT_QUERIES = [
  "users.getRecentProjectPaths",
];

// Queries that scan full assistant tool_calls. A live subscription re-runs on
// every stream tick and times out ("too many system operations") on long
// sessions; on 2026-09-07 that unmounted the Questions header. Derive from
// the store (computeConversationTaskStats) instead of subscribing.
const FORBIDDEN_LIVE_SCANS = [
  "conversations.getConversationToolStats",
];

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components", "hooks"];

describe("cached enrichment queries never subscribe through plain useQuery", () => {
  test("every subscription to a cached enrichment query goes through useQueryNoThrow", () => {
    const patterns = CACHED_ENRICHMENT_QUERIES.map((q) => ({
      query: q,
      re: new RegExp(String.raw`\buseQuery\(\s*\(?api\)?\.` + q.replace(".", String.raw`\.`) + String.raw`\b`),
    }));
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of walkSources(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        const src = readFileSync(file, "utf8");
        // Collapse whitespace so a multi-line `useQuery(\n  api.x.y,` still matches.
        const flat = src.replace(/\s+/g, " ");
        for (const { query, re } of patterns) {
          if (re.test(flat)) offenders.push(`${rel} subscribes to ${query} with plain useQuery`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});

describe("full-tool-call scans are never live-subscribed", () => {
  test("no client surface subscribes to a forbidden assistant-row scan", () => {
    const patterns = FORBIDDEN_LIVE_SCANS.map((q) => ({
      query: q,
      re: new RegExp(
        String.raw`\b(?:useQuery|useQueryNoThrow)\(\s*\(?api\)?\.` +
          q.replace(".", String.raw`\.`) +
          String.raw`\b`,
      ),
    }));
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of walkSources(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        const flat = readFileSync(file, "utf8").replace(/\s+/g, " ");
        for (const { query, re } of patterns) {
          if (re.test(flat)) offenders.push(`${rel} live-subscribes to ${query}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
