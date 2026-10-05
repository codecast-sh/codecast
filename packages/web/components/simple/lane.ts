// The simple lane's model (plan pl-840, docs/architecture/hosted-assistant.md
// "The simple lane"): which conversations are the assistant's, what home
// shows in each of its three bands, how a transcript reads once tool steps
// fold into plain lines, and how a routine and the month's usage are said
// out loud. Pure: the screens read the store through hooks (useLane.ts) and
// hand the rows here, so every rule is testable without a browser.
//
// Every word this file returns is shown to someone who has never used a
// developer tool: no agent, session, model, token, repo or device.

import { isHostedAgentType, parseDecisionAnswer } from "@codecast/shared/contracts";
import { PLANS, type PlanId, type PlanSpec } from "@codecast/shared/contracts/assistant";
import { classifyUserMessage, isHiddenStubMessage, stripSystemTags } from "../conversation/classify";
import { cadenceLabel } from "../org/staffingModel";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import type { TaskRow } from "../triggerTasks";

/** Where each surface of the lane lives. */
export const LANE_PATHS = {
  home: "/simple",
  approvals: "/simple/approvals",
  routines: "/simple/routines",
  connections: "/simple/connections",
  plan: "/simple/plan",
  welcome: "/welcome",
} as const;

export function conversationPath(id: string): string {
  return `/simple/c/${id}`;
}

/** The lane preference (`client_state.ui.lane`). Absent is the full app. */
export type Lane = "simple" | "full";

export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

// ── Conversations ──────────────────────────────────────────────────────────

/** A conversation the lane lists: hosted, and not thrown away. */
export function isLaneConversation(row: Pick<InboxSession, "agent_type"> & { inbox_killed_at?: number | null }): boolean {
  return isHostedAgentType(row.agent_type) && !row.inbox_killed_at;
}

const PLACEHOLDER_TITLES = new Set(["new session", "new conversation", "untitled", ""]);

/** What a conversation is called: its title once it has a real one, else
 *  the first thing the person asked, else a plain fallback. */
export function conversationTitle(row: { title?: string | null; short_title?: string | null; last_user_message?: string | null } | null | undefined, firstAsk?: string | null): string {
  const title = (row?.short_title || row?.title || "").trim();
  if (title && !PLACEHOLDER_TITLES.has(title.toLowerCase())) return title;
  const ask = (firstAsk ?? row?.last_user_message ?? "").trim().replace(/\s+/g, " ");
  if (ask) return ask.length > 64 ? `${ask.slice(0, 61).trimEnd()}...` : ask;
  return "A new conversation";
}

/** The live states the lane distinguishes. `working` covers queued input the
 *  assistant has not picked up yet: from the person's side it is already on it. */
export type ConversationState = "waiting" | "working" | "done";

const WORKING_STATUSES = new Set(["working", "thinking", "compacting", "starting", "resuming", "connected"]);

export function conversationState(
  row: Pick<InboxSession, "agent_status" | "has_pending" | "awaiting_input">,
  openApprovals: number,
): ConversationState {
  if (openApprovals > 0 || row.awaiting_input) return "waiting";
  if (row.has_pending || (row.agent_status && WORKING_STATUSES.has(row.agent_status))) return "working";
  return "done";
}

export interface HomeBands<S> {
  /** Conversations parked on the person, newest question first. */
  waiting: S[];
  working: S[];
  /** Everything else, most recently touched first. */
  done: S[];
}

/** Splits the lane's conversations into home's three bands. */
export function homeBands<S extends Pick<InboxSession, "_id" | "updated_at" | "agent_status" | "has_pending" | "awaiting_input">>(
  rows: S[],
  approvalsByConversation: Map<string, number>,
): HomeBands<S> {
  const bands: HomeBands<S> = { waiting: [], working: [], done: [] };
  for (const row of rows) bands[conversationState(row, approvalsByConversation.get(row._id) ?? 0)].push(row);
  const newest = (a: S, b: S) => (b.updated_at ?? 0) - (a.updated_at ?? 0);
  bands.waiting.sort(newest);
  bands.working.sort(newest);
  bands.done.sort(newest);
  return bands;
}

// ── Approvals ──────────────────────────────────────────────────────────────

/** An open approval: a pending decision on one of the lane's conversations. */
export function isOpenApproval(d: Pick<SessionDecisionItem, "status" | "conversation_id">, laneIds: Set<string>): boolean {
  return d.status === "pending" && laneIds.has(String(d.conversation_id));
}

export function oldestFirst<T extends { created_at: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.created_at - b.created_at);
}

export function countByConversation(rows: Array<{ conversation_id: string }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.conversation_id), (out.get(String(r.conversation_id)) ?? 0) + 1);
  return out;
}

/** How each answer button looks: the first is the yes, a refusal is quiet. */
export function answerTone(label: string, index: number): "yes" | "plain" | "no" {
  if (/^(decline|no\b|don'?t|cancel|skip|not now|reject)/i.test(label.trim())) return "no";
  return index === 0 ? "yes" : "plain";
}

// ── Tool steps ─────────────────────────────────────────────────────────────

export interface ToolCallLike {
  id?: string;
  name?: string;
  input?: unknown;
  /** A plain past-tense sentence the tool or the engine wrote for people. */
  summary?: string;
}

export interface ToolResultLike {
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  summary?: string;
}

export interface Step {
  id: string;
  text: string;
  state: "running" | "done" | "failed";
}

function parsedInput(input: unknown): Record<string, any> {
  if (input && typeof input === "object") return input as Record<string, any>;
  if (typeof input === "string") {
    try {
      const v = JSON.parse(input);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** A person's name from an address: "Dana Ruiz <dana@x.org>" is Dana Ruiz,
 *  "dana.ruiz@x.org" is Dana. */
export function personName(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string" || !first.trim()) return null;
  const s = first.trim();
  const named = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  let name = named ? named[1].trim() : s;
  if (name.includes("@")) {
    const local = name.split("@")[0].split(/[._+-]/)[0];
    name = local ? local[0].toUpperCase() + local.slice(1) : name;
  }
  const more = Array.isArray(raw) && raw.length > 1 ? ` and ${raw.length - 1} other${raw.length > 2 ? "s" : ""}` : "";
  return name + more;
}

function quoted(s: unknown, max = 48): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim().replace(/\s+/g, " ");
  return `"${t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t}"`;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** How many items a result lists, when it says so plainly. */
function resultCount(content: unknown): number | null {
  if (Array.isArray(content)) return content.length;
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    for (const k of ["count", "total", "results"]) {
      if (typeof o[k] === "number") return o[k] as number;
      if (Array.isArray(o[k])) return (o[k] as unknown[]).length;
    }
  }
  return null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type Phrase = (input: Record<string, any>, result: ToolResultLike | undefined) => string;

// The assistant's tools by what they do. A name matches the first rule whose
// pattern it fits, so a new tool with a familiar name reads well before
// anyone writes it a sentence; a tool can always say it best itself through
// `summary`.
const PHRASES: Array<[RegExp, Phrase]> = [
  [/(send|reply).*(mail|email|message)|^send_?(mail|email)$/i, (i) => {
    const who = personName(i.to ?? i.recipient ?? i.recipients);
    return who ? `Sent an email to ${who}` : "Sent an email";
  }],
  [/draft/i, (i) => {
    const who = personName(i.to ?? i.recipient ?? i.recipients);
    return who ? `Drafted a reply to ${who}` : "Drafted a reply";
  }],
  [/(search|list|read|get|find|check).*(mail|email|inbox|thread)/i, (i, r) => {
    const n = resultCount(r?.content);
    const q = quoted(i.query ?? i.q);
    if (n !== null) return `Read ${plural(n, "email")}${q ? ` matching ${q}` : ""}`;
    return q ? `Looked through your email for ${q}` : "Looked through your email";
  }],
  [/(label|archive|file|move|mark).*(mail|email|thread)/i, () => "Tidied your inbox"],
  [/(create|add|schedule|book).*(event|meeting|calendar)/i, (i) => {
    const t = quoted(i.title ?? i.summary);
    return t ? `Added ${t} to your calendar` : "Added an event to your calendar";
  }],
  [/(update|move|change|reschedule).*(event|meeting)/i, () => "Changed an event on your calendar"],
  [/(delete|cancel|remove).*(event|meeting)/i, () => "Removed an event from your calendar"],
  [/(read|list|get|check|find|search).*(calendar|event|availability|free|busy)/i, (_i, r) => {
    const n = resultCount(r?.content);
    return n !== null ? `Checked your calendar (${plural(n, "event")})` : "Checked your calendar";
  }],
  [/web_?search|search_?web|^search$/i, (i) => {
    const q = quoted(i.query ?? i.q);
    return q ? `Searched the web for ${q}` : "Searched the web";
  }],
  [/fetch|read_?page|browse|open_?url|web_?read/i, (i) => {
    const host = hostOf(i.url);
    return host ? `Read a page on ${host}` : "Read a web page";
  }],
  [/(create|add).*(task|todo|to_do)/i, (i) => {
    const t = quoted(i.title);
    return t ? `Added a to-do: ${t}` : "Added a to-do";
  }],
  [/(create|write|add).*(doc|note|page)/i, (i) => {
    const t = quoted(i.title);
    return t ? `Wrote a note: ${t}` : "Wrote a note";
  }],
  [/(create|add|set|schedule).*(routine|trigger|reminder)/i, (i) => {
    const t = quoted(i.title);
    return t ? `Set up a routine: ${t}` : "Set up a routine";
  }],
  [/(ask|approval|decide)/i, () => "Asked for your go-ahead"],
];

function humanize(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? `Used ${words}` : "Did a step";
}

/** One tool call as one plain line. */
export function stepText(call: ToolCallLike, result?: ToolResultLike): string {
  const own = (result?.summary ?? call.summary)?.trim();
  if (own) return own;
  const name = call.name ?? "";
  const input = parsedInput(call.input);
  for (const [pattern, phrase] of PHRASES) if (pattern.test(name)) return phrase(input, result);
  return humanize(name);
}

// ── Transcript ─────────────────────────────────────────────────────────────

export interface LaneMessage {
  _id: string;
  role: string;
  content?: string;
  timestamp: number;
  tool_calls?: ToolCallLike[];
  tool_results?: ToolResultLike[];
  images?: any[];
  _isOptimistic?: true;
  _isQueued?: true;
  _isFailed?: true;
  _clientId?: string;
  client_id?: string;
}

export type TranscriptItem =
  | { kind: "you"; id: string; text: string; pending: boolean; failed: boolean; at: number }
  | { kind: "said"; id: string; text: string; at: number }
  | { kind: "steps"; id: string; steps: Step[] }
  | { kind: "answer"; id: string; text: string; at: number }
  | { kind: "note"; id: string; text: string; at: number };

/** The transcript as the lane shows it: the person's words, the assistant's
 *  words, and between them each run of tool calls folded into a list of
 *  plain lines. `live` says a turn is still running, so a call with no
 *  result yet is in progress rather than lost. */
export function buildTranscript(messages: LaneMessage[], live: boolean): TranscriptItem[] {
  const results = new Map<string, ToolResultLike>();
  for (const m of messages) for (const r of m.tool_results ?? []) if (r?.tool_use_id) results.set(r.tool_use_id, r);

  const items: TranscriptItem[] = [];
  let prev: LaneMessage | null = null;
  const pushStep = (step: Step) => {
    const last = items[items.length - 1];
    if (last?.kind === "steps") last.steps.push(step);
    else items.push({ kind: "steps", id: `steps-${step.id}`, steps: [step] });
  };

  for (const m of messages) {
    if (m.role === "user") {
      const kind = classifyUserMessage(m as any, undefined, prev as any).kind;
      if (kind === "normal" || kind === "direct_user") {
        const text = stripSystemTags(m.content ?? "").trim();
        if (text) items.push({ kind: "you", id: m._id, text, pending: !!(m._isOptimistic || m._isQueued), failed: !!m._isFailed, at: m.timestamp });
      } else if (kind === "decision_answer") {
        const answer = parseDecisionAnswer(m.content)?.answer;
        if (answer) items.push({ kind: "answer", id: m._id, text: `You said: ${answer}`, at: m.timestamp });
      } else if (kind === "scheduled_task") {
        items.push({ kind: "note", id: m._id, text: "A routine started this", at: m.timestamp });
      }
    } else if (m.role === "assistant") {
      const text = stripSystemTags(m.content ?? "").trim();
      if (text && !isHiddenStubMessage(m)) items.push({ kind: "said", id: m._id, text, at: m.timestamp });
      for (const [i, call] of (m.tool_calls ?? []).entries()) {
        const result = call.id ? results.get(call.id) : undefined;
        const state: Step["state"] = result ? (result.is_error ? "failed" : "done") : live ? "running" : "done";
        pushStep({ id: call.id ?? `${m._id}-${i}`, text: stepText(call, result), state });
      }
    }
    prev = m;
  }
  return items;
}

/** The first thing the person asked, for naming a conversation that has no title yet. */
export function firstAsk(messages: LaneMessage[]): string | null {
  for (const item of buildTranscript(messages.slice(0, 6), false)) if (item.kind === "you") return item.text;
  return null;
}

// ── Routines ───────────────────────────────────────────────────────────────

const ROUTINE_LIVE = new Set(["scheduled", "running", "paused"]);

/** A routine the lane lists: armed or paused, bound to one of its conversations. */
export function isLaneRoutine(t: Pick<TaskRow, "status" | "originating_conversation_id">, laneIds: Set<string>): boolean {
  return ROUTINE_LIVE.has(t.status) && !!t.originating_conversation_id && laneIds.has(String(t.originating_conversation_id));
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** When something happens next, said the way a person would: "today at 8:00
 *  AM", "tomorrow at 9:30 AM", "Thursday at 7:00 PM", "Oct 21 at 8:00 AM". */
export function whenSaid(at: number, now: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `today at ${clock(at)}`;
  if (days === 1) return `tomorrow at ${clock(at)}`;
  if (days > 1 && days < 7) return `${new Date(at).toLocaleDateString([], { weekday: "long" })} at ${clock(at)}`;
  return `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} at ${clock(at)}`;
}

/** A routine's schedule as one sentence. */
export function routineSchedule(t: Pick<TaskRow, "schedule_type" | "interval_ms" | "run_at" | "status">, now: number): string {
  const cadence = t.schedule_type === "recurring" ? cadenceLabel(t.interval_ms) : "once";
  if (t.status === "paused") return t.schedule_type === "recurring" ? `Paused. Runs ${cadence} when it's on` : "Paused";
  if (t.status === "running") return t.schedule_type === "recurring" ? `Running now. Then ${cadence}` : "Running now";
  if (!t.run_at) return t.schedule_type === "recurring" ? `Runs ${cadence}` : "Waiting to run";
  const next = whenSaid(Math.max(t.run_at, now), now);
  return t.schedule_type === "recurring" ? `Runs ${cadence}, next ${next}` : `Runs once, ${next}`;
}

/** Whether a routine runs (or ran) today: home's "coming up today" line. */
export function runsToday(t: Pick<TaskRow, "status" | "run_at">, now: number): boolean {
  if (t.status !== "scheduled" || !t.run_at) return false;
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return t.run_at <= end.getTime();
}

// ── Usage and plans ────────────────────────────────────────────────────────

export interface MeterFigures {
  used_usd: number;
  reserved_usd: number;
  cap_usd: number;
  topup_usd: number;
}

/** The meter's two fills as fractions of the allowance, never past full (a
 *  run that overshoots its hold can push usage above the cap). */
export function meterFill(w: MeterFigures): { used: number; held: number } {
  if (w.cap_usd <= 0) return { used: w.used_usd > 0 ? 1 : 0, held: 0 };
  const used = Math.min(1, Math.max(0, w.used_usd / w.cap_usd));
  const held = Math.min(1 - used, Math.max(0, w.reserved_usd / w.cap_usd));
  return { used, held };
}

export function dollars(usd: number): string {
  const v = Math.max(0, usd);
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

/** The meter's headline: how much of the month is left, in words. */
export function usageHeadline(w: MeterFigures): string {
  const { used } = meterFill(w);
  if (w.used_usd >= w.cap_usd && w.topup_usd <= 0) return "You've used all of this month's allowance";
  if (w.used_usd >= w.cap_usd) return "This month's allowance is used up, so your extra credit is in use";
  if (used >= 0.8) return "Most of this month's allowance is used";
  if (used === 0) return "Nothing used yet this month";
  return `${Math.round(used * 100)}% of this month's allowance used`;
}

/** What each plan gives, in plain words. Every number comes from PLANS. */
export function planPoints(plan: PlanSpec): string[] {
  const { max, min_interval_ms } = plan.routines;
  const routines = max === null
    ? "Unlimited routines"
    : `${plural(max, "routine")}${min_interval_ms ? `, ${cadenceLabel(min_interval_ms).replace(/^every /, "at most every ")}` : ""}`;
  const together = plan.concurrent_turns === 1 ? "One thing at a time" : `${plan.concurrent_turns} things at once`;
  const thinking = plan.strong_model !== plan.default_model ? "Deeper thinking for hard problems" : null;
  return [`${dollars(plan.included_usd)} of work included each month`, routines, together, ...(thinking ? [thinking] : [])];
}

export function planPrice(plan: PlanSpec): string {
  return plan.price_usd === 0 ? "Free" : `${dollars(plan.price_usd).replace(/\.00$/, "")} a month`;
}

/** The plans above `current`, cheapest first: what an upgrade can move to. */
export function upgradesFrom(current: PlanId): PlanSpec[] {
  const order = Object.values(PLANS).sort((a, b) => a.price_usd - b.price_usd);
  const at = order.findIndex((p) => p.id === current);
  return order.slice(at + 1);
}

/** The top-up amounts the plan screen offers, in US dollars. */
export const TOPUP_AMOUNTS_USD = [10, 25] as const;

// ── Greeting ───────────────────────────────────────────────────────────────

export function greeting(now: number, name?: string | null): string {
  const h = new Date(now).getHours();
  const part = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}
