// Hosted mode's rules and words (plan pl-840,
// docs/architecture/hosted-assistant.md): which conversations are the
// assistant's and where one stands, what an approval card asks, and how a
// routine and the month's usage are said out loud. Pure: the screens read
// the store through hooks (useLane.ts) and hand the rows here, so every rule
// is testable without a browser.
//
// Every word this file returns is shown to someone who has never used a
// developer tool: no agent, session, model, token, repo or device.

import { ACTIVE_AGENT_STATUSES, isHostedAgentType } from "@codecast/shared/contracts";
import { APPROVAL_ANSWERS, PLANS, PLAN_CATALOG, TOPUP, TYPICAL_REQUEST_USD, routineFloor, topupCredit, type BillingReturnOutcome, type PlanId, type PlanSpec } from "@codecast/shared/contracts/assistant";
import { cadenceLabel } from "../org/staffingModel";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import { isTriggerFailing, lastRunHeadline, type TaskRow } from "../triggerTasks";
import type { MailAbilities } from "@codecast/convex/convex/lib/whisk";
import type { WalletAccountLine, WalletSummary } from "@codecast/convex/convex/lib/wallet";
import { sessionLiveAt } from "../../lib/liveness";
import { describeConnectorError } from "../../lib/connectorReturn";

import { LANE_CONVERSATION_ROUTE, LANE_PATHS, conversationPath } from "./lanePaths";
import { askFirstFor } from "./askFirst";

export { LANE_CONVERSATION_ROUTE, LANE_PATHS, conversationPath };

/** The lane's sections in tab order, named the same on the web and the
 *  phone; each platform adds only its icons. */
export const LANE_SECTIONS = [
  { key: "home", path: LANE_PATHS.home, label: "Home" },
  { key: "approvals", path: LANE_PATHS.approvals, label: "Approvals" },
  { key: "routines", path: LANE_PATHS.routines, label: "Routines" },
  { key: "connections", path: LANE_PATHS.connections, label: "Connections" },
  { key: "plan", path: LANE_PATHS.plan, label: "Plan" },
] as const;

export type LaneSectionKey = (typeof LANE_SECTIONS)[number]["key"];

/** What a lane page is called in the window's title: its section's label, or
 *  "Welcome" on /welcome. A conversation sits under Home, the section it is
 *  opened from. */
export function laneSurfaceLabel(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === LANE_PATHS.welcome) return "Welcome";
  return LANE_SECTIONS.find((s) => s.path === path)?.label ?? LANE_SECTIONS[0].label;
}

export { laneOf, type Lane } from "./lanePref";

// ── Conversations ──────────────────────────────────────────────────────────

/** A conversation the lane lists: hosted, and not thrown away. */
export function isLaneConversation(row: Pick<InboxSession, "agent_type"> & { inbox_killed_at?: number | null }): boolean {
  return isHostedAgentType(row.agent_type) && !row.inbox_killed_at;
}

const PLACEHOLDER_TITLES = new Set(["new session", "new conversation", "untitled", ""]);

type TitleRow = { title?: string | null; short_title?: string | null; last_user_message?: string | null } | null | undefined;

function ownTitle(row: TitleRow): string {
  const title = (row?.short_title || row?.title || "").trim();
  return title && !PLACEHOLDER_TITLES.has(title.toLowerCase()) ? title : "";
}

/** What a conversation is called: its title once it has a real one, else
 *  what the person asked, else a plain fallback. */
export function conversationTitle(row: TitleRow): string {
  const title = ownTitle(row);
  if (title) return title;
  const ask = (row?.last_user_message ?? "").trim().replace(/\s+/g, " ");
  if (ask) return ask.length > 64 ? `${ask.slice(0, 61).trimEnd()}...` : ask;
  return "A new conversation";
}

/** Whether the title is the person's own ask, standing in until a real one
 *  is written. A row whose title is the ask does not repeat the ask as its
 *  second line. */
export function titleIsAsk(row: TitleRow): boolean {
  return !ownTitle(row) && !!(row?.last_user_message ?? "").trim();
}

/** The live states the lane distinguishes. `working` covers queued input the
 *  assistant has not picked up yet: from the person's side it is already on it. */
export type ConversationState = "waiting" | "working" | "done";

/** A row as the lane's state rule reads it: the shared live facts
 *  (lib/liveness) plus the two arms that mean the person is up. */
export type LaneStateRow = Parameters<typeof sessionLiveAt>[0] & Pick<InboxSession, "has_pending" | "awaiting_input">;

/** Where a conversation stands at `now`. Working is the app's one liveness
 *  rule (sessionLiveAt), so a turn whose status froze at "working" settles
 *  here exactly when it settles in the inbox. A hosted turn's status is
 *  written by the turn itself, never read off a terminal, so once it says
 *  the turn ended and the assistant spoke last, the conversation is done at
 *  once: the idle grace that steadies a daemon's status would keep "On it"
 *  showing under a finished answer. */
export function conversationState(row: LaneStateRow, openApprovals: number, now: number): ConversationState {
  if (openApprovals > 0 || row.awaiting_input) return "waiting";
  if (row.has_pending) return "working";
  const status = row.agent_status_raw ?? row.agent_status;
  if (status && !ACTIVE_AGENT_STATUSES.has(status) && !row.last_role_is_user) return "done";
  return sessionLiveAt(row, now) ? "working" : "done";
}

const STATE_WORDS: Record<ConversationState, string> = {
  waiting: "Waiting on you",
  working: "Working on it",
  done: "",
};

/** A conversation row's second line: where it stands while it is live, else
 *  what came of it, else what the person asked (unless the title is already
 *  that ask). A row waiting on an answer says what it asks (`asked`, the open
 *  question) rather than a state word, so it never reads like the name of
 *  another inbox section. */
export function conversationSubline(
  row: { title?: string | null; short_title?: string | null; idle_summary?: string | null; last_user_message?: string | null },
  state: ConversationState,
  asked?: string | null,
): string {
  if (state === "waiting" && asked?.trim()) return asked.trim();
  return STATE_WORDS[state] || row.idle_summary || (titleIsAsk(row) ? "" : row.last_user_message) || "";
}

// ── Approvals ──────────────────────────────────────────────────────────────

/** An open approval: a pending decision on one of the lane's conversations. */
export function isOpenApproval(d: Pick<SessionDecisionItem, "status" | "conversation_id">, laneIds: Set<string>): boolean {
  return d.status === "pending" && laneIds.has(String(d.conversation_id));
}

export function oldestFirst<T extends { created_at: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.created_at - b.created_at);
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

/** The plain notes under a card's answers, shown in full because a phone
 *  never shows a tooltip: each answer whose meaning is not its label ("Always
 *  allow" saying what it allows from now on). On a request for permission
 *  the yes and the no say themselves, so only the answers between them keep
 *  a note; on a choice every described answer does. */
export function answerNotes(options: Array<{ label: string; description?: string }>): Array<{ label: string; note: string }> {
  const tones = options.map((o, i) => answerTone(o.label, i));
  const permission = tones.includes("no");
  return options.flatMap((o, i) => (o.description?.trim() && !(permission && tones[i] !== "plain") ? [{ label: o.label, note: o.description.trim() }] : []));
}

/** How each answer button looks: the first is the yes, a refusal is quiet. */
export function answerTone(label: string, index: number): "yes" | "plain" | "no" {
  if (/^(decline|no\b|don'?t|cancel|skip|not now|reject)/i.test(label.trim())) return "no";
  return index === 0 ? "yes" : "plain";
}

/** The quiet note where an approval card was, once the person answered it,
 *  or null when the transcript already says the answer. A decline reads in
 *  the step it declined ("Didn't set up a routine (you said no)"), so its
 *  note would say the same thing twice. The rule reads the answer alone and
 *  never the step's result, which lands a moment after the answer does. */
export function answerNote(answer: string | null | undefined): string | null {
  const said = answer?.trim();
  if (!said || said === APPROVAL_ANSWERS.decline) return null;
  return LANE_COPY.transcript.answered(said);
}

/** Whether a card's draft is long enough to fold behind "Show all of it". */
export function draftIsLong(draft: string): boolean {
  return draft.length > 420 || draft.split("\n").length > 9;
}

// ── Tool steps ─────────────────────────────────────────────────────────────

// Each call said as one plain line, and the fold rule, live in the platform
// core (@platform/assistant/steps), shared with the main transcript's
// receipts for hosted conversations.
export { mailSearch, personName, stepOutcome, stepText, visibleSteps, STEPS_SHOWN, type StepOutcome, type ToolCallLike, type ToolResultLike } from "@platform/assistant/steps";

// ── Routines ───────────────────────────────────────────────────────────────

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

// ── Usage and plans ────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

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

/** Money the person pays: plan prices and the top-up buttons. Never the
 *  work itself, which is measured in monthShare. */
export function dollars(usd: number): string {
  const v = Math.max(0, usd);
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

const QUARTERS: Record<number, string> = { 0.25: "a quarter of a month", 0.5: "half a month", 0.75: "three quarters of a month" };

/** A share of the month as a percent, the one rounding every percent on the
 *  plan screen and the sidebar uses: "under 1%" for any work too small to
 *  round to 1%, and never "100%" for a month that is not used up. */
export function monthPercent(r: number): string {
  if (r <= 0) return "0%";
  if (r < 0.01) return "under 1%";
  return `${r < 1 ? Math.min(99, Math.round(r * 100)) : Math.round(r * 100)}%`;
}

/** Work said the way the person reads it: a share of a month on their plan
 *  ("4% of a month", "half a month", "3 months"). The wallet keeps work in
 *  dollars at cost, and a second dollar figure next to a price reads as money
 *  that vanished, so every amount of work on screen goes through here, always
 *  against the plan's full month (usePlanMeter's `month`), never the period's
 *  prorated cap. Whole months round down, so a figure never promises more
 *  than it buys. */
export function monthShare(usd: number, month: number): string {
  if (month <= 0 || usd <= 0) return "nothing";
  const r = usd / month;
  if (r < 0.95) {
    const quarter = Math.round(r * 4) / 4;
    return Math.abs(r - quarter) < 0.03 && QUARTERS[quarter] ? QUARTERS[quarter] : `${monthPercent(r)} of a month`;
  }
  const months = Math.max(1, Math.floor(r * 2) / 2);
  return months === 1 ? "a month" : `${months} months`;
}

/** An amount of work as a phrase that reads inside a sentence: "about half a
 *  month on Plus", or "under 1% of a month on Plus", which takes no "about".
 *  `planLabel` names the plan whose month it is measured in, when the
 *  sentence does not already. */
export function aboutShare(usd: number, month: number, planLabel?: string): string {
  const share = monthShare(usd, month);
  const on = planLabel ? ` on ${planLabel}` : "";
  return share.startsWith("under ") || share === "nothing" ? `${share}${on}` : `about ${share}${on}`;
}

function capitalized(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

/** The meter's headline: how much of the month is left, in words. */
export function usageHeadline(w: MeterFigures): string {
  const { used } = meterFill(w);
  if (w.used_usd >= w.cap_usd && w.topup_usd <= 0) return "You've used all of this month's allowance";
  if (w.used_usd >= w.cap_usd) return "This month's allowance is used up, so your extra credit is in use";
  if (used >= 0.8) return "Most of this month's allowance is used";
  if (used === 0) return "Nothing used yet this month";
  return `${capitalized(monthPercent(used))} of this month's allowance used`;
}

/** The meter in a few words, for the sidebar: "25% used this month". */
export function meterShort(w: MeterFigures): string {
  const { used } = meterFill(w);
  if (used >= 1) return "All used this month";
  if (w.used_usd <= 0) return "Nothing used this month";
  return `${capitalized(monthPercent(used))} used this month`;
}

/** The lines under the meter (the headline already says how much is used),
 *  each with the figure it leads with (shown strong) and the words after it.
 *  Amounts of work are shares of the plan's `month` (usePlanMeter). `resets`
 *  is the day the month starts fresh. */
export function meterLegend(w: MeterFigures, resets: string | null, month: number): Array<{ key: string; strong: string | null; rest: string }> {
  const lines: Array<{ key: string; strong: string | null; rest: string }> = [];
  if (w.reserved_usd > 0) lines.push({ key: "held", strong: null, rest: "Some is set aside for work still running" });
  if (w.topup_usd > 0) lines.push({ key: "extra", strong: null, rest: `Extra credit for ${aboutShare(w.topup_usd, month)} more` });
  if (w.topup_usd < 0) lines.push({ key: "owed", strong: null, rest: `Refunded extra credit you'd already used (${aboutShare(-w.topup_usd, month)}) comes out of next month first` });
  if (resets) lines.push({ key: "resets", strong: null, rest: `Starts fresh ${resets}` });
  return lines;
}

/** A count said roughly, rounded down to its leading digit (625 reads "600"),
 *  so a measured estimate never reads more precise than it is. */
function roughly(n: number): number {
  if (n < 10) return Math.max(1, Math.floor(n));
  const step = 10 ** Math.floor(Math.log10(n));
  return Math.floor(n / step) * step;
}

/** How much work a plan includes. The Free month is sized in everyday
 *  requests (TYPICAL_REQUEST_USD, measured), and each paid plan as a multiple
 *  of it, never as a dollar figure beside its price. */
function allowancePoint(plan: PlanSpec): string {
  const base = PLANS[PLAN_CATALOG.free];
  if (plan.included_usd <= base.included_usd || base.included_usd <= 0) {
    return `Room for about ${roughly(plan.included_usd / TYPICAL_REQUEST_USD)} everyday requests a month`;
  }
  return `${Math.round(plan.included_usd / base.included_usd)} times the ${base.label} allowance each month`;
}

/** What each plan gives, in plain words. Every number comes from PLANS. */
export function planPoints(plan: PlanSpec): string[] {
  const { max } = plan.routines;
  const routines = `${max === null ? "Unlimited routines" : plural(max, "routine")}, ${cadenceLabel(routineFloor(plan)).replace(/^every /, "at most every ")}`;
  const together = plan.concurrent_turns === 1 ? "One thing at a time" : `${plan.concurrent_turns} things at once`;
  const thinking = plan.strong_model !== plan.default_model ? "Deeper thinking for hard problems" : null;
  return [allowancePoint(plan), routines, together, ...(thinking ? [thinking] : [])];
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

/** A top-up button's two lines: "Add $10" and what it buys on the person's
 *  plan ("About half a month on Plus"). */
export function topupLabel(usd: number, plan: PlanSpec): { label: string; note: string } {
  const label = `Add ${dollars(usd).replace(/\.00$/, "")}`;
  if (plan.included_usd <= 0) return { label, note: "Extra credit" };
  return { label, note: capitalized(aboutShare(topupCredit(usd), plan.included_usd, plan.label)) };
}

/** "Where it went" in the order that matters: the costliest conversations
 *  first, and every line under 1% of the plan's `month` folded into one
 *  count, so the ledger never lists conversations that used nothing visible. */
export function ledgerLines<L extends { cost_usd: number }>(lines: L[], month: number): { shown: L[]; small: number } {
  const shown = lines.filter((l) => month > 0 && l.cost_usd / month >= 0.01).sort((a, b) => b.cost_usd - a.cost_usd);
  return { shown, small: lines.length - shown.length };
}

/** "Where it went": how many times the assistant worked on a conversation. */
export function workedTimes(turns: number): string {
  return turns === 1 ? "Worked on it once" : `Worked on it ${turns} times`;
}

/** How one plan's card reads: whether it is the person's plan, and what its
 *  upgrade control is (a card checkout, an ask by email, or none). Until the
 *  first wallet read the plan is a guess, so there is no pill and no offer;
 *  offers also wait for billing, so a card button never turns into an ask. */
export function planCard(
  id: PlanId,
  figures: { known: boolean; plan: { id: PlanId }; upgrades: Set<PlanId> },
  billing: { known: boolean; plans: readonly PlanId[] },
): { current: boolean; offer: "checkout" | "ask" | null } {
  const current = figures.known && id === figures.plan.id;
  if (!figures.known || !billing.known || !figures.upgrades.has(id)) return { current, offer: null };
  return { current, offer: billing.plans.includes(id) ? "checkout" : "ask" };
}

/** One line of the plan screen's history (WalletSummary.account) as a plain
 *  sentence: what happened, and how much work it moved as a share of a month
 *  on `plan`. The ledger does not record the plan a line was bought under, so
 *  the sentence names the plan it is measured in. A new month moves no
 *  credit, so what it used is a `detail`. A refund that took nothing back says
 *  nothing, so it is left out (null). */
export function accountLine(line: Pick<WalletAccountLine, "kind" | "amount_usd">, plan: Pick<PlanSpec, "label" | "included_usd">): { text: string; detail?: string } | null {
  const usd = Math.max(0, line.amount_usd);
  const month = plan.included_usd;
  const share = aboutShare(usd, month, plan.label);
  switch (line.kind) {
    case "topup":
      return { text: `Extra credit you bought: ${share}` };
    case "grant":
      return { text: `Extra credit from us: ${share}` };
    case "period_reset":
      return { text: "A new month started", ...(usd > 0 && month > 0 ? { detail: `${monthPercent(usd / month)} of the month before used` } : {}) };
    case "refund":
      return usd > 0 ? { text: `Refunded extra credit taken back: ${share}` } : null;
    case "repay":
      return { text: `Paid back what was owed: ${share}` };
  }
}

/** How long before the person came back a top-up credit may have landed and
 *  still be theirs from this checkout: Stripe's webhook can beat the redirect. */
const TOPUP_RETURN_SLACK_MS = 10 * 60_000;

/** Whether what the person paid for on Stripe has reached the wallet. The
 *  person comes back before Stripe's webhook lands, so a plan is settled once
 *  the wallet holds a paid subscription, and a top-up once its credit is on
 *  the account. A canceled checkout has nothing to wait for. */
export function billingReturnSettled(
  outcome: BillingReturnOutcome,
  wallet: Pick<WalletSummary, "subscription_status" | "account"> | null,
  returnedAt: number,
): boolean {
  if (outcome === "canceled") return true;
  if (!wallet) return false;
  if (outcome === "done") return wallet.subscription_status === "active" || wallet.subscription_status === "trialing";
  return wallet.account.some((line) => line.kind === "topup" && line.at >= returnedAt - TOPUP_RETURN_SLACK_MS);
}

/** How long the plan screen waits for Stripe's webhook before it says the
 *  payment has not reached the account. The webhook usually lands within
 *  seconds; past this something is wrong (Stripe down, the webhook refused). */
export const BILLING_RETURN_PATIENCE_MS = 5 * 60_000;

/** A sentence that asks the person to write to support: `before`, then
 *  `link` as a mail to support with `subject` filled in, then `after`. */
export type SupportWords = { before?: string; link: string; after: string; subject: string };

export type BillingReturnNote = {
  text: string;
  tone: "done" | "pending" | "late" | "plain";
  /** A mail to support, offered when the payment is late; `text` leads into it. */
  support?: SupportWords;
};

/** What the plan screen says after Stripe sends the person back
 *  (BILLING_RETURN): thanks once the payment is on the wallet, a word that it
 *  is coming until then, a way to reach support once it has taken longer
 *  than BILLING_RETURN_PATIENCE_MS, and a plain note for a canceled checkout. */
export function billingReturnNote(outcome: BillingReturnOutcome | null, settled: boolean, late = false): BillingReturnNote | null {
  if (outcome === "canceled") return { text: "Checkout was canceled, so nothing changed.", tone: "plain" };
  if (outcome !== "done" && outcome !== "topup") return null;
  const what = outcome === "done" ? "new plan" : "extra credit";
  if (settled) return { text: outcome === "done" ? "Your plan is updated. Thank you." : "Your extra credit is here. Thank you.", tone: "done" };
  if (late) {
    return {
      text: `Your ${what} hasn't reached your account yet. If Stripe charged you, `,
      tone: "late",
      support: { subject: `My ${what} hasn't shown up`, link: "write to us", after: " and we'll sort it out." },
    };
  }
  return { text: `Thank you. Your ${what} shows here as soon as Stripe confirms the payment.`, tone: "pending" };
}

// ── Greeting ───────────────────────────────────────────────────────────────

// ── First asks ─────────────────────────────────────────────────────────────

/** The asks the lane suggests, worded once for home and /welcome. */
export const ASKS = {
  week: "Look through my email and calendar and tell me what needs me this week",
  replies: "What needs a reply from me this week?",
  overnight: "Every weekday at 8, tell me what came in overnight that matters",
  calendarWeek: "What's on my calendar this week, and when am I free?",
  focus: "Find a free hour for me to focus this week",
  morning: "Every weekday at 8, tell me what's on today",
  planWeek: "Help me plan my week. Ask me what's on my plate first.",
  sayNo: "Help me write a kind note saying no to an invitation",
  compare: "Compare the three best rated robot vacuums for a small apartment",
  mondays: "Every Monday at 9, remind me to plan the week",
} as const;

/** What to suggest first, from what the person has connected: with mail, the
 *  one ask that shows what the assistant is for (what needs them this week)
 *  and two more; without, a short set that needs nothing connected. Each
 *  works exactly as tapped, so none names a person or thing the asker may not
 *  have. */
export function firstAsks(can: MailAbilities | null | undefined): { lead: string | null; more: string[] } {
  const mail = !!can?.read_mail;
  const calendar = !!can?.calendar;
  if (mail && calendar) return { lead: ASKS.week, more: [ASKS.focus, ASKS.morning] };
  if (mail) return { lead: ASKS.replies, more: [ASKS.overnight, ASKS.sayNo] };
  if (calendar) return { lead: ASKS.calendarWeek, more: [ASKS.focus, ASKS.planWeek] };
  return { lead: null, more: [ASKS.planWeek, ASKS.sayNo, ASKS.compare, ASKS.mondays] };
}

// ── Connections ────────────────────────────────────────────────────────────

/** A connect or disconnect refusal in plain words, through the connectors'
 *  one reason table (shared/contracts/connectorReasons.ts). The lane adds only the
 *  not-configured case: the server names env variables there, which the
 *  settings page wants and this reader does not. */
export function plainConnectError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/not configured|GOOGLE_OAUTH/i.test(message)) return describeConnectorError("whisk_not_configured");
  return describeConnectorError(message);
}

/** What the person's mail and calendar connection lets the assistant do
 *  (convex/whisk.ts `connection`'s `can`, the same rule the tools read). */
export type { MailAbilities };

/** Whether the lane should offer to connect again for more: the assistant's
 *  mail tools read, sort, label, draft and send, and it uses the calendar. */
export function missingAbilities(can: MailAbilities | null | undefined): boolean {
  return !can || !can.read_mail || !can.modify_mail || !can.send_mail || !can.calendar;
}

/** Which mail and calendar controls the Connections card shows. While the
 *  person is confirming a disconnect, that question is the only thing on the
 *  row, so the offer to allow more steps aside. `canDisconnect` comes from
 *  useLaneMail: there is a connection the server can end. `available` is
 *  whether this deployment can connect mail through Whisk at all
 *  (whisk.connectAvailable); where it cannot, the card says mail is
 *  coming (`coming`, MAIL_COMING) as /welcome does, instead of offering a
 *  Connect that can only fail. Undefined (not answered yet) offers neither. */
export function connectionControls(
  g: { connected: boolean; can: MailAbilities | null | undefined; canDisconnect: boolean; available?: boolean },
  confirming: boolean,
): { connect: boolean; coming: boolean; allow: boolean; confirm: boolean; disconnect: "on" | "off" | null } {
  if (!g.connected) {
    // Connect is offered only once the deployment has said yes; while it has
    // not answered, neither Connect nor the coming line shows.
    return { connect: g.available === true, coming: g.available === false, allow: false, confirm: false, disconnect: null };
  }
  return {
    connect: false,
    coming: false,
    allow: missingAbilities(g.can) && !confirming,
    confirm: confirming,
    disconnect: confirming ? null : g.canDisconnect ? "on" : "off",
  };
}

// ── Words ──────────────────────────────────────────────────────────────────

export { ASK_FIRST, askFirstFor } from "./askFirst";

/** Every fixed line the lane's pages say, once for the web and the phone.
 *  The rules above say what changes with the data; these are the rest. */
export const LANE_COPY = {
  /** Where a person starts with the assistant: an empty inbox in hosted
   *  mode and the new conversation sheet, on the web and the phone. */
  intro: {
    title: "Ask the Codecast assistant",
    lede: (mailConnected: boolean) =>
      mailConnected ? "Research, writing, planning, your mail and calendar. Ask in plain words." : "Research, writing, planning. Ask in plain words.",
  },
  home: {
    lede: (can: MailAbilities | null | undefined) => `Hand me anything on your list. ${askFirstFor(can)}`,
    placeholder: "What can I take off your plate?",
    /** First things to ask: each fills the composer with a request that works sent as is, and the person can edit it first. The mail ones need Whisk connected. */
    starters: (mailConnected: boolean): Array<{ label: string; text: string }> => [
      ...(mailConnected
        ? [
            { label: "Catch me up on mail", text: "Catch me up on what's new in my inbox and what needs a reply." },
            { label: "Plan my week", text: "Look at my calendar and help me plan this week." },
          ]
        : [{ label: "Plan a trip", text: "Help me plan a trip. Start by asking me where and when." }]),
      { label: "Research a question", text: "Research a question for me. Start by asking what I want to know." },
      { label: "Help me write", text: "Help me write something. Start by asking what it is and who it's for." },
    ],
    loading: "Getting your conversations",
    waiting: "Waiting on you",
    happening: "Happening now",
    done: "Done lately",
    seeAll: "See all",
    showMore: (n: number) => `Show ${n} more`,
  },
  conversation: {
    working: "On it",
    reply: "Reply",
    send: "Send",
    change: "Or tell me what to change",
  },
  transcript: {
    /** The note where an approval card was, once the person answered it. */
    answered: (answer: string) => `You said: ${answer}`,
  },
  approval: {
    showAll: "Show all of it",
    showLess: "Show less",
    /** Under the person's answer in a hosted conversation: the way back to
     *  the question it answered. */
    showQuestion: "Show the question",
    showQuestionTip: "Go back to where your assistant asked",
    /** The card's typed answer, in a hosted conversation. */
    typeAnswer: "Answer in your own words; your assistant will read it.",
  },
  routines: {
    title: "Routines",
    lede: "Things I do for you on a schedule. To add one, just ask: \"every weekday at 8, tidy my inbox\".",
    empty: "No routines yet.",
    loading: "Looking for your routines",
    pause: "Pause",
    resume: "Turn back on",
    open: "Open",
    delete: "Delete",
    deleteAsk: "Delete this routine?",
    keep: "Keep it",
  },
  connections: {
    title: "Connections",
    lede: (can: MailAbilities | null | undefined) => `What I can see and do for you. ${askFirstFor(can)}`,
    connected: "Connected",
    notConnected: "Not connected",
    checking: "Checking",
    coming: "Coming soon",
    /** Mail not open yet, said by Settings (the assistant says MAIL_COMING). */
    comingNote: "Email and calendar are on their way.",
    mail: "Mail and calendar",
    through: "Through Whisk",
    on: "On",
    off: "Off",
    browserNote: "Whisk asks in your browser. Approve there, then come back. This page updates by itself.",
    leaving: "Taking you to Whisk. You'll come straight back here.",
    email: "Email",
    calendar: "Calendar",
    connect: "Connect mail and calendar",
    allow: "Connect again to allow everything",
    openWhisk: "Open Whisk",
    disconnect: "Disconnect",
    disconnectAsk: (who: string | null | undefined) => `Disconnect ${who ?? "your mail"}?`,
    keep: "Keep it",
    success: "Your mail and calendar are connected. Try asking me what needs a reply this week.",
    failed: "Your mail didn't connect. Try again.",
    /** Whisk is the family's mail app: one mail, two doors. */
    whiskNote: "Your mail and calendar come in through Whisk, our mail app. Whisk works on its own too, with the same mail.",
  },
  plan: {
    title: "Your plan",
    lede: "Your plan covers the work I do each month: reading, writing, searching and checking in.",
    /** The same, said by Settings rather than by the assistant. */
    settingsLede: "Your plan covers the work your assistant does each month: reading, writing, searching and checking in.",
    checking: "Checking this month's use",
    meterLabel: "Allowance used",
    thisMonth: "This month",
    extraCredit: "Extra credit",
    plans: "Plans",
    yours: "Your plan",
    cardClosed: { before: "Paying by card isn't open yet. To change plans or add credit before then, ", link: "write to us", after: " and we'll do it by hand.", subject: "Change my plan" },
    moveTo: (label: string) => `Move to ${label}`,
    askMove: (label: string) => `Ask us to move you to ${label}`,
    askMoveSubject: (label: string) => `Move me to ${label}`,
    billing: "Billing",
    manage: "Manage billing",
    manageNote: "Your card, receipts, and changing or ending your plan.",
    more: "Need a little more this month?",
    moreNote: "Extra credit is used after your plan's allowance and carries over until it's spent.",
    /** Only while plans can be paid by card and extra credit cannot; when
     *  card payments are closed altogether, cardClosed already says it. */
    topupClosed: { before: "Extra credit can't be bought by card yet. Until then, ", link: "write to us", after: " to add some.", subject: "Add extra credit" },
    where: "Where it went",
    smallLines: (n: number) => `${n} other ${n === 1 ? "conversation" : "conversations"}, each under 1% of a month`,
    history: "History",
  },
} as const;
