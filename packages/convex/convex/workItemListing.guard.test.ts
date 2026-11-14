import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Work items list only through the workspace key.
//
// A work item carries `workspace` (ACCESS: team:<id> | user:<id>) and
// `team_id` (ROUTING). A task linked to a private session is
// `team_id: T, workspace: user:<owner>`: routed to T, readable by its owner
// alone. So a read off a team routing index (by_team_id, by_team_updated, ...)
// returns rows some team members may not read, and every function that makes
// one must judge each row through the access layer before anything leaves it.
// On 2026-11-13 the mention lists, the @-mention search, the router's roster
// and Ship's project pick all skipped that step, and owner-private titles
// reached every teammate.
//
// This test fails when a function reads a workspace-keyed table off a team
// index without also calling one of the gates below. The tables are derived
// from schema.ts: every table with a top-level `workspace` field.

const DIR = import.meta.dir;

// The access layer and the data context are where the gates live.
const EXEMPT_FILES = new Set(["data.ts", "lib/access.ts", "lib/accessKeys.ts", "schema.ts"]);

// Calls that judge rows by the stored workspace key (lib/access.ts, data.ts).
const GATE = /\b(canAccess\w+|requireAccessible\w+|scopedFetch|createDataContext|createWorkContext|visibleInTeamList|heldKeysFor|accessJudgeFor|authorizedFor|workspaceGrantsAccess|workspaceForResource|resolveEffectiveTeam|resolveWorkspaceKeyBatch)\b/;

// `file::function` reads that are not a listing for a viewer, or are judged by
// their table's own rule. One line each on why.
const ALLOWED: Record<string, string> = {
  "deploys.ts::autoDeployCore": "cron with no viewer; it asks each project's owning role, returns nothing to a person",
  "changesQueries.ts::inTheWorks": "sourceless external_events are team GitHub PR events; access is team membership (changesReader), as for pull requests",
  "externalEvents.ts::listForContainer": "every row goes through filterReadable -> canReadEvent, the events table's own key check",
  "chat.ts::createChannel": "name-uniqueness lookup inside the caller's team; returns no other channel",
  "chat.ts::listChannels": "chat's access rule is channel membership: restricted rooms are filtered by chat_channel_members",
  "orgChannels.ts::resolveChannel": "by-name lookup; the channel then goes through loadChannel's access check",
  "slackSync.ts::adoptSlackName": "name-collision check while syncing a channel's Slack name; returns no row",
};

function workspaceKeyedTables(schema: string): Set<string> {
  const starts = [...schema.matchAll(/^  (\w+): defineTable\(/gm)];
  const out = new Set<string>();
  starts.forEach((m, i) => {
    const body = schema.slice(m.index!, starts[i + 1]?.index ?? schema.length);
    if (/^    workspace: /m.test(body)) out.add(m[1]);
  });
  return out;
}

const DECL = /^(?:export |async function |function |const )[^\n]*/gm;

function declName(line: string): string {
  return /(?:const|function)\s+(\w+)/.exec(line)?.[1] ?? line.slice(0, 40);
}

/** Every team-index read of a workspace-keyed table, with the top-level declaration it sits in. */
function teamIndexReads(src: string, tables: Set<string>): Array<{ table: string; index: string; fn: string; gated: boolean }> {
  const out: Array<{ table: string; index: string; fn: string; gated: boolean }> = [];
  for (const m of src.matchAll(/\.query\(\s*["'](\w+)["']\s*\)\s*\.withIndex\(\s*["'](by_team_\w*)["']/g)) {
    if (!tables.has(m[1])) continue;
    const decls = [...src.slice(0, m.index).matchAll(DECL)];
    const decl = decls[decls.length - 1];
    const start = decl?.index ?? 0;
    const rest = src.slice(m.index!).search(/\n(?:export |async function |function |const )/);
    const segment = src.slice(start, rest < 0 ? src.length : m.index! + rest);
    out.push({ table: m[1], index: m[2], fn: declName(decl?.[0] ?? ""), gated: GATE.test(segment) });
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "_generated" && name !== "node_modules") out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !/\.(test|testkit|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const TABLES = workspaceKeyedTables(readFileSync(join(DIR, "schema.ts"), "utf8"));
const READS = sourceFiles(DIR)
  .map((path) => relative(DIR, path))
  .filter((file) => !EXEMPT_FILES.has(file))
  .flatMap((file) => teamIndexReads(readFileSync(join(DIR, file), "utf8"), TABLES).map((r) => ({ ...r, key: `${file}::${r.fn}` })));

describe("work items list only through the workspace key", () => {
  test("the workspace-keyed tables come from the schema", () => {
    for (const t of ["tasks", "docs", "plans", "projects", "initiatives", "workflows", "signals"]) expect(TABLES.has(t)).toBe(true);
  });

  test("every team-index read of a workspace-keyed table is gated or allowed with a reason", () => {
    const ungated = READS.filter((r) => !r.gated && !ALLOWED[r.key]).map((r) => `${r.key} reads ${r.table}.${r.index}`);
    expect(ungated).toEqual([]);
  });

  test("every allowlist entry still names an ungated read", () => {
    const live = new Set(READS.filter((r) => !r.gated).map((r) => r.key));
    expect(Object.keys(ALLOWED).filter((k) => !live.has(k))).toEqual([]);
  });

  test("the detector sees an ungated read and a gated one", () => {
    const tables = new Set(["tasks"]);
    const ungated = `export const leak = query({\n  handler: async (ctx) => ctx.db.query("tasks")\n    .withIndex("by_team_id", (q) => q.eq("team_id", t)).collect(),\n});\n`;
    const gated = `export const ok = query({\n  handler: async (ctx) => {\n    const rows = await ctx.db.query("tasks").withIndex("by_team_id", (q) => q).collect();\n    return rows.filter((r) => canAccessTask(ctx, u, r));\n  },\n});\n`;
    expect(teamIndexReads(ungated + gated, tables)).toEqual([
      { table: "tasks", index: "by_team_id", fn: "leak", gated: false },
      { table: "tasks", index: "by_team_id", fn: "ok", gated: true },
    ]);
    expect(teamIndexReads(ungated.replace(/"tasks"/, '"conversations"'), tables)).toEqual([]);
  });
});
