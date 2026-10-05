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
import { PLANS, TOPUP, type PlanId, type PlanSpec } from "@codecast/shared/contracts/assistant";
import { classifyUserMessage, isHiddenStubMessage, stripSystemTags } from "../conversation/classify";
import { cadenceLabel } from "../org/staffingModel";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import { ARMED_STATUSES, isTriggerFailing, lastRunHeadline, type TaskRow } from "../triggerTasks";
import type { GoogleCapabilities } from "@codecast/convex/convex/googleOAuth";
import type { WalletAccountLine } from "@codecast/convex/convex/lib/wallet";
import { sessionLiveAt } from "../../lib/liveness";
import { LANE_HOME } from "./lanePref";

/** Where each surface of the lane lives. */
export const LANE_PATHS = {
  home: LANE_HOME.simple,
  approvals: "/simple/approvals",
  routines: "/simple/routines",
  connections: "/simple/connections",
  plan: "/simple/plan",
  welcome: "/welcome",
} as const;

export function conversationPath(id: string): string {
  return `/simple/c/${id}`;
}

export { laneOf, type Lane } from "./lanePref";

// ── Conversations ──────────────────────────────────────────────────────────

/** A conversation the lane lists: hosted, and not thrown away. */
export function isLaneConversation(row: Pick<InboxSession, "agent_type"> & { inbox_killed_at?: number | null }): boolean {
  return isHostedAgentType(row.agent_type) && !row.inbox_killed_at;
}

const PLACEHOLDER_TITLES = new Set(["new session", "new conversation", "untitled", ""]);

/** What a conversation is called: its title once it has a real one, else
 *  what the person asked, else a plain fallback. */
export function conversationTitle(row: { title?: string | null; short_title?: string | null; last_user_message?: string | null } | null | undefined): string {
  const title = (row?.short_title || row?.title || "").trim();
  if (title && !PLACEHOLDER_TITLES.has(title.toLowerCase())) return title;
  const ask = (row?.last_user_message ?? "").trim().replace(/\s+/g, " ");
  if (ask) return ask.length > 64 ? `${ask.slice(0, 61).trimEnd()}...` : ask;
  return "A new conversation";
}

/** The live states the lane distinguishes. `working` covers queued input the
 *  assistant has not picked up yet: from the person's side it is already on it. */
export type ConversationState = "waiting" | "working" | "done";

/** A row as the lane's state rule reads it: the shared live facts
 *  (lib/liveness) plus the two arms that mean the person is up. */
export type LaneStateRow = Parameters<typeof sessionLiveAt>[0] & Pick<InboxSession, "has_pending" | "awaiting_input">;

/** Where a conversation stands at `now`. Working is the app's one liveness
 *  rule (sessionLiveAt), so a turn whose status froze at "working" settles
 *  here exactly when it settles in the inbox. */
export function conversationState(row: LaneStateRow, openApprovals: number, now: number): ConversationState {
  if (openApprovals > 0 || row.awaiting_input) return "waiting";
  if (row.has_pending || sessionLiveAt(row, now)) return "working";
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
export function homeBands<S extends LaneStateRow & Pick<InboxSession, "_id">>(
  rows: S[],
  approvalsByConversation: Map<string, number>,
  now: number,
): HomeBands<S> {
  const bands: HomeBands<S> = { waiting: [], working: [], done: [] };
  for (const row of rows) bands[conversationState(row, approvalsByConversation.get(row._id) ?? 0, now)].push(row);
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

/** Whether a card can take the answer with one tap. A pick-several, a
 *  ranking or a form needs more than a button, so the card sends the person
 *  into the conversation to answer there. */
export function answersInline(d: Pick<SessionDecisionItem, "kind" | "options">): boolean {
  return (d.kind ?? "single") === "single" && d.options.length > 0;
}

/** What a card is asking for. A one-pick card with a way to say no is a
 *  request for permission ("Send this reply to Dana?"); any other card asks
 *  the person to choose, and its label says so. */
export function approvalAsk(d: Pick<SessionDecisionItem, "kind" | "options">): "permission" | "choice" {
  const permission = answersInline(d) && d.options.some((o, i) => answerTone(o.label, i) === "no");
  return permission ? "permission" : "choice";
}

export const APPROVAL_LABEL = { permission: "Needs your OK", choice: "Needs your answer" } as const;

/** The plain notes under a card's answers: each answer that explains itself
 *  ("Always allow" saying what it allows from now on), shown in full because
 *  a phone never shows a tooltip. */
export function answerNotes(options: Array<{ label: string; description?: string }>): Array<{ label: string; note: string }> {
  return options.flatMap((o) => (o.description?.trim() ? [{ label: o.label, note: o.description.trim() }] : []));
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

const SPAN_WORDS: Record<string, [string, string]> = { d: ["day", "days"], w: ["week", "weeks"], m: ["month", "months"], y: ["year", "years"] };

/** A mail search in plain words. The query is Gmail's search syntax, which
 *  means nothing to this reader: "from:dana is:unread newer_than:7d" reads as
 *  unread emails " from Dana from the past week". Plain words stay as what was
 *  searched for; operators with no plain reading are left out. */
export function mailSearch(raw: unknown): { unread: boolean; scope: string } {
  if (typeof raw !== "string" || !raw.trim()) return { unread: false, scope: "" };
  const from: string[] = [];
  const about: string[] = [];
  const words: string[] = [];
  let unread = false;
  let since = "";
  for (const tok of raw.match(/-?[a-z_]+:"[^"]*"|"[^"]*"|\S+/gi) ?? []) {
    const op = tok.match(/^(-?)([a-z_]+):(.*)$/i);
    if (!op) {
      if (!/^(OR|AND)$/.test(tok)) words.push(tok.replace(/"/g, ""));
      continue;
    }
    if (op[1]) continue;
    const key = op[2].toLowerCase();
    const value = op[3].replace(/^"|"$/g, "").replace(/^[({]|[)}]$/g, "");
    if (!value) continue;
    if (key === "from") {
      const name = personName(value) ?? value;
      from.push(/[A-Z]/.test(name) ? name : name.replace(/\b\w/g, (c) => c.toUpperCase()));
    } else if (key === "subject") about.push(value);
    else if (key === "is" && value.toLowerCase() === "unread") unread = true;
    else if (key === "newer_than") {
      const span = value.match(/^(\d+)([dwmy])$/i);
      if (span) {
        const n = Number(span[1]);
        const [one, many] = SPAN_WORDS[span[2].toLowerCase()];
        since = n === 1 ? ` from the past ${one}` : n === 7 && one === "day" ? " from the past week" : ` from the past ${n} ${many}`;
      }
    }
  }
  const q = quoted(words.join(" "));
  const subject = quoted(about.join(" "));
  const scope = `${from.length ? ` from ${from.join(" or ")}` : ""}${subject ? ` about ${subject}` : ""}${q ? ` matching ${q}` : ""}${since}`;
  return { unread, scope };
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
    const { unread, scope } = mailSearch(i.query ?? i.q);
    if (n !== null) return `Read ${n} ${unread ? "unread " : ""}${n === 1 ? "email" : "emails"}${scope}`;
    return scope || unread ? `Looked for ${unread ? "unread " : ""}emails${scope}` : "Looked through your email";
  }],
  [/^(archive|label)$|(label|archive|file|move|mark).*(mail|email|thread)/i, () => "Tidied your inbox"],
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
  [/(list|read|get|check).*(task|todo|to_do)/i, () => "Checked your to-dos"],
  [/(update|change|edit|complete).*(task|todo|to_do)/i, () => "Updated a to-do"],
  [/(create|write|add).*(doc|note|page)/i, (i) => {
    const t = quoted(i.title);
    return t ? `Wrote a note: ${t}` : "Wrote a note";
  }],
  [/(create|add|set|schedule).*(routine|trigger|reminder)/i, (i) => {
    const t = quoted(i.title);
    return t ? `Set up a routine: ${t}` : "Set up a routine";
  }],
  [/(list|read|get|check).*(routine|trigger|reminder)/i, () => "Checked your routines"],
  [/(cancel|stop|delete|remove).*(routine|trigger|reminder)/i, () => "Stopped a routine"],
  [/(read|get|open).*(doc|note)/i, () => "Read a note"],
  [/(replace|update|edit).*(doc|note)/i, () => "Updated a note"],
  [/^remember$/i, () => "Made a note to remember"],
  [/^recall$/i, () => "Remembered what you told me"],
  [/lookup/i, () => "Looked something up"],
  // Whole words only: "ask" inside "tasks" is not a question to the person.
  [/(^|_)(ask|approval|decide)(_|$)/i, () => "Asked for your go-ahead"],
];

/** One tool call as one plain line. */
export function stepText(call: ToolCallLike, result?: ToolResultLike): string {
  const own = (result?.summary ?? call.summary)?.trim();
  if (own) return own;
  const name = call.name ?? "";
  const input = parsedInput(call.input);
  for (const [pattern, phrase] of PHRASES) if (pattern.test(name)) return phrase(input, result);
  // A tool's own name is jargon; one nobody has phrased yet stays neutral.
  return "Did a step";
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

/** A message of the person's still on its way. A failed send is not: it
 *  waits on the person (Try again), so nothing may look busy on its account. */
export function isUnsent(m: Pick<LaneMessage, "_isOptimistic" | "_isQueued" | "_isFailed">): boolean {
  return !m._isFailed && !!(m._isOptimistic || m._isQueued);
}

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
        if (text) items.push({ kind: "you", id: m._id, text, pending: isUnsent(m), failed: !!m._isFailed, at: m.timestamp });
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

// ── Routines ───────────────────────────────────────────────────────────────

/** A routine the lane lists: armed or paused, bound to one of its conversations. */
export function isLaneRoutine(t: Pick<TaskRow, "status" | "originating_conversation_id">, laneIds: Set<string>): boolean {
  return ARMED_STATUSES.has(t.status) && !!t.originating_conversation_id && laneIds.has(String(t.originating_conversation_id));
}

/** How a routine's last run reads. A run that broke or wants the person
 *  says so in a warm line of its own; only a run that went well shows its
 *  result. */
export function routineLastRun(
  t: Pick<TaskRow, "last_run_at" | "last_run_summary" | "last_run_failed" | "last_run_needs_attention">,
  now: number,
): { trouble: boolean; text: string } | null {
  if (!t.last_run_at) return null;
  const when = whenSaid(t.last_run_at, now);
  if (isTriggerFailing(t)) return { trouble: true, text: `Didn't finish ${when}. Open it to see why.` };
  if (t.last_run_needs_attention) return { trouble: true, text: `Ran ${when} and has something for you. Open it to see.` };
  const result = lastRunHeadline(t);
  return result ? { trouble: false, text: `Last ran ${when}: ${result}` } : null;
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
  if (days === -1) return `yesterday at ${clock(at)}`;
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
  return t.schedule_type === "recurring" ? `Runs ${cadence}. Next: ${next}` : `Runs once, ${next}`;
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
  return `${dollars(plan.price_usd).replace(/\.00$/, "")} a month`;
}

/** The plans above `current`, cheapest first: what an upgrade can move to. */
export function upgradesFrom(current: PlanId): PlanSpec[] {
  const order = Object.values(PLANS).sort((a, b) => a.price_usd - b.price_usd);
  const at = order.findIndex((p) => p.id === current);
  return order.slice(at + 1);
}

/** The top-up amounts the plan screen offers, in US dollars (the catalog's). */
export const TOPUP_AMOUNTS_USD = TOPUP.amounts_usd;

/** One line of the plan screen's history (WalletSummary.account) in plain
 *  words, with its amount signed the way it moved extra credit. Every amount
 *  arrives positive; the kind says which way it went. A new month moves no
 *  credit, so what it forgave is a `detail`, not an amount. A refund that took
 *  nothing back says nothing, so it is left out (null). */
export function accountLine(line: Pick<WalletAccountLine, "kind" | "amount_usd">): { text: string; amount: string | null; detail?: string } | null {
  const usd = Math.max(0, line.amount_usd);
  switch (line.kind) {
    case "topup":
      return { text: "Extra credit you bought", amount: `+${dollars(usd)}` };
    case "grant":
      return { text: "Extra credit from us", amount: `+${dollars(usd)}` };
    case "period_reset":
      return { text: "A new month started", amount: null, ...(usd > 0 ? { detail: `${dollars(usd)} used the month before` } : {}) };
    case "refund":
      return usd > 0 ? { text: "Refunded extra credit taken back", amount: `-${dollars(usd)}` } : null;
    case "repay":
      return { text: "Paid back what was owed", amount: dollars(usd) };
  }
}

/** What Stripe's return to the plan screen means (convex/billing.ts returnUrl). */
export function billingReturnNote(param: string | null): string | null {
  if (param === "done") return "Your plan is updated. Thank you.";
  if (param === "topup") return "Your extra credit is on its way. It shows here in a moment.";
  if (param === "canceled") return "Checkout was canceled, so nothing changed.";
  return null;
}

// ── Greeting ───────────────────────────────────────────────────────────────

export function greeting(now: number, name?: string | null): string {
  const h = new Date(now).getHours();
  const part = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

// ── First asks ─────────────────────────────────────────────────────────────

/** The asks the lane suggests, worded once for home and /welcome. */
export const ASKS = {
  week: "Look through my email and calendar and tell me what needs me this week",
  replies: "What needs a reply from me this week?",
  overnight: "Every weekday at 8, tell me what came in overnight that matters",
  calendarWeek: "What's on my calendar this week, and when am I free?",
  lunch: "Find a time for lunch with Sam next week",
  morning: "Every weekday at 8, tell me what's on today",
  planWeek: "Help me plan my week. Ask me what's on my plate first.",
  sayNo: "Help me write a kind note saying no to an invitation",
  compare: "Compare the three best rated robot vacuums for a small apartment",
  mondays: "Every Monday at 9, remind me to plan the week",
} as const;

/** What to suggest first, from what the person has connected: with mail, the
 *  one ask that shows what the assistant is for (what needs them this week)
 *  and two more; without, a short set that needs nothing connected. */
export function firstAsks(can: GoogleAbilities | null | undefined): { lead: string | null; more: string[] } {
  const mail = !!can?.read_mail;
  const calendar = !!can?.calendar;
  if (mail && calendar) return { lead: ASKS.week, more: [ASKS.lunch, ASKS.morning] };
  if (mail) return { lead: ASKS.replies, more: [ASKS.overnight, ASKS.sayNo] };
  if (calendar) return { lead: ASKS.calendarWeek, more: [ASKS.lunch, ASKS.planWeek] };
  return { lead: null, more: [ASKS.planWeek, ASKS.sayNo, ASKS.compare, ASKS.mondays] };
}

// ── Connections ────────────────────────────────────────────────────────────

/** A connect or disconnect refusal in plain words. The server names env
 *  variables when Google is not set up, which means nothing to this reader. */
export function plainConnectError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/not configured|GOOGLE_OAUTH/i.test(message)) return "Connecting Google isn't switched on here yet.";
  return message;
}

/** What the person's Google grant lets the assistant do (googleOAuth.listConnections `can`). */
export type GoogleAbilities = GoogleCapabilities;

/** Whether the lane should offer to ask Google for more: the assistant's
 *  mail tools read, sort, label, draft and send, and it uses the calendar. */
export function missingAbilities(can: GoogleAbilities | null | undefined): boolean {
  return !can || !can.read_mail || !can.modify_mail || !can.send_mail || !can.calendar;
}
