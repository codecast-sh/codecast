import { Id } from "./_generated/dataModel";
import { scopedFetch } from "./data";
import { namedTextOf, namesRecord, recordWords } from "./lib/orgActivity";
import { canAccessChannel, teamRooms } from "./chatAccess";
import { userMayRead } from "./lib/decisionAccess";
import { callModel } from "./lib/anthropic";
import type { VendorGate } from "./lib/vendorGuard";
import { pickStatedGoals, type AskModel, type GoalCandidate, type StatedGoals } from "./lib/statedGoals";
import { canReadCall } from "./transcripts";
import { isRoomlessKey } from "@codecast/shared/contracts";
import { ANALYSIS_CAPS, ANALYSIS_WINDOW_MS } from "./lib/orgAnalysisCaps";
import { lineSpeakerNames } from "./lib/callSpeakers";
import type { ProjectRef } from "./orgInit";

// The org analysis's reads of what people said and the goals they stated
// (docs/architecture/org-init.md), split out of orgInit.ts.

type Ctx = { db: any };

// ── What people said: calls and chat (org-eval, 2026-09-23) ────────────────
// The reviewer never read a word a person wrote: it judged the company from
// records and commits. `said` hands it the team's calls of the window (the
// generated summary and action items, never the transcript) and the chat
// threads where a person decided something, asked for something, or named a
// role or a project, each as its root line, who wrote it, the channel, and
// up to three replies that carry a decision or an ask. One byte budget over
// both, calls first, newest first, with `truncated` when threads were left
// out. Access is the caller's: a call the caller may not read (a private
// channel's huddle, a recording its creator never shared) is not here, and
// the chat rows came through the channel access check above.
const DECIDED_RE = /\b(decid(?:e|ed|es|ing|sion|sions)|agreed?|approv(?:e|ed|es|al)|go(?:ing)? with|let'?s (?:go|do|use|ship|keep|drop|make|move|start|stop|try|not)|we(?:'ll| will| should| are going to| won'?t| decided| agreed)|from now on|instead of|settled|ship it|the plan is|final(?:ly|ized|ised)?|no longer|not going to)\b/i;
const ASKED_RE = /\?|\b(?:can|could|would|will) (?:you|someone|anyone|we)\b|\bplease\b|\bneed(?:s|ed)? (?:a|an|to|you|someone|help)\b|\bshould we\b|\bwho (?:owns|has|can)\b|\b(?:thoughts|wdyt|eta)\b/i;
export type SaidWhy = "decided" | "asked" | "named";
export type SaidLine = { at: number; by: string; line: string };
export type SaidThread = SaidLine & { channel: string; why: SaidWhy[]; replies: SaidLine[] };
/** `lines` is what a call with no summary said: its decisions and asks, in
 *  order, from its own transcript (bounded); `summary_status` says why there
 *  is no summary ("skipped": too little said; "failed"; "pending"; null: never
 *  tried). A summarised call carries no lines. */
export type SaidCall = { id: string | null; title: string | null; started_at: number; ended_at: number | null; participants: string[]; summary: string | null; summary_status: string | null; action_items: string[]; lines?: SaidLine[] };
export type Said = { calls: SaidCall[]; chat: SaidThread[]; truncated: boolean; goals?: StatedGoals };
/** Why a line matters: what it decides, asks, or names (a role by handle or
 *  mention, a project by short id or two title words). Empty when nothing. */
export function saidWhyOf(m: { content?: string; mentions?: any[] }, roles: string[], projects: Array<{ ref: ProjectRef; words: string[] }>): SaidWhy[] {
  const text = m.content ?? "";
  const why: SaidWhy[] = [];
  if (DECIDED_RE.test(text)) why.push("decided");
  if (ASKED_RE.test(text)) why.push("asked");
  const lower = text.toLowerCase();
  const named = namedTextOf(text);
  const namesRole = (m.mentions ?? []).some((x: any) => x && typeof x === "object" && x.kind === "role") || roles.some((h) => lower.includes(`@${h.toLowerCase()}`));
  if (namesRole || projects.some(({ ref, words }) => namesRecord(named, ref, words))) why.push("named");
  return why;
}
/** The threads worth the reviewer's eye from the rows the channel loop read.
 *  A thread is its root (in the read, or fetched when only its replies are)
 *  and the person written replies that decide or ask, newest three in time
 *  order; it qualifies when the root or such a reply carries a signal. An
 *  agent's line is context, never a signal. */
/** Who wrote a chat line, and whether a person did: an agent's line is context, never a signal. */
function chatAuthors(ctx: Ctx) {
  const users = new Map<string, any>();
  const userOf = async (id: any) => { const k = String(id); if (!users.has(k)) users.set(k, await ctx.db.get(id)); return users.get(k); };
  return {
    nameOf: async (m: any) => { const u = await userOf(m.user_id); return (u?.name ?? u?.email ?? "?") as string; },
    isPerson: async (m: any) => m.author_kind !== "agent" && !(await userOf(m.user_id))?.is_bot,
  };
}
const usableChat = (m: any) => m && !m.deleted_at && typeof m.content === "string" && m.content.trim();
export async function saidChatFrom(ctx: Ctx, read: Array<{ channel: any; msgs: any[] }>, roles: string[], projects: ProjectRef[]): Promise<SaidThread[]> {
  const refs = projects.map((ref) => ({ ref, words: recordWords(ref.title) }));
  const { nameOf, isPerson } = chatAuthors(ctx);
  const usable = usableChat;
  const out: SaidThread[] = [];
  for (const { channel, msgs } of read) {
    const roots = new Map<string, any>();
    const replies = new Map<string, any[]>();
    for (const m of msgs) {
      if (!usable(m)) continue;
      if (m.thread_root_id) replies.set(String(m.thread_root_id), [...(replies.get(String(m.thread_root_id)) ?? []), m]);
      else roots.set(String(m._id), m);
    }
    for (const rootId of replies.keys()) if (!roots.has(rootId)) { const root = await ctx.db.get(rootId as Id<"chat_messages">); if (usable(root)) roots.set(rootId, root); }
    for (const [rootId, root] of roots) {
      const rootWhy = (await isPerson(root)) ? saidWhyOf(root, roles, refs) : [];
      const picked: SaidLine[] = [];
      const why = new Set<SaidWhy>(rootWhy);
      const inThread = (replies.get(rootId) ?? []).sort((a, b) => b.created_at - a.created_at);
      for (const r of inThread) {
        if (picked.length >= ANALYSIS_CAPS.said_replies_per_thread) break;
        if (!(await isPerson(r))) continue;
        const w = saidWhyOf(r, roles, refs).filter((x) => x !== "named");
        if (!w.length) continue;
        for (const x of w) why.add(x);
        picked.push({ at: r.created_at, by: await nameOf(r), line: r.content.trim().slice(0, ANALYSIS_CAPS.said_reply_chars) });
      }
      if (!why.size) continue;
      out.push({ channel: `#${channel.name}`, at: root.created_at, by: await nameOf(root), line: root.content.trim().slice(0, ANALYSIS_CAPS.said_line_chars), why: Array.from(why), replies: picked.reverse() });
    }
  }
  const newest = (t: SaidThread) => Math.max(t.at, ...t.replies.map((r) => r.at));
  return out.sort((a, b) => newest(b) - newest(a));
}
/** The lines of an unsummarised call worth the reviewer's eye: those that
 *  decide or ask, in order, capped; when none does, the first few lines, so a
 *  short call is still read as what it was. Consecutive lines of one speaker
 *  join, the way a person hears them. */
export function saidCallLines(segments: Array<{ at: number; by: string; text: string }>): SaidLine[] {
  const joined = speakerTurns(segments);
  const signal = joined.filter((l) => DECIDED_RE.test(l.line) || ASKED_RE.test(l.line));
  return (signal.length ? signal : joined).slice(0, ANALYSIS_CAPS.call_lines).map((l) => ({ ...l, line: l.line.slice(0, ANALYSIS_CAPS.said_reply_chars) }));
}
/** One speaker's consecutive segments as one turn, the way a person hears them. */
function speakerTurns(segments: Array<{ at: number; by: string; text: string }>): SaidLine[] {
  const joined: SaidLine[] = [];
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const last = joined[joined.length - 1];
    if (last && last.by === s.by) last.line = `${last.line} ${text}`;
    else joined.push({ at: s.at, by: s.by, line: text });
  }
  return joined;
}
const segmentsOf = async (ctx: Ctx, t: any, take: number) => {
  // A voice note's diarized lines are named through its speakers (lib/callSpeakers).
  const nameOf = await lineSpeakerNames(ctx, t);
  return ((await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id)).take(take)) as any[]).map((x) => ({
    at: t.started_at + (x.t0 ?? 0),
    by: (x.speaker_name ? nameOf(x) : "") || "?",
    text: x.text ?? "",
  }));
};
/** The window's calls the caller may read and in which something was said,
 *  newest first, up to the cap. The cap counts these, never the huddles that
 *  ended before words: Union had 30 such rows in a month, and counted against
 *  the cap they pushed two weeks of real calls out of the read. */
async function readableCalls(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, now: number): Promise<any[]> {
  const cutoff = now - ANALYSIS_WINDOW_MS;
  const out: any[] = [];
  for await (const t of ctx.db.query("transcripts").withIndex("by_team_started", (q: any) => q.eq("team_id", teamId).gte("started_at", cutoff)).order("desc")) {
    if (out.length >= ANALYSIS_CAPS.calls) break;
    if ((t.started_at ?? 0) < cutoff || t.status !== "ended") continue;
    if (isRoomlessKey(t.room_key) && !t.rec_shared) continue;
    if (!t.summary && !(t.action_items ?? []).length && !(t.participants ?? []).length) continue;
    if (!(await canReadCall(ctx as any, userId, t))) continue;
    out.push(t);
  }
  return out;
}
export async function readSaid(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">, now: number, chatRead: Array<{ channel: any; msgs: any[] }>, projects: ProjectRef[]): Promise<Said> {
  const calls: SaidCall[] = [];
  let unsummarised = 0;
  for (const t of await readableCalls(ctx, userId, teamId, now)) {
    const call: SaidCall = { id: t.short_id ?? null, title: t.title ?? null, started_at: t.started_at, ended_at: t.ended_at ?? null, participants: (t.participants ?? []).map((p: any) => p.name), summary: t.summary ? String(t.summary).slice(0, ANALYSIS_CAPS.call_summary_chars) : null, summary_status: t.summary_status ?? null, action_items: (t.action_items ?? []).slice(0, ANALYSIS_CAPS.call_action_items).map((a: any) => String(a).slice(0, 200)) };
    // A huddle with people in it and no summary (too short for one, or the
    // summary failed) is the gap the reviewer used to read as silence: its
    // own words are read instead, bounded to a few calls and the lines that
    // decide or ask, so a two minute "let's drop the ads" still reaches it.
    if (!call.summary && !call.action_items.length && unsummarised < ANALYSIS_CAPS.calls_without_summary) {
      unsummarised++;
      call.lines = saidCallLines(await segmentsOf(ctx, t, ANALYSIS_CAPS.call_segments));
    }
    calls.push(call);
  }
  const roleRows: any[] = await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
  const threads = await saidChatFrom(ctx, chatRead, roleRows.map((r) => r.handle).filter(Boolean), projects);
  // One budget over both: the calls are few and dated, the threads fill the rest newest first.
  let bytes = JSON.stringify(calls).length;
  const chat: SaidThread[] = [];
  let truncated = false;
  for (const t of threads) {
    const size = JSON.stringify(t).length;
    if (bytes + size > ANALYSIS_CAPS.said_bytes) { truncated = true; break; }
    bytes += size;
    chat.push(t);
  }
  return { calls, chat, truncated };
}

// ── The goals people stated ──────────────────────────────────────────────────
// A goal comes from a person, and people state direction wherever they work:
// a chat line, a turn on a call, the answer to a decision an agent asked, a
// decision recorded on a plan, the brief that opened a long running session.
// At Union the founders set most direction in the last three. The readers
// here gather the window's candidates from each, highest signal first
// (answered decisions, plan decisions, session openings, chat, then calls,
// each newest first); lib/statedGoals has a model pick the lines that
// state direction. The session openings come from the org slice's long
// running rows, so they are added where both slices meet.
/** The window's goal candidates from decisions, plans, chat and calls. */
export async function readGoalCandidates(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number): Promise<{ candidates: GoalCandidate[]; truncated: boolean }> {
  if (!teamId) return { candidates: [], truncated: false };
  const cutoff = now - ANALYSIS_WINDOW_MS;
  const names = new Map<string, string>();
  const nameOfUser = async (id: any) => {
    const k = String(id);
    if (!names.has(k)) { const u: any = await ctx.db.get(id); names.set(k, u?.name ?? u?.email ?? "?"); }
    return names.get(k)!;
  };
  // Answered decisions: what a member chose, with the question it answered.
  const decisions: GoalCandidate[] = [];
  const readable = new Map<string, boolean>();
  const memberIds: Id<"users">[] = (await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect()).map((m: any) => m.user_id);
  for (const memberId of memberIds) {
    const rows: any[] = await ctx.db.query("session_decisions").withIndex("by_user_status_resolved", (q: any) => q.eq("user_id", memberId).eq("status", "answered").gte("resolved_at", cutoff)).order("desc").take(ANALYSIS_CAPS.goal_decisions_per_member);
    for (const d of rows) {
      if (String(d.team_id ?? "") !== String(teamId) || d.answered_by?.kind === "policy" || d.answered_by?.kind === "role") continue;
      // One access read per asking session and audience, not per card: a busy founder answers dozens from one thread.
      const key = JSON.stringify([d.conversation_id, d.asked_user_ids ?? [d.user_id], (d.hops ?? []).map((h: any) => h.role_id), d.workflow_run_id ? d.task_id : null]);
      if (!readable.has(key)) readable.set(key, await userMayRead(ctx, userId, d));
      if (!readable.get(key)) continue;
      const chosen = typeof d.answer_index === "number" ? d.options?.[d.answer_index]?.label : undefined;
      const answer = [chosen, d.answer_text].filter(Boolean).join(": ");
      if (!answer) continue;
      decisions.push({ kind: "decision", at: d.resolved_at, by: await nameOfUser(d.resolved_by ?? d.user_id), where: d.short_id ?? String(d._id), text: `Asked: ${d.question}\nAnswered: ${answer}` });
    }
  }
  decisions.sort((a, b) => b.at - a.at);
  // Decisions recorded on the workspace's plans.
  const plansRead = await scopedFetch(ctx, "plans", { userId, workspace: "team" as const, teamId, limit: ANALYSIS_CAPS.plans });
  const planned: GoalCandidate[] = [];
  for (const p of plansRead.records as any[]) {
    const owner = await nameOfUser(p.user_id);
    const entries = [
      ...(p.entries ?? []).filter((e: any) => e.type === "decision").map((e: any) => ({ at: e.timestamp, by: e.author ?? owner, text: e.content, why: e.rationale })),
      ...(p.decision_log ?? []).map((e: any) => ({ at: e.timestamp, by: owner, text: e.decision, why: e.rationale })),
    ];
    for (const e of entries) if (e.at >= cutoff && e.text?.trim()) planned.push({ kind: "plan", at: e.at, by: e.by, where: p.short_id ?? String(p._id), text: e.why ? `${e.text}\nWhy: ${e.why}` : e.text });
  }
  planned.sort((a, b) => b.at - a.at);
  // Every person written line of the window's channels.
  const { nameOf, isPerson } = chatAuthors(ctx);
  const written: GoalCandidate[] = [];
  const channels: any[] = await teamRooms(ctx, teamId, ANALYSIS_CAPS.channels);
  for (const ch of channels) {
    if (!ch.name || ch.archived_at || ch.kind === "dm" || !(await canAccessChannel(ctx as any, userId, ch))) continue;
    const msgs: any[] = await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cutoff)).order("desc").take(ANALYSIS_CAPS.goal_messages_per_channel);
    for (const m of msgs) if (usableChat(m) && (await isPerson(m))) written.push({ kind: "chat", at: m.created_at, by: await nameOf(m), where: `#${ch.name}`, text: m.content.trim() });
  }
  written.sort((a, b) => b.at - a.at);
  // Every speaker's turn of every readable call, newest call first.
  const spoken: GoalCandidate[] = [];
  let segmentsLeft = ANALYSIS_CAPS.goal_segments;
  for (const t of await readableCalls(ctx, userId, teamId, now)) {
    if (segmentsLeft <= 0) break;
    const segments = await segmentsOf(ctx, t, Math.min(ANALYSIS_CAPS.goal_segments_per_call, segmentsLeft));
    segmentsLeft -= segments.length;
    for (const l of speakerTurns(segments)) if (l.line.length >= ANALYSIS_CAPS.goal_turn_min_chars) spoken.push({ kind: "call", at: l.at, by: l.by, where: t.short_id ?? t.title ?? "a call", text: l.line });
  }
  return { candidates: [...decisions, ...planned, ...written, ...spoken], truncated: segmentsLeft <= 0 };
}
/** The opening brief of each long running session a person started, as a goal candidate. */
export function sessionOpeningCandidates(rows: Array<{ id: string; short_id?: string; owner?: string; started_at: number; first_message?: string }>): GoalCandidate[] {
  return rows.filter((r) => r.first_message?.trim()).map((r) => ({ kind: "session" as const, at: r.started_at, by: r.owner ?? "?", where: r.short_id ?? r.id, text: r.first_message! }));
}
/** Candidates in the order they are worth keeping: decisions and plans, then session openings, then chat and calls. */
export function goalCandidatesWith(read: { candidates: GoalCandidate[] }, openings: GoalCandidate[]): GoalCandidate[] {
  const firm = read.candidates.filter((c) => c.kind === "decision" || c.kind === "plan");
  const loose = read.candidates.filter((c) => c.kind !== "decision" && c.kind !== "plan");
  return [...firm, ...openings.sort((a, b) => b.at - a.at), ...loose];
}
/** The model read, on the deployment's key under the workspace's vendor gate. */
export function goalModelAsk(gate: VendorGate): AskModel {
  return async (req) => (await callModel({ ...req, label: "Stated goals", gate, timeout_ms: 90_000 }))?.text ?? null;
}
/** The stated goals from the candidates the readers gathered and the long running rows. */
export function readStatedGoals(read: { candidates: GoalCandidate[]; truncated: boolean }, longRunning: Parameters<typeof sessionOpeningCandidates>[0], workspace: string, ask: AskModel): Promise<StatedGoals> {
  return pickStatedGoals(goalCandidatesWith(read, sessionOpeningCandidates(longRunning)), read.truncated, workspace, ask);
}
