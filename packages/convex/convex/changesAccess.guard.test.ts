import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Changes stories and editions are team-only rows with no `workspace` key: they
// stay safe only because no private session input is ever written into them
// (changes-page.md 8.4). That holds while every changes* module reads
// `conversations` and `session_insights` through lib/changesAccess.ts, the one
// gate that applies sharing, the owner's membership level at the session's
// start, and the insight's team. Nothing in the type system stops the next
// direct read, so this reads the source.

const HELPER = "lib/changesAccess.ts";

// A table name used as a value (a query, a normalizeId) rather than as a type
// or validator: `Id<"conversations">`, `Doc<...>` and `v.id(...)` are fine.
const TABLE_AS_VALUE = /(?<!\b(?:Id|Doc)<\s*|\bv\.id\(\s*)["'`](conversations|session_insights)["'`]/g;
// A get by an id that names a conversation or an insight.
const GET_BY_ID = /\bdb\.get\(\s*[^)]*\b\w*(conversation|insight)\w*/gi;
// Another module's functions or helpers that read those tables.
const OTHER_READERS = /\b(?:api|internal)\.(conversations|sessionInsights)\.|from\s+["'](?:\.\.?\/)+(conversations|sessionInsights)["']/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function directReads(src: string): string[] {
  const code = stripComments(src);
  return [TABLE_AS_VALUE, GET_BY_ID, OTHER_READERS].flatMap((re) => [...code.matchAll(re)].map((m) => m[0]));
}

/** Every changes* module under convex/ and convex/lib/, tests excluded. */
function changesModules(): string[] {
  const out: string[] = [];
  for (const dir of ["", "lib"]) {
    const abs = join(import.meta.dir, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!/^changes.*\.ts$/.test(name) || /\.(test|testing)\.ts$/.test(name)) continue;
      out.push(dir ? `${dir}/${name}` : name);
    }
  }
  return out;
}

describe("changes modules read sessions only through changesAccess", () => {
  test("the detector sees direct reads and lets types and validators pass", () => {
    expect(directReads(`ctx.db.query("session_insights").withIndex("x")`)).toHaveLength(1);
    expect(directReads(`ctx.db.query('conversations').collect()`)).toHaveLength(1);
    expect(directReads(`const c = await ctx.db.get(story.conversation_ids[0]);`)).toHaveLength(1);
    expect(directReads(`await ctx.db.get(input.insight_id)`)).toHaveLength(1);
    expect(directReads(`await ctx.runQuery(internal.sessionInsights.getExistingInsight, {})`)).toHaveLength(1);
    expect(directReads(`import { getSessionInsight } from "./sessionInsights";`)).toHaveLength(1);
    expect(directReads(`import { x } from "../conversations";`)).toHaveLength(1);
    expect(directReads([
      `args: { conversation_id: v.id("conversations") },`,
      `const ids: Id<"conversations">[] = [];`,
      `type I = Doc<"session_insights">;`,
      `await ctx.db.get(story._id);`,
      `// ctx.db.query("conversations") in a comment`,
      `.withIndex("by_conversation", (q) => q.eq("conversation_id", id))`,
    ].join("\n"))).toEqual([]);
  });

  test("the helper itself is where the reads live", () => {
    expect(directReads(readFileSync(join(import.meta.dir, HELPER), "utf8")).length).toBeGreaterThan(0);
  });

  test("no other changes module reads conversations or session_insights", () => {
    const offenders: string[] = [];
    for (const file of changesModules()) {
      if (file === HELPER) continue;
      for (const hit of directReads(readFileSync(join(import.meta.dir, file), "utf8"))) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
