// The wake rail's read side (docs/architecture/org-roles-standing.md T3):
// flush, frame, deliver.
//
// A flush runs per role, scheduled by orgEvents when a row is inserted. It
// reads the role's unflushed outbox rows, applies the gates in order (paused,
// caps, a busy agent), builds ONE frame from the rows plus the live facts of
// the role's scope, and delivers it as one pending message into the standing
// session — or logs the wake as dropped when nothing new happened. The frame
// text is what the pending row stores, as today's rail requires (the echo
// adoption in messages.addMessage matches the stored text).
//
// The flush is a mutation, not an action: every gate reads the same
// transaction the delivery writes in, so a cap counted here is the cap the
// delivery bumps, and the fake db tests drive the same code.

import { internalMutation, internalQuery } from "./functions";
import { charterLine } from "./lib/orgCharter";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { nextShortId } from "./counters";
import { enqueuePendingMessage } from "./pendingMessages";
import { computeBriefFacts, type BriefFacts } from "./org";
import { PERSON_SESSION_LINES } from "./orgGoals";
import { goalStateLine } from "@codecast/shared/contracts/roleGoals";
import { parseStandingSection, standingLineAgeDays, standingLineFor, standingLineStale } from "@codecast/shared/contracts/briefStanding";
import { collectLinesSince } from "./chat";
import {
  OUTBOX_READ_CAP,
  RESTART_CAUSE,
  capsFor,
  countersFor,
  msToNextUtcDay,
  scheduleFlush,
  unflushedRowsFor,
} from "./orgEvents";

// A busy agent is asked again this often, this many times, then the frame
// goes in regardless (the daemon queues it behind the running turn).
export const ACTIVE_RETRY_MS = 30_000;
export const MAX_ACTIVE_RETRIES = 20;
// Fold rows due within this lookahead ride the same frame.
export const FLUSH_SLACK_MS = 5_000;
// Characters of facts a frame carries; past it, lists collapse to counts.
export const FRAME_FACT_BUDGET = 3_000;
// Lines a section carries before the rest becomes one count line, so a
// released backlog (a paused role's week) reads as a digest, not a ledger.
export const FRAME_WHY_LINES = 15;
export const FRAME_PLAN_LINES = 8;
export const FRAME_CHANGED_LINES = 12;
// Chat lines a frame carries from the channels the role follows.
export const FRAME_CHANNEL_LINES = 20;

type Ctx = { db: any; scheduler?: any };

export type FlushOutcome =
  | { outcome: "noop"; reason: string }
  | { outcome: "held"; reason: string }
  | { outcome: "rescheduled"; attempt: number }
  | { outcome: "dropped"; wake_id: Id<"role_wakes"> }
  | { outcome: "delivered"; wake_id: Id<"role_wakes">; short_id: string; pending_message_id: Id<"pending_messages">; frame_chars: number };

const shortHash = (text: string): string => {
  // FNV-1a, 32 bit: enough to tell "the charter changed" in a frame line.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

const firstLine = (text: string | undefined | null): string => (text ?? "").split("\n")[0].trim();

// One outbox row is one line, in the frame and in the wake log alike. A row
// that folded several events (orgEvents: one row per (table, id) per window)
// says how many, so "task ct-5 is done (changed 7 times)" is the whole story.
export function causeLine(row: { cause: string; count?: number | null }): string {
  const cause = row.cause.replace(RESTART_CAUSE, "").trim();
  return (row.count ?? 1) > 1 ? `${cause} (changed ${row.count} times)` : cause;
}

// The rows of one frame, one entry per (table, id): the newest row's cause
// is the state, the counts sum, and a group is passive only when every row
// in it is. Immediate rows (a person's message, a decision) never group: each
// reaches the role as itself. Newest first. The enqueue side merges repeats
// inside a window (orgEvents); this covers rows that landed as separate rows,
// such as a backlog released by a resume.
export function groupRowsForFrame(rows: any[]): Array<{ cause: string; count: number; passive: boolean; held: boolean; at: number }> {
  const groups = new Map<string, { cause: string; count: number; passive: boolean; held: boolean; at: number }>();
  let n = 0;
  for (const r of rows) {
    const at = r.created_at ?? 0;
    const key = r.kind !== "immediate" && r.ref ? `${r.ref.table}:${r.ref.id}` : `row:${n++}`;
    const g = groups.get(key);
    const count = r.count ?? 1;
    if (!g) { groups.set(key, { cause: r.cause, count, passive: r.kind === "passive", held: !!r.held_at, at }); continue; }
    g.count += count;
    g.passive = g.passive && r.kind === "passive";
    g.held = g.held || !!r.held_at;
    if (at >= g.at) { g.at = at; g.cause = r.cause; }
  }
  return [...groups.values()].sort((a, b) => b.at - a.at);
}

// The first `cap` lines, then one line counting the rest.
function capped(lines: string[], cap: number, noun: string): string[] {
  return lines.length <= cap ? lines : [...lines.slice(0, cap), `- and ${lines.length - cap} more ${noun}`];
}

// ── Frame ───────────────────────────────────────────────────────────────────

export type FrameInput = {
  role: any;
  anchor: any | null;
  rows: any[];
  facts: BriefFacts;
  charter: { content: string } | null;
  brief: { content: string } | null;
  channelLines: Array<{ channel_name: string; author_name: string; text: string; message_id: any; thread_root_id?: any }>;
  parentName: string;
  restart: boolean;
  now: number;
};

export type Frame = { text: string; hasNewFacts: boolean; newestFactAt: number };

// The wake's short id goes on the opening tag once the log row exists (deliver
// mints it after the frame is built), so the transcript names the wake it
// renders and the web card can link "why did this wake me" to the log row.
export function stampWakeId(text: string, wakeShortId: string): string {
  return text.replace(/^<role-wake (\S+) (?:wake="[^"]*" )?/, `<role-wake $1 wake="${wakeShortId}" `);
}

// How long a session has waited, in the one unit a reader needs: 40m, 5h, 3d.
function waited(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

// Lists under a shared character budget: overflow becomes "+N more".
function budgeted(lines: string[], budget: { left: number }): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (budget.left - line.length - 1 < 0) {
      out.push(`- +${lines.length - i} more`);
      return out;
    }
    budget.left -= line.length + 1;
    out.push(line);
  }
  return out;
}

/** "spend (Paid search, up to $300 a month, until 2026-12-18); write (Ship pages)" or "none granted". */
export function authorityLine(authority: any[] | undefined, now: number): string {
  const rows = (authority ?? []).filter((g) => !g.expires_at || g.expires_at > now);
  if (!rows.length) return "none granted";
  return rows.map((g) => `${g.kind} (${g.label}${g.limit?.usd_per_month !== undefined ? `, up to $${g.limit.usd_per_month} a month` : g.limit?.usd_per_day !== undefined ? `, up to $${g.limit.usd_per_day} a day` : g.limit?.per_day !== undefined ? `, up to ${g.limit.per_day} a day` : ""}${g.expires_at ? `, until ${new Date(g.expires_at).toISOString().slice(0, 10)}` : ""})`).join("; ");
}
// One line per project in scope: the brief's sentence and how old it is, or
// that there is none. The frame never fills a missing line in for the role.
export function standingFrameLines(projects: Array<{ title: string; short_id?: string }>, brief: string | null | undefined, now: number): string[] {
  const lines = parseStandingSection(brief);
  return projects.map((p) => {
    const line = standingLineFor(lines, p);
    if (!line) return `- ${p.title}: no line yet`;
    const days = standingLineAgeDays(line, now);
    const age = days === null ? "undated" : days === 0 ? "written today" : `written ${days} day${days === 1 ? "" : "s"} ago${standingLineStale(line, now) ? ", older than a week" : ""}`;
    return `- ${p.title}: ${line.text} (${age})`;
  });
}

export function buildFrame(input: FrameInput): Frame {
  const { role, rows, facts, now } = input;
  const since = role.last_frame_seq ?? 0;
  const budget = { left: FRAME_FACT_BUDGET };
  const sections: string[] = [];

  const scopeNames = [
    ...facts.scope.projects.map((p) => `project ${p.title}`),
    ...facts.scope.plans.map((p) => `plan ${p.short_id} ${p.title}`),
  ];
  sections.push([
    `## You`,
    // The frame names no switch and carries no counters (org-staffing.md
    // S23): the role learns it cannot start a hand when it tries, and a day's
    // limit that holds it is a line in its brief, not a number it reads here.
    `${role.name} (@${role.handle}, ${role.short_id}) · reports to ${input.parentName}`,
    `Scope: ${scopeNames.length ? scopeNames.join(", ") : "the whole workspace"}`,
    // Authority is what the role may do outside codecast (org-hire.md H4).
    `Authority outside codecast: ${authorityLine(role.authority, Date.now())}`,
  ].join("\n"));

  // A group an earlier flush held (a cap, a pause) is marked so the backlog
  // reads apart from what woke the role now; the tag carries both counts so a
  // capped list still reports them whole (the web card reads the tag).
  const groups = groupRowsForFrame(rows);
  const heldCount = groups.filter((g) => g.held).length;
  const why = capped(groups.map((g) => `- ${g.held ? "(held) " : ""}${g.passive ? "(passive) " : ""}${causeLine(g)}`), FRAME_WHY_LINES, "changes");
  sections.push([`## Why you are awake`, ...(why.length ? why : ["- (nothing queued)"])].join("\n"));

  // Facts: counts always; the changed rows since the last frame as a diff.
  const t = facts.tasks;
  const factLines: string[] = [
    `Tasks: ${t.total} in scope, ${t.open} open · ${Object.entries(t.by_status).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`,
    `Priority: ${Object.entries(t.by_priority).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`,
    `Decisions: ${facts.decisions.open} open, ${facts.decisions.answered_today} answered today`,
  ];
  // Plans the role can still move: a done plan is history, not scope.
  const planLines = capped(
    facts.plans.filter((p) => p.status === "active" || p.status === "draft").map((p) => `- plan ${p.short_id} ${p.title}: ${p.progress.done}/${p.progress.total} done, ${p.progress.in_progress} in progress (${p.status})`),
    FRAME_PLAN_LINES, "plans");
  const changed = facts.changed.filter((c) => c.updated_at > since);
  const changedLines = capped(changed.map((c) => `- ${c.kind} ${c.short_id ?? ""} ${c.title} → ${c.status}`), FRAME_CHANGED_LINES, "changes");
  // The charters lead (org-staffing.md S7): a role directs its hands toward
  // each project's goal, not its task list. One line per chartered project.
  const charterLines = facts.scope.projects.map((p) => charterLine(`- project ${p.title}`, p)).filter((l): l is string => !!l);
  // Where it stands (scopes-and-feed.md F5.2): the role's own sentence per
  // project, read back from its brief beside the counts, with the line's
  // age, so a stale or missing line is visible to the role that owns it.
  const standingLines = standingFrameLines(facts.scope.projects, input.brief?.content, now);
  sections.push([
    `## Your scope now`,
    ...(charterLines.length ? [`Direction:`, ...budgeted(charterLines, budget)] : []),
    ...(standingLines.length ? [`Where it stands (your brief; a person reads these on your page):`, ...budgeted(standingLines, budget)] : []),
    ...factLines,
    ...(planLines.length ? [`Plans:`, ...budgeted(planLines, budget)] : []),
    ...(changedLines.length ? [`Changed since your last frame:`, ...budgeted(changedLines, budget)] : [`Nothing in scope changed since your last frame.`]),
  ].join("\n"));

  // Your sessions (org-roles-run-work.md R1): the ones waiting on a person
  // lead, longest wait first, each with how long it has waited and whether
  // the role already put it in front of the person. The role acts on that
  // list; the rest follow as one line each.
  const handLine = (h: (typeof facts.hands)[number]) => {
    const task = h.task
      ? ` · ${h.task.short_id} ${h.task.status}${h.task.execution_status ? ` (${h.task.execution_status})` : ""}${h.task.review_verdict ? ` · review: ${h.task.review_verdict}` : ""}`
      : "";
    const wait = h.waiting_since ? ` · waited ${waited(now - h.waiting_since)}${h.escalated ? ` · escalated: ${h.escalated.line}` : " · not escalated"}` : "";
    return `- ${h.short_id} ${h.title}: ${h.state}${wait}${task}${h.state_line ? ` — ${h.state_line}` : ""}`;
  };
  const waiting = facts.hands.filter((h) => h.waiting_since).sort((a, b) => a.waiting_since! - b.waiting_since!);
  const others = facts.hands.filter((h) => !h.waiting_since);
  // The people who report to the role (org-roles-run-work.md R6): each one's
  // goals from the brief with what moved and what stalled, then their
  // sessions that changed since the last frame. The role matches the
  // sessions to the goals in its own words and writes the matches back.
  const peopleLines: string[] = [];
  for (const p of facts.people ?? []) {
    const n = p.sessions_changed.length;
    peopleLines.push(`${p.name} (${p.goals.length} goal${p.goals.length === 1 ? "" : "s"} in your brief · ${n} session${n === 1 ? "" : "s"} changed since your last frame):`);
    if (!p.has_section) peopleLines.push(`  no goals yet: ask ${p.name} for their three to five and write them under "## Goals: ${p.name}" in your brief`);
    p.goals.forEach((g, i) => peopleLines.push(`  ${i + 1}. ${g.text}${g.priority ? ` (${g.priority})` : ""} — ${goalStateLine(g, now)}`));
    for (const s of capped(p.sessions_changed.map((s) => `  - ${s.short_id} ${s.title}: ${s.state}${s.state_line ? ` — ${s.state_line}` : ""}`), PERSON_SESSION_LINES, "sessions")) peopleLines.push(s);
  }
  sections.push([
    `## Your sessions`,
    ...(waiting.length ? [`Waiting on a person:`, ...budgeted(waiting.map(handLine), budget)] : []),
    ...(others.length ? [...(waiting.length ? [`The rest:`] : []), ...budgeted(others.map(handLine), budget)] : []),
    ...(facts.hands.length ? [] : ["- no sessions report to you"]),
    ...(peopleLines.length ? [`People who report to you:`, ...budgeted(peopleLines, budget)] : []),
  ].join("\n"));

  if (input.channelLines.length) {
    const lines = input.channelLines.map((l) => `- #${l.channel_name} ${l.author_name}: ${l.text} (thread ${l.thread_root_id ?? l.message_id})`);
    sections.push([`## Channels`, ...budgeted(lines, budget)].join("\n"));
  }

  const charterText = input.charter?.content ?? role.charter ?? "";
  if (input.restart) {
    sections.push([`## Charter`, charterText || "(no charter yet)"].join("\n"));
    sections.push([`## Brief`, input.brief?.content || "(empty; write it with `cast brief edit -`)"].join("\n"));
  } else {
    sections.push(`## Charter\nhash ${shortHash(charterText)} · read it with \`cast brief\``);
  }

  const newestFactAt = Math.max(
    0,
    ...facts.changed.map((c) => c.updated_at),
    ...facts.hands.map((h) => h.state_at ?? 0),
    ...(facts.people ?? []).flatMap((p) => p.sessions_changed.map((s) => s.updated_at)),
    ...input.channelLines.map((l: any) => l.created_at ?? 0),
  );
  const text = `<role-wake ${role.short_id} at="${new Date(now).toISOString()}" causes="${groups.length}" held="${heldCount}">\n${sections.join("\n\n")}\n</role-wake>`;
  return { text, hasNewFacts: newestFactAt > since || input.channelLines.length > 0, newestFactAt };
}

// ── Frame inputs from the db ────────────────────────────────────────────────

export async function parentNameOf(ctx: Ctx, role: any): Promise<string> {
  if (role.reports_to?.kind === "role") {
    const parent = await ctx.db.get(role.reports_to.role_id);
    return parent ? `${parent.name} (@${parent.handle})` : "a role";
  }
  const user = role.reports_to?.user_id ? await ctx.db.get(role.reports_to.user_id) : null;
  return user?.name || user?.email?.split("@")[0] || "a person";
}

export async function frameInputsFor(ctx: Ctx, role: any, rows: any[], now: number): Promise<FrameInput> {
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  // The host runs the standing session, so the frame reads with the host's grants.
  const facts = await computeBriefFacts(ctx, role.host_user_id, role, now);
  const charter = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
  const brief = role.brief_doc_id ? await ctx.db.get(role.brief_doc_id) : null;
  const channelIds: any[] = role.follow_channel_ids ?? [];
  // Read as the ROLE (its bot user), never as the host: the host may sit in
  // private rooms the role's bot is not a member of, and collectLinesSince
  // omits every channel its reader cannot open. Before the standing session
  // exists there is no bot yet, and the host is the only identity the role has.
  const readerId = anchor?.bot_user_id ?? role.host_user_id;
  const channelLines = channelIds.length
    ? (await collectLinesSince(ctx, readerId, channelIds, role.last_wake_at ?? now - 24 * 3600_000, FRAME_CHANNEL_LINES)).lines
    : [];
  return {
    role,
    anchor,
    rows,
    facts,
    charter: charter ? { content: charter.content } : null,
    brief: brief ? { content: brief.content } : null,
    channelLines,
    parentName: await parentNameOf(ctx, role),
    restart: rows.some((r) => String(r.cause ?? "").startsWith(RESTART_CAUSE)),
    now,
  };
}

// The frame the role would get now, or (with `wake_id`) a past wake's rows
// rendered again against today's facts, to read what a change to the
// builder does to a frame that already shipped.
export const frameFor = internalQuery({
  args: { role_id: v.id("org_roles"), wake_id: v.optional(v.id("role_wakes")) },
  handler: async (ctx, args) => {
    const role = await ctx.db.get(args.role_id);
    if (!role) return null;
    const wake = args.wake_id ? await ctx.db.get(args.wake_id) : null;
    const rows = wake
      ? await ctx.db.query("role_wake_outbox").withIndex("by_role_flushed", (q: any) => q.eq("role_id", args.role_id).eq("flushed_at", wake.created_at)).take(OUTBOX_READ_CAP)
      : await unflushedRowsFor(ctx, args.role_id);
    return buildFrame(await frameInputsFor(ctx, role, rows, Date.now()));
  },
});

// ── Deliver ─────────────────────────────────────────────────────────────────

async function logWake(
  ctx: Ctx,
  role: any,
  rows: any[],
  status: "delivered" | "dropped" | "held",
  frameChars: number,
  pendingMessageId: Id<"pending_messages"> | undefined,
  now: number,
): Promise<{ wake_id: Id<"role_wakes">; short_id: string }> {
  const short_id = await nextShortId(ctx.db, "rw");
  const wake_id: Id<"role_wakes"> = await ctx.db.insert("role_wakes", {
    role_id: role._id,
    short_id,
    causes: rows.map((r) => firstLine(causeLine(r)).slice(0, 200)),
    status,
    frame_chars: frameChars,
    pending_message_id: pendingMessageId,
    created_at: now,
  });
  return { wake_id, short_id };
}

async function markFlushed(ctx: Ctx, rows: any[], wakeId: Id<"role_wakes">, now: number): Promise<void> {
  for (const r of rows) await ctx.db.patch(r._id, { flushed_at: now, wake_id: wakeId });
}

// Rows a gate kept waiting carry the first hold's time; the next frame marks
// their group "(held)" so the backlog reads apart from the cause of the wake.
async function markHeld(ctx: Ctx, rows: any[], now: number): Promise<void> {
  for (const r of rows) {
    if (r.held_at) continue;
    r.held_at = now;
    await ctx.db.patch(r._id, { held_at: now });
  }
}

// One transaction: the pending message, the rows, the log, the counters.
export async function deliver(
  ctx: Ctx,
  role: any,
  anchor: any,
  conversation: any,
  rows: any[],
  frame: Frame,
  now: number,
): Promise<Extract<FlushOutcome, { outcome: "delivered" }>> {
  const { wake_id, short_id } = await logWake(ctx, role, rows, "delivered", frame.text.length, undefined, now);
  const text = stampWakeId(frame.text, short_id);
  // A person's message parked as "held" in the session: the frame rides that
  // row and releases it, so the role spends one turn and the daemon never
  // delivers the raw message ahead of the frame. Every other held row these
  // outbox rows point at is released too, folded into this frame's causes.
  let pendingMessageId: Id<"pending_messages"> | undefined;
  for (const r of rows) {
    if (!r.pending_message_id) continue;
    const pending = await ctx.db.get(r.pending_message_id);
    if (!pending || String(pending.conversation_id) !== String(conversation._id)) continue;
    if (pending.status !== "held" && pending.status !== "pending") continue;
    if (!pendingMessageId) {
      await ctx.db.patch(pending._id, { content: text, status: "pending" });
      pendingMessageId = pending._id;
    } else if (pending.status === "held") {
      await ctx.db.patch(pending._id, { status: "cancelled", cancelled_at: now });
    }
  }
  if (!pendingMessageId) {
    pendingMessageId = await enqueuePendingMessage(ctx, conversation, conversation.user_id, {
      content: text,
      client_id: short_id,
      role_wake: true,
    });
  }
  await ctx.db.patch(wake_id, { pending_message_id: pendingMessageId });
  await markFlushed(ctx, rows, wake_id, now);
  const counters = countersFor(role, now);
  await ctx.db.patch(role._id, {
    counters: { ...counters, wakes: counters.wakes + 1 },
    last_wake_at: now,
    last_frame_seq: now,
    updated_at: now,
  });
  return { outcome: "delivered", wake_id, short_id, pending_message_id: pendingMessageId, frame_chars: text.length };
}

// ── Flush ───────────────────────────────────────────────────────────────────

export async function performFlush(ctx: Ctx, roleId: Id<"org_roles">, attempt = 0): Promise<FlushOutcome> {
  const now = Date.now();
  const role = await ctx.db.get(roleId);
  if (!role) return { outcome: "noop", reason: "no_role" };
  const waiting = await unflushedRowsFor(ctx, roleId);
  const dueBy = now + FLUSH_SLACK_MS;
  const hasImmediate = waiting.some((r: any) => r.kind === "immediate" && r.due_at <= dueBy);
  const hasDueFold = waiting.some((r: any) => r.kind === "fold" && r.due_at <= dueBy);
  // A due immediate or fold row takes every waiting row with it: a fold row
  // still inside its coalesce window rides the frame that is going out anyway
  // (one coalesced wake, delivered up to coalesce_ms early) rather than
  // waiting for a flush nobody armed (enqueue arms one flush per window).
  // Passive rows are facts for the next frame, never a wake on their own.
  if (!hasImmediate && !hasDueFold) return { outcome: "noop", reason: waiting.length ? "passive_only" : "nothing_due" };
  const rows = waiting;

  // Gate 1: a paused or retired role holds its rows.
  if (role.status === "paused" || role.status === "retired") {
    await markHeld(ctx, rows, now);
    return { outcome: "held", reason: role.status };
  }

  // Gate 2: caps hold system rows; an immediate row (a person, a routine, a
  // decision) still goes through.
  const caps = capsFor(role);
  const counters = countersFor(role, now);
  if (!hasImmediate && (counters.wakes >= caps.wakes_per_day || counters.tokens >= caps.tokens_per_day)) {
    const reason = counters.wakes >= caps.wakes_per_day ? "wakes_cap" : "tokens_cap";
    await logWake(ctx, role, rows, "held", 0, undefined, now);
    await markHeld(ctx, rows, now);
    await scheduleFlush(ctx, roleId, msToNextUtcDay(now));
    return { outcome: "held", reason };
  }

  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const conversation = anchor?.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
  if (!anchor || anchor.status === "decommissioned" || !conversation) return { outcome: "held", reason: "no_session" };

  // Gate 3: a busy agent is asked again shortly.
  const managed = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation._id))
    .first();
  if (managed && ACTIVE_AGENT_STATUSES.has(managed.agent_status ?? "") && attempt < MAX_ACTIVE_RETRIES) {
    await scheduleFlush(ctx, roleId, ACTIVE_RETRY_MS, attempt + 1);
    return { outcome: "rescheduled", attempt: attempt + 1 };
  }

  const frame = buildFrame(await frameInputsFor(ctx, role, rows, now));
  if (!hasImmediate && !frame.hasNewFacts) {
    const { wake_id } = await logWake(ctx, role, rows, "dropped", 0, undefined, now);
    await markFlushed(ctx, rows, wake_id, now);
    return { outcome: "dropped", wake_id };
  }
  return await deliver(ctx, role, anchor, conversation, rows, frame, now);
}

export const flush = internalMutation({
  args: { role_id: v.id("org_roles"), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => performFlush(ctx, args.role_id, args.attempt ?? 0),
});
