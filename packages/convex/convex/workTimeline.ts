// A workspace's work as major events, oldest first (ct-70247): what an outside
// agent (Union's Aivery) reads to know what happened in the team's code world
// without reading every task, commit or message. Three kinds of event:
//
//   task_opened / task_closed: a task a person or agent filed, opened or closed
//     (done or dropped, or merged into another). The line's own problems
//     (source "signal") open hundreds a day, so they are counted in the
//     in-progress digest instead; a problem only becomes an event when it is
//     fixed.
//   change_landed: a task's change reached the default branch (tasks.landed).
//
// Decisions are not here: `cast decide ls --answered-since` is their read.
//
// Paging: two sources, each with its own cursor and each at most `limit` rows
// a page (plus the rest of its last millisecond), so a page's size is bounded
// whatever the window holds. Tasks are read by updated_at after `after`, a
// superset of their opened and closed events (an event never postdates its
// row's update); landings by landed.at after `landed_after` (stamping
// `landed` does not move updated_at). A full page reads through every row of
// its last millisecond and its cursor is that millisecond, so a tie at the
// boundary is never skipped or read forever. Events are kept from `floor` on,
// so a task updated after its opening yields it again; the reader dedupes by
// event id.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { scopeOf, scopeArgs } from "./lib/ingestScope";
import { problemEvents } from "./lineTimeline";

const PAGE_DEFAULT = 60;
const PAGE_MAX = 150;
/** Rows a page reads at its last millisecond beyond its limit. */
const TIE_MAX = 200;
/** In-progress tasks one digest reads, and the titles it names per project. */
const OPEN_SCAN = 300;
const TITLES_PER_PROJECT = 4;
/** Projects a digest names; the rest are summed into its last group. */
const DIGEST_PROJECTS = 12;
/** Rows read to count the problems the line opened since the last digest. */
const PROBLEM_SCAN = 1000;

export type WorkEvent = {
  id: string;
  at: number;
  kind: "task_opened" | "task_closed" | "change_landed";
  /** closed: fixed, dropped or merged; landed: the short sha. */
  detail?: string;
  into?: string;
  by?: string;
  task: { short_id?: string; title: string; status: string; project?: string; source?: string };
  repository?: string;
};

export type WorkDigest = {
  in_progress: { project: string; count: number; titles: string[] }[];
  problems_opened: number;
};

const visible = (t: Doc<"tasks">) => !t.ephemeral && (!t.triage_status || t.triage_status === "active");

export const since = query({
  args: {
    ...scopeArgs,
    after: v.number(),
    /** The landings cursor an earlier page returned (default: `floor`). */
    landed_after: v.optional(v.number()),
    floor: v.number(),
    limit: v.optional(v.number()),
    /** With a time: also the in-progress digest, counting the problems opened since then. */
    digest_since: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ events: WorkEvent[]; cursor: number; landed_cursor: number; digest?: WorkDigest }> => {
    const { workspaceKey: ws } = await scopeOf(ctx, args);
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(args.limit ?? PAGE_DEFAULT)));

    const names = new Map<string, string | undefined>();
    const nameOf = async (table: "projects" | "users", id: Id<"projects"> | Id<"users"> | undefined) => {
      if (!id) return undefined;
      const k = String(id);
      if (!names.has(k)) {
        const row: any = await ctx.db.get(id);
        names.set(k, table === "projects" ? row?.title : row?.name);
      }
      return names.get(k);
    };
    const taskOf = async (t: Doc<"tasks">) => ({
      ...(t.short_id ? { short_id: t.short_id } : {}),
      title: t.title,
      status: t.status,
      ...(t.project_id ? { project: await nameOf("projects", t.project_id) } : {}),
      ...(t.source ? { source: t.source } : {}),
    });
    const refOf = async (id: Id<"tasks">) => {
      const t: Doc<"tasks"> | null = await ctx.db.get(id);
      return t && t.workspace === ws ? t.short_id : undefined;
    };

    /** `limit` rows of one index after `after`, read through the last row's millisecond; the cursor is that millisecond. */
    const pageOf = async (index: "by_workspace_updated" | "by_workspace_landed", field: "updated_at" | "landed.at", at: (t: Doc<"tasks">) => number, after: number) => {
      const rows: Doc<"tasks">[] = await ctx.db
        .query("tasks")
        .withIndex(index, (q: any) => q.eq("workspace", ws).gt(field, after))
        .take(limit);
      if (rows.length >= limit) {
        const last = at(rows[rows.length - 1]);
        const have = new Set(rows.map((t) => String(t._id)));
        const tie: Doc<"tasks">[] = await ctx.db
          .query("tasks")
          .withIndex(index, (q: any) => q.eq("workspace", ws).eq(field, last))
          .take(TIE_MAX);
        rows.push(...tie.filter((t) => !have.has(String(t._id))));
      }
      return { rows, cursor: rows.length ? at(rows[rows.length - 1]) : after };
    };
    const { rows, cursor } = await pageOf("by_workspace_updated", "updated_at", (t) => t.updated_at, args.after);

    const events: WorkEvent[] = [];
    for (const t of rows) {
      if (!visible(t)) continue;
      const intoRefs = new Map<string, string | undefined>();
      const into = t.cause?.merged_into;
      if (into) intoRefs.set(String(into), await refOf(into));
      for (const e of problemEvents(t, ws, (id) => intoRefs.get(String(id)))) {
        if (e.at <= args.floor) continue;
        const opened = e.kind === "problem_opened";
        // The line's problems: only a fix is an event; their openings and drops are the digest's count.
        if (t.source === "signal" && !(e.kind === "problem_closed" && e.detail === "fixed")) continue;
        events.push({
          id: e._id,
          at: e.at,
          kind: opened ? "task_opened" : "task_closed",
          ...(opened ? {} : { detail: e.kind === "problem_merged" ? "merged" : e.detail }),
          ...(e.into_ref ? { into: e.into_ref } : {}),
          ...(opened ? { by: await nameOf("users", t.user_id) } : {}),
          task: await taskOf(t),
        });
      }
    }

    const landedPage = await pageOf("by_workspace_landed", "landed.at", (t) => t.landed?.at ?? 0, Math.max(args.floor, args.landed_after ?? args.floor));
    for (const t of landedPage.rows) {
      if (!t.landed || !visible(t)) continue;
      events.push({
        id: `task:${t._id}:landed:${t.landed.sha}`,
        at: t.landed.at,
        kind: "change_landed",
        detail: t.landed.sha.slice(0, 10),
        repository: t.landed.repository,
        task: await taskOf(t),
      });
    }
    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

    const landed_cursor = landedPage.cursor;
    if (args.digest_since === undefined) return { events, cursor, landed_cursor };
    const open: Doc<"tasks">[] = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_status", (q: any) => q.eq("workspace", ws).eq("status", "in_progress"))
      .take(OPEN_SCAN);
    const byProject = new Map<string, { project: string; count: number; titles: string[] }>();
    for (const t of open) {
      if (!visible(t)) continue;
      const project = (t.project_id ? await nameOf("projects", t.project_id) : undefined) ?? "No project";
      const g = byProject.get(project) ?? { project, count: 0, titles: [] };
      g.count += 1;
      if (g.titles.length < TITLES_PER_PROJECT && t.source !== "signal") g.titles.push(t.title);
      byProject.set(project, g);
    }
    const recent: Doc<"tasks">[] = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_updated", (q: any) => q.eq("workspace", ws).gt("updated_at", args.digest_since!))
      .take(PROBLEM_SCAN);
    const problemsOpened = recent.filter((t) => t.source === "signal" && t.created_at > args.digest_since!).length;
    const groups = [...byProject.values()].sort((a, b) => b.count - a.count);
    const rest = groups.slice(DIGEST_PROJECTS);
    const in_progress = rest.length
      ? [...groups.slice(0, DIGEST_PROJECTS), { project: `${rest.length} other projects`, count: rest.reduce((n, g) => n + g.count, 0), titles: [] }]
      : groups;
    return { events, cursor, landed_cursor, digest: { in_progress, problems_opened: problemsOpened } };
  },
});
