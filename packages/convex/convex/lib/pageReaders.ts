// The readers a published page's queries may name (cast-data.json). Each
// entry validates its args into a normalized form plus the query_text a
// viewer can audit, checks at publish time what only the database can answer
// (a source or watch that exists in the workspace), and reads as the page's
// publisher inside one workspace key.
//
// Database readers page through an index (`page`, run inside an internal
// query per page so no single transaction reads past Convex's limits) and
// fold the compact tuples they emit into one table (`fold`, pure). Readers of
// an outside service (`fetch`) run in the refresh action and reuse the same
// code the CLI doors use, called as the publisher.
//
// Access is the workspace key and nothing else: tasks, signals, events and
// event groups by equality on `workspace`; sessions by the team-visibility
// rule, through session_starts; pull requests by team membership (their access rule).
// pageData.ts re-checks that the publisher still holds the key before every
// page.

import type { Doc, Id } from "../_generated/dataModel";
import { PAGE_DATA_LIMITS, type PageDataReader } from "@codecast/shared/contracts/pageData";
import { isOnHumanBoard } from "@codecast/shared/tasks";
import { parseWorkspaceKey } from "./accessKeys";
import { fetchUserUsageDays } from "./usageDaily";
import { resolveWorkspaceProject } from "./projectRef";
import { sourceByRef } from "./ingestScope";
import { cachedManifest } from "../sources/app";

type Db = { db: any };
type Args = Record<string, unknown>;
export type Table = { columns: string[]; rows: unknown[][] };
export type ReaderScope = { owner: Id<"users">; workspace: string };
/** One page of a database reader; `scanned` is how many documents it read, for `cast publish data --refresh`. */
export type ReaderPage = { items: unknown[][]; cursor: string | null; scanned?: number };

/** What the refresh action hands an outside reader: how to run as the publisher. */
export interface FetchDeps {
  hogql(scope: ReaderScope, source: string, query: string): Promise<{ columns: unknown[]; results: unknown[] }>;
  connector(scope: ReaderScope, source: string, reader: string, argsJson: string): Promise<{ ok: boolean; text?: string; error?: string }>;
}

export interface ReaderDef {
  validate(raw: Args): { args: Args; text: string } | { error: string };
  check?(ctx: Db, scope: ReaderScope, args: Args): Promise<string | null>;
  page?(ctx: Db, scope: ReaderScope, args: Args, cursor: string | null, now: number): Promise<ReaderPage>;
  fold?(items: unknown[][], args: Args, now: number): Table;
  fetch?(deps: FetchDeps, scope: ReaderScope, args: Args): Promise<Table>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── arg helpers ──

class ArgError extends Error {}

function days(raw: Args, fallback: number, max: number = PAGE_DATA_LIMITS.max_days): number {
  const value = raw.days ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new ArgError(`"days" must be a whole number from 1 to ${max}`);
  return value;
}

function oneOf<T extends string>(raw: Args, name: string, options: readonly T[], fallback: T): T {
  const value = raw[name] ?? fallback;
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new ArgError(`"${name}" must be one of ${options.join(", ")}`);
  return value as T;
}

function text(raw: Args, name: string, required: true): string;
function text(raw: Args, name: string, required?: false): string | undefined;
function text(raw: Args, name: string, required = false): string | undefined {
  const value = raw[name];
  if (value === undefined || value === "") {
    if (required) throw new ArgError(`"${name}" is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ArgError(`"${name}" must be a string`);
  return value.trim();
}

function unknownArgs(raw: Args, known: string[]): void {
  const extra = Object.keys(raw).filter((k) => !known.includes(k));
  if (extra.length) throw new ArgError(`unknown arg${extra.length > 1 ? "s" : ""} ${extra.map((k) => `"${k}"`).join(", ")} (takes ${known.join(", ") || "none"})`);
}

/** Runs a validate body, turning an ArgError into the registry's error shape. */
function validating(known: string[], body: (raw: Args) => { args: Args; text: string }) {
  return (raw: Args): { args: Args; text: string } | { error: string } => {
    try {
      unknownArgs(raw, known);
      return body(raw);
    } catch (e) {
      if (e instanceof ArgError) return { error: e.message };
      throw e;
    }
  };
}

// ── time buckets ──

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hourKey = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString().slice(0, 13) + ":00Z";

/** UTC midnight `n - 1` days before today: a window of n calendar days ending today. */
export function windowStart(now: number, n: number): number {
  return Math.floor(now / DAY) * DAY - (n - 1) * DAY;
}

/** Every day key of the window, oldest first, so a quiet day reads as 0 rather than a gap. */
function dayKeys(now: number, n: number): string[] {
  const start = windowStart(now, n);
  return Array.from({ length: n }, (_, i) => dayKey(start + i * DAY));
}

/**
 * Counts per (day, group) over the whole window: [day, count] rows, or
 * [day, <group column>, count] when grouped, the column named for what it
 * groups by (agent, person, kind, source) so a chart's series="agent" finds it.
 */
function seriesByDay(items: unknown[][], now: number, n: number, groupColumn: string | null, label: string): Table {
  const grouped = !!groupColumn;
  const counts = new Map<string, number>();
  const groups = new Set<string>();
  for (const [day, group, count] of items as [string, string, number?][]) {
    const g = grouped ? group || "(none)" : "";
    groups.add(g);
    const key = `${day}\u0000${g}`;
    counts.set(key, (counts.get(key) ?? 0) + (count ?? 1));
  }
  const keys = dayKeys(now, n);
  if (!grouped) return { columns: ["day", label], rows: keys.map((d) => [d, counts.get(`${d}\u0000`) ?? 0]) };
  const ordered = [...groups].sort();
  const rows: unknown[][] = [];
  for (const d of keys) for (const g of ordered) rows.push([d, g, counts.get(`${d}\u0000${g}`) ?? 0]);
  return { columns: ["day", groupColumn!, label], rows };
}

/** The grouped column's name: what the rows are grouped by, or none. */
const groupColumn = (args: Args): string | null => (args.group_by && args.group_by !== "none" ? (args.group_by as string) : null);

/** Counts per group: [group, count] rows, largest first. */
function countBy(items: unknown[][], index: number, label: string, column: string): Table {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = String(item[index] ?? "(none)");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { columns: [column, label], rows: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

// ── workspace helpers ──

function teamOf(scope: ReaderScope): Id<"teams"> | null {
  const ws = parseWorkspaceKey(scope.workspace);
  return ws?.type === "team" ? ws.teamId : null;
}

const workspaceWords = (scope: ReaderScope) => (teamOf(scope) ? "the team workspace" : "the publisher's personal workspace");

/** The people whose activity a workspace counts: a team's members who share activity, or the publisher alone. */
async function people(ctx: Db, scope: ReaderScope): Promise<Array<{ user_id: Id<"users">; name: string }>> {
  const team = teamOf(scope);
  const ids: Id<"users">[] = team
    ? (await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team)).collect())
        .filter((m: Doc<"team_memberships">) => m.visibility !== "hidden")
        .map((m: Doc<"team_memberships">) => m.user_id)
    : [scope.owner];
  const out = [];
  for (const id of ids) {
    const user = await ctx.db.get(id);
    out.push({ user_id: id, name: personName(user, id) });
  }
  return out.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
}

function personName(user: any, id: unknown): string {
  return user?.name || user?.github_username || user?.email?.split("@")[0] || String(id).slice(-6);
}

// ── readers ──

const TASK_VIEWS = ["status", "project", "assignee", "done_per_day", "created_per_day"] as const;

const tasks: ReaderDef = {
  validate: validating(["view", "days", "project", "board"], (raw) => {
    const view = oneOf(raw, "view", TASK_VIEWS, "status");
    const n = days(raw, 30);
    const project = text(raw, "project");
    const board = oneOf(raw, "board", ["human", "all"] as const, "human");
    const what = board === "human" ? "tasks on the human board" : "all tasks (agent work included)";
    const where = project ? ` in project "${project}"` : "";
    const how =
      view === "done_per_day" ? `closed as done per day over the last ${n} days`
      : view === "created_per_day" ? `created per day over the last ${n} days`
      : `updated in the last ${n} days, counted by ${view}`;
    return { args: { view, days: n, board, ...(project ? { project } : {}) }, text: `${what}${where}, ${how}` };
  }),
  async check(ctx, scope, args) {
    if (args.project && !(await resolveWorkspaceProject(ctx, scope.workspace, args.project as string))) return `no project "${args.project}" in this workspace`;
    return null;
  },
  async page(ctx, scope, args, cursor, now) {
    const start = windowStart(now, args.days as number);
    const project = args.project ? await resolveWorkspaceProject(ctx, scope.workspace, args.project as string) : null;
    const res = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace", scope.workspace).gte("updated_at", start))
      .paginate({ cursor, numItems: 200 });
    const names = new Map<string, string>();
    const nameOf = async (table: "projects" | "users", id: unknown) => {
      const key = String(id);
      if (!names.has(key)) {
        const row = await ctx.db.get(id);
        names.set(key, table === "projects" ? row?.title ?? row?.name ?? "(deleted project)" : personName(row, id));
      }
      return names.get(key)!;
    };
    const items: unknown[][] = [];
    for (const t of res.page as Doc<"tasks">[]) {
      if (args.board === "human" && !isOnHumanBoard(t as any)) continue;
      if (project && String(t.project_id) !== String(project._id)) continue;
      if (args.view === "done_per_day") {
        const closed = t.closed_at ?? t.updated_at;
        if (t.status === "done" && closed >= start) items.push([dayKey(closed)]);
      } else if (args.view === "created_per_day") {
        if (t.created_at >= start) items.push([dayKey(t.created_at)]);
      } else if (args.view === "status") items.push([t.status]);
      else if (args.view === "project") items.push([t.project_id ? await nameOf("projects", t.project_id) : "(no project)"]);
      else {
        const assignee = t.assignee;
        const id = assignee ? ctx.db.normalizeId("users", assignee) : null;
        items.push([id ? await nameOf("users", id) : assignee || "(unassigned)"]);
      }
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold(items, args, now) {
    if (args.view === "done_per_day") return seriesByDay(items, now, args.days as number, null, "done");
    if (args.view === "created_per_day") return seriesByDay(items, now, args.days as number, null, "created");
    return countBy(items, 0, "tasks", args.view as string);
  },
};

const sessions: ReaderDef = {
  validate: validating(["days", "group_by", "subagents"], (raw) => {
    const n = days(raw, 14, 90);
    const groupBy = oneOf(raw, "group_by", ["none", "person", "agent"] as const, "none");
    const subagents = raw.subagents === undefined ? false : raw.subagents;
    if (typeof subagents !== "boolean") throw new ArgError(`"subagents" must be true or false`);
    return {
      args: { days: n, group_by: groupBy, subagents },
      text: `sessions started per day over the last ${n} days${groupBy === "none" ? "" : `, by ${groupBy}`}${subagents ? ", subagents included" : ""}`,
    };
  }),
  // Reads session_starts (lib/sessionStarts.ts), one small row per session,
  // never conversation rows: a team's sessions are the rows its visibility
  // rule gave it, a personal page's are the publisher's own. The window ends
  // now: a start stamped in the future (a client clock or unit slip) is not a
  // session of this window, and past year 275760 it is not a date at all.
  async page(ctx, scope, args, cursor, now) {
    const start = windowStart(now, args.days as number);
    const team = teamOf(scope);
    const members = new Map((await people(ctx, scope)).map((p) => [String(p.user_id), p.name]));
    const res = await (team
      ? ctx.db.query("session_starts").withIndex("by_visible_team_started", (q: any) => q.eq("visible_team_id", team).gte("started_at", start).lte("started_at", now))
      : ctx.db.query("session_starts").withIndex("by_user_started", (q: any) => q.eq("user_id", scope.owner).gte("started_at", start).lte("started_at", now))
    ).paginate({ cursor, numItems: 2000 });
    const items: unknown[][] = [];
    for (const s of res.page as Doc<"session_starts">[]) {
      const person = members.get(String(s.user_id));
      // A member who keeps their activity hidden is not counted on a team page.
      if (person === undefined) continue;
      if (!args.subagents && s.subagent) continue;
      items.push([dayKey(s.started_at), args.group_by === "person" ? person : args.group_by === "agent" ? s.agent_type : ""]);
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold: (items, args, now) => seriesByDay(items, now, args.days as number, groupColumn(args), "sessions"),
};

const usage: ReaderDef = {
  validate: validating(["days", "group_by"], (raw) => {
    const n = days(raw, 30, 90);
    const groupBy = oneOf(raw, "group_by", ["none", "person"] as const, "none");
    return { args: { days: n, group_by: groupBy }, text: `tokens and spend (USD at API list price) per day over the last ${n} days${groupBy === "person" ? ", by person" : ""}` };
  }),
  async page(ctx, scope, args, _cursor, now) {
    const team = teamOf(scope);
    const start = windowStart(now, args.days as number);
    const items: unknown[][] = [];
    for (const person of await people(ctx, scope)) {
      const rows = await fetchUserUsageDays(ctx, person.user_id, team ?? undefined, args.days as number);
      for (const r of rows) {
        if (r.day_start < start) continue;
        const sum = (h: number[]) => h.reduce((a, b) => a + b, 0);
        items.push([dayKey(r.day_start), args.group_by === "person" ? person.name : "", sum(r.token_hours), sum(r.spend_hours)]);
      }
    }
    return { items, cursor: null };
  },
  fold(items, args, now) {
    const grouped = args.group_by === "person";
    const acc = new Map<string, [number, number]>();
    const groups = new Set<string>();
    for (const [day, group, tokens, spend] of items as [string, string, number, number][]) {
      groups.add(group);
      const key = `${day}\u0000${group}`;
      const cur = acc.get(key) ?? [0, 0];
      acc.set(key, [cur[0] + tokens, cur[1] + spend]);
    }
    const rows: unknown[][] = [];
    const ordered = grouped ? [...groups].sort() : [""];
    for (const d of dayKeys(now, args.days as number)) {
      for (const g of ordered) {
        const [tokens, spend] = acc.get(`${d}\u0000${g}`) ?? [0, 0];
        rows.push(grouped ? [d, g, tokens, Math.round(spend * 100) / 100] : [d, tokens, Math.round(spend * 100) / 100]);
      }
    }
    return { columns: grouped ? ["day", "person", "tokens", "spend"] : ["day", "tokens", "spend"], rows };
  },
};

const prs: ReaderDef = {
  validate: validating(["days", "repository"], (raw) => {
    const n = days(raw, 30, 180);
    const repository = text(raw, "repository");
    return { args: { days: n, ...(repository ? { repository } : {}) }, text: `pull requests opened and merged per day over the last ${n} days${repository ? ` in ${repository}` : ""}` };
  }),
  async check(_ctx, scope) {
    return teamOf(scope) ? null : "pull requests belong to a team: declare a team workspace";
  },
  async page(ctx, scope, args, cursor, now) {
    const team = teamOf(scope);
    if (!team) throw new Error("pull requests belong to a team workspace");
    const start = windowStart(now, args.days as number);
    const res = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_updated", (q: any) => q.eq("team_id", team).gte("updated_at", start))
      .paginate({ cursor, numItems: 40 });
    const items: unknown[][] = [];
    for (const pr of res.page as Doc<"pull_requests">[]) {
      if (args.repository && pr.repository !== args.repository) continue;
      if (pr.created_at >= start) items.push([dayKey(pr.created_at), "opened"]);
      if (pr.merged_at && pr.merged_at >= start) items.push([dayKey(pr.merged_at), "merged"]);
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold(items, args, now) {
    const counts = new Map<string, number>();
    for (const [day, what] of items as [string, string][]) counts.set(`${day}:${what}`, (counts.get(`${day}:${what}`) ?? 0) + 1);
    return {
      columns: ["day", "opened", "merged"],
      rows: dayKeys(now, args.days as number).map((d) => [d, counts.get(`${d}:opened`) ?? 0, counts.get(`${d}:merged`) ?? 0]),
    };
  },
};

const signals: ReaderDef = {
  validate: validating(["days", "group_by", "source"], (raw) => {
    const n = days(raw, 30);
    const groupBy = oneOf(raw, "group_by", ["none", "kind", "source"] as const, "kind");
    const source = text(raw, "source")?.toLowerCase();
    return {
      args: { days: n, group_by: groupBy, ...(source ? { source } : {}) },
      text: `findings filed per day over the last ${n} days${source ? ` from ${source}` : ""}${groupBy === "none" ? "" : `, by ${groupBy}`}`,
    };
  }),
  async page(ctx, scope, args, cursor, now) {
    const start = windowStart(now, args.days as number);
    const res = await ctx.db
      .query("signals")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspace", scope.workspace).gte("created_at", start))
      .paginate({ cursor, numItems: 400 });
    const items: unknown[][] = [];
    for (const s of res.page as Doc<"signals">[]) {
      if (args.source && s.source !== args.source) continue;
      items.push([dayKey(s.created_at), args.group_by === "kind" ? s.kind : args.group_by === "source" ? s.source : ""]);
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold: (items, args, now) => seriesByDay(items, now, args.days as number, groupColumn(args), "signals"),
};

const events: ReaderDef = {
  validate: validating(["days", "group_by", "kind", "source"], (raw) => {
    const n = days(raw, 14, 90);
    const groupBy = oneOf(raw, "group_by", ["none", "kind", "source"] as const, "kind");
    const kind = text(raw, "kind");
    const source = text(raw, "source");
    return {
      args: { days: n, group_by: groupBy, ...(kind ? { kind } : {}), ...(source ? { source } : {}) },
      text: `external events per day over the last ${n} days${kind ? ` of kind ${kind}` : ""}${source ? ` from ${source}` : ""}${groupBy === "none" ? "" : `, by ${groupBy}`}`,
    };
  }),
  async page(ctx, scope, args, cursor, now) {
    const start = windowStart(now, args.days as number);
    const res = await ctx.db
      .query("external_events")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspace", scope.workspace).gte("created_at", start))
      .paginate({ cursor, numItems: 300 });
    const items: unknown[][] = [];
    for (const e of res.page as Doc<"external_events">[]) {
      if (args.kind && e.kind !== args.kind) continue;
      if (args.source && e.source !== args.source) continue;
      items.push([dayKey(e.created_at), args.group_by === "kind" ? e.kind : args.group_by === "source" ? e.source : ""]);
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold: (items, args, now) => seriesByDay(items, now, args.days as number, groupColumn(args), "events"),
};

const event_groups: ReaderDef = {
  validate: validating(["days", "view", "bucket", "source", "kind", "status"], (raw) => {
    // Groups keep hourly buckets for a bounded span, so the window is short.
    const n = days(raw, 7, 30);
    const view = oneOf(raw, "view", ["series", "top"] as const, "series");
    const bucket = oneOf(raw, "bucket", ["day", "hour"] as const, "day");
    const source = text(raw, "source");
    const kind = text(raw, "kind");
    const status = text(raw, "status");
    const filters = [kind && `kind ${kind}`, status && `status ${status}`, source && `source ${source}`].filter(Boolean).join(", ");
    return {
      args: { days: n, view, bucket, ...(source ? { source } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
      text: view === "top"
        ? `event groups seen in the last ${n} days, by occurrences in that window${filters ? ` (${filters})` : ""}`
        : `event occurrences per ${bucket} over the last ${n} days${filters ? ` (${filters})` : ""}`,
    };
  }),
  async check(ctx, scope, args) {
    if (!args.source) return null;
    try {
      await sourceByRef(ctx, scope.owner, scope.workspace, args.source as string);
      return null;
    } catch {
      return `no source "${args.source}" in this workspace`;
    }
  },
  async page(ctx, scope, args, cursor, now) {
    const start = windowStart(now, args.days as number);
    const source = args.source ? await sourceByRef(ctx, scope.owner, scope.workspace, args.source as string) : null;
    const res = await (source
      ? ctx.db.query("event_groups").withIndex("by_source_last_seen", (q: any) => q.eq("source_id", source._id).gte("last_seen", start))
      : ctx.db.query("event_groups").withIndex("by_workspace_last_seen", (q: any) => q.eq("workspace", scope.workspace).gte("last_seen", start))
    ).paginate({ cursor, numItems: 200 });
    const items: unknown[][] = [];
    for (const g of res.page as Doc<"event_groups">[]) {
      if (g.workspace !== scope.workspace) continue;
      if (args.kind && g.kind !== args.kind) continue;
      if (args.status && g.status !== args.status) continue;
      const inWindow = g.buckets.filter((b) => b.hour >= start);
      if (args.view === "top") {
        const count = inWindow.reduce((a, b) => a + b.count, 0);
        items.push([g.short_id, g.title.slice(0, 160), g.kind, g.status, count, new Date(g.last_seen).toISOString()]);
      } else {
        for (const b of inWindow) items.push([args.bucket === "hour" ? hourKey(b.hour) : dayKey(b.hour), "", b.count]);
      }
    }
    return { items, cursor: res.isDone ? null : res.continueCursor, scanned: res.page.length };
  },
  fold(items, args, now) {
    if (args.view === "top") {
      return { columns: ["group", "title", "kind", "status", "count", "last_seen"], rows: [...items].sort((a, b) => (b[4] as number) - (a[4] as number)).slice(0, 50) };
    }
    if (args.bucket === "day") return seriesByDay(items, now, args.days as number, null, "count");
    const counts = new Map<string, number>();
    for (const [hour, , count] of items as [string, string, number][]) counts.set(hour, (counts.get(hour) ?? 0) + count);
    const first = windowStart(now, args.days as number);
    const rows: unknown[][] = [];
    for (let t = first; t <= now; t += HOUR) rows.push([hourKey(t), counts.get(hourKey(t)) ?? 0]);
    return { columns: ["hour", "count"], rows };
  },
};

const metricWatchByRef = (ctx: Db, ref: string): Promise<Doc<"metric_watches"> | null> =>
  ctx.db.query("metric_watches").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();

const metric: ReaderDef = {
  validate: validating(["watch"], (raw) => {
    const watch = text(raw, "watch", true);
    if (!/^mw-\d+$/.test(watch)) throw new ArgError(`"watch" is a metric watch id like mw-12 (cast metrics ls)`);
    return { args: { watch }, text: `the recorded points of metric watch ${watch}` };
  }),
  async check(ctx, scope, args) {
    const w = await metricWatchByRef(ctx, args.watch as string);
    return w && w.workspace === scope.workspace ? null : `no metric watch ${args.watch} in this workspace`;
  },
  async page(ctx, scope, args) {
    const w = await metricWatchByRef(ctx, args.watch as string);
    if (!w || w.workspace !== scope.workspace) throw new Error(`metric watch ${args.watch} is gone from this workspace`);
    return { items: w.points.map((p: { at: number; value: number }) => [new Date(p.at).toISOString(), p.value, w.name]), cursor: null };
  },
  fold: (items) => ({ columns: ["at", "value"], rows: items.map(([at, value]) => [at, value]) }),
};

async function sourceProblem(ctx: Db, scope: ReaderScope, ref: string, provider: "posthog" | "app"): Promise<string | null> {
  let row: Doc<"event_sources">;
  try {
    row = await sourceByRef(ctx, scope.owner, scope.workspace, ref);
  } catch {
    return `no source "${ref}" in this workspace (cast sources ls)`;
  }
  if (row.provider !== provider) return `${row.short_id} is a ${row.provider} source, not ${provider === "app" ? "an app connector" : "PostHog"}`;
  return null;
}

const hogql: ReaderDef = {
  validate: validating(["source", "query"], (raw) => {
    const source = text(raw, "source", true);
    const query = text(raw, "query", true);
    if (query.length > 4_000) throw new ArgError(`"query" is over 4000 characters`);
    return { args: { source, query }, text: `HogQL on PostHog source ${source}: ${query}` };
  }),
  check: (ctx, scope, args) => sourceProblem(ctx, scope, args.source as string, "posthog"),
  async fetch(deps, scope, args) {
    const out = await deps.hogql(scope, args.source as string, args.query as string);
    return { columns: out.columns.map(String), rows: (out.results as unknown[]).map((r) => (Array.isArray(r) ? r : [r])) };
  },
};

const connector: ReaderDef = {
  validate: validating(["source", "reader", "args"], (raw) => {
    const source = text(raw, "source", true);
    const reader = text(raw, "reader", true);
    const args = raw.args ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) throw new ArgError(`"args" must be an object`);
    const shown = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
    return { args: { source, reader, args }, text: `connector ${source} reader ${reader}${shown}, called as the publisher` };
  }),
  async check(ctx, scope, args) {
    const problem = await sourceProblem(ctx, scope, args.source as string, "app");
    if (problem) return problem;
    const row = await sourceByRef(ctx, scope.owner, scope.workspace, args.source as string);
    const manifest = cachedManifest(row);
    if (manifest && !manifest.readers.some((r) => r.name === args.reader)) {
      return `${row.name} declares no reader ${args.reader} (it has: ${manifest.readers.map((r) => r.name).join(", ") || "none"})`;
    }
    return null;
  },
  async fetch(deps, scope, args) {
    const res = await deps.connector(scope, args.source as string, args.reader as string, JSON.stringify(args.args ?? {}));
    if (!res.ok) throw new Error(res.error ?? "the connector call failed");
    let body: unknown;
    try {
      body = JSON.parse(res.text ?? "null");
    } catch {
      throw new Error("the connector answered with something other than JSON");
    }
    return tableFromJson(body);
  },
};

/**
 * A product's JSON as a table: {columns, rows} as sent; an array of objects
 * as one row each over the union of their keys; an array of scalars as one
 * column; an object of scalars as key/value rows; else one value cell.
 */
export function tableFromJson(body: unknown): Table {
  const cell = (v: unknown) => (v === null || typeof v !== "object" ? v : JSON.stringify(v));
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) return { columns: o.columns.map(String), rows: o.rows.map((r) => (Array.isArray(r) ? r.map(cell) : [cell(r)])) };
    for (const key of ["rows", "data", "items", "results"]) if (Array.isArray(o[key])) return tableFromJson(o[key]);
    return { columns: ["key", "value"], rows: Object.entries(o).map(([k, v]) => [k, cell(v)]) };
  }
  if (Array.isArray(body)) {
    if (body.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const columns: string[] = [];
      for (const r of body as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
      return { columns, rows: (body as Record<string, unknown>[]).map((r) => columns.map((c) => cell(r[c]))) };
    }
    return { columns: ["value"], rows: body.map((v) => [cell(v)]) };
  }
  return { columns: ["value"], rows: [[cell(body)]] };
}

export const PAGE_READERS: Record<PageDataReader, ReaderDef> = {
  tasks,
  sessions,
  usage,
  prs,
  signals,
  events,
  event_groups,
  metric,
  hogql,
  connector,
};

/** The full audit line for a query: what it reads and where. */
export function queryText(scope: ReaderScope, text: string): string {
  return `${text}; in ${workspaceWords(scope)}`;
}
