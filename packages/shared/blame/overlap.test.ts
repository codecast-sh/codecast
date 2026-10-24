import { describe, expect, test } from "bun:test";
import {
  claimByOverlap,
  normalizeOverlapLine,
  overlapLineSet,
  overlapLinesBySha,
  passesOverlapGate,
  CONTENT_MATCH_MAX_AGE_MS,
  MAX_OVERLAP_LINES_PER_COMMIT,
} from "./index";

// What a session's edits wrote: a realistic Convex query plus the boilerplate
// every file in the tree shares.
const AGENT_EDIT = `import { v } from "convex/values";
import { query } from "./functions";

export const listOpenDecisions = query({
  args: { team_id: v.id("teams"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_team_status", (q) => q.eq("team_id", args.team_id).eq("status", "open"))
      .order("desc")
      .take(args.limit ?? 50);
    return {
      rows,
      more: rows.length === (args.limit ?? 50),
    };
  },
});
`;

const session = (id: string, ...texts: string[]) => ({ id, lines: overlapLineSet(texts) });

describe("line normalization", () => {
  test("trims, collapses whitespace runs and drops blank lines", () => {
    expect(normalizeOverlapLine("    const  x =\t1;  ")).toBe("const x = 1;");
    expect(normalizeOverlapLine("   \t ")).toBeNull();
    expect([...overlapLineSet(["a\n\n  a  \nb"])]).toEqual(["a", "b"]);
  });
});

describe("the overlap gate", () => {
  test("ten matched lines claim any commit; fewer need three lines and a quarter of it", () => {
    expect(passesOverlapGate(10, 500)).toBe(true);
    expect(passesOverlapGate(9, 40)).toBe(false);
    expect(passesOverlapGate(3, 12)).toBe(true);
    expect(passesOverlapGate(3, 13)).toBe(false);
    expect(passesOverlapGate(2, 2)).toBe(false);
  });
});

describe("claimByOverlap", () => {
  test("a person committing the agent's query verbatim, reindented, is claimed", () => {
    const committed = AGENT_EDIT.split("\n").map((l) => `  ${l.replace(/ {2}/g, "    ")}`);
    const claim = claimByOverlap(committed, [session("agent", AGENT_EDIT)]);
    expect(claim).toMatchObject({ id: "agent" });
    expect(claim!.matched).toBe(claim!.total);
    expect(claim!.matched).toBeGreaterThanOrEqual(10);
  });

  test("a small fix committed verbatim clears the proportional gate", () => {
    const fix = `if (!row) return null;\nconst owner = await ctx.db.get(row.user_id);\nif (!owner) return null;\nreturn owner.name ?? "Unknown";`;
    expect(claimByOverlap(fix.split("\n"), [session("agent", AGENT_EDIT, fix)])).toMatchObject({ id: "agent", matched: 4, total: 4 });
  });

  test("braces, returns and shared imports do not claim a person's own commit", () => {
    // The person's commit shares exactly the boilerplate lines with the
    // session: the v1 any-overlap gate tagged commits like this as agent work.
    const human = `import { v } from "convex/values";
import { query } from "./functions";

export const countStaleHosts = query({
  args: { older_than_ms: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.older_than_ms;
    const hosts = await ctx.db.query("cloud_hosts").collect();
    const stale = hosts.filter((h) => (h.last_seen_at ?? 0) < cutoff);
    for (const host of stale) console.log("stale host", host._id);
    const byRegion = new Map<string, number>();
    for (const host of stale) byRegion.set(host.region, (byRegion.get(host.region) ?? 0) + 1);
    return {
      count: stale.length,
      regions: Object.fromEntries(byRegion),
    };
  },
});

export const staleHostReport = query({
  args: { region: v.string() },
  handler: async (ctx, args) => {
    const hosts = await ctx.db
      .query("cloud_hosts")
      .withIndex("by_region", (q) => q.eq("region", args.region))
      .collect();
    const rows = hosts.map((h) => ({ id: h._id, name: h.name, seen: h.last_seen_at ?? 0 }));
    rows.sort((a, b) => a.seen - b.seen);
    const oldest = rows[0]?.seen ?? null;
    const newest = rows[rows.length - 1]?.seen ?? null;
    const spanMs = oldest !== null && newest !== null ? newest - oldest : 0;
    const healthy = rows.filter((r) => Date.now() - r.seen < 5 * 60_000).length;
    const label = healthy === rows.length ? "all healthy" : \`\${rows.length - healthy} stale\`;
    return { rows, oldest, newest, spanMs, healthy, label };
  },
});`;
    const matched = [...overlapLineSet([human])].filter((l) => overlapLineSet([AGENT_EDIT]).has(l));
    expect(matched).toEqual([
      'import { v } from "convex/values";',
      'import { query } from "./functions";',
      "handler: async (ctx, args) => {",
      "return {",
      "};",
      "},",
      "});",
    ]);
    expect(claimByOverlap(human.split("\n"), [session("agent", AGENT_EDIT)])).toBeNull();
  });

  test("the session that wrote more of the commit wins; an exact tie resolves by id", () => {
    const extra = `const total = rows.reduce((n, r) => n + r.weight, 0);\nconst mean = total / Math.max(rows.length, 1);\nconst label = mean > 1 ? "heavy" : "light";`;
    const commit = [...AGENT_EDIT.split("\n"), ...extra.split("\n")];
    expect(claimByOverlap(commit, [session("b", extra), session("a", AGENT_EDIT)])).toMatchObject({ id: "a" });
    expect(claimByOverlap(extra.split("\n"), [session("z", extra), session("y", extra)])).toMatchObject({ id: "y" });
  });

  test("no candidates, no claim", () => {
    expect(claimByOverlap(AGENT_EDIT.split("\n"), [])).toBeNull();
  });
});

describe("overlapLinesBySha", () => {
  test("groups recent commits' lines, normalized and deduped, and skips old commits", () => {
    const now = 10 * CONTENT_MATCH_MAX_AGE_MS;
    const out = overlapLinesBySha([
      { sha: "a", text: "  return  x;", authorMs: now - 1000 },
      { sha: "a", text: "return x;", authorMs: now - 1000 },
      { sha: "a", text: "", authorMs: now - 1000 },
      { sha: "b", text: "old();", authorMs: now - CONTENT_MATCH_MAX_AGE_MS - 1 },
      { sha: "c", text: "noTime();" },
    ], now);
    expect([...out]).toEqual([["a", ["return x;"]]]);
  });

  test("caps the lines one commit sends", () => {
    const lines = Array.from({ length: MAX_OVERLAP_LINES_PER_COMMIT + 50 }, (_, i) => ({ sha: "a", text: `line ${i}`, authorMs: 1 }));
    expect(overlapLinesBySha(lines, 2).get("a")).toHaveLength(MAX_OVERLAP_LINES_PER_COMMIT);
  });
});
