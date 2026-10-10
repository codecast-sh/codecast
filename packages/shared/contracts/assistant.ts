// The hosted assistant's shared vocabulary (plan pl-840, build spec
// docs/architecture/hosted-assistant.md). Pure isomorphic data: the Convex
// turn engine, the wallet, the web simple lane and the phone all read the same
// names, and every plan number lives in the one PLANS catalog below so a
// pricing change is one edit here. The shape of a plan and the lookup are
// @platform/assistant's (the storage-free half of the assistant, shared with
// Averil); the values are codecast's product and stay here.
import { planIn, type PlanCatalog, type PlanSpec as PlatformPlanSpec } from "@platform/assistant/plans";
import { CHEAP_MODEL } from "./modelOptions";

/** `conversations.agent_type` of a hosted conversation: a Convex action runs
 *  its turns, and no device ever claims it. The registry entry is
 *  AGENT_CLIENTS.codecast (agentClients.ts). */
export const HOSTED_AGENT_TYPE = "codecast" as const;

/** One run of the loop (`assistant_turns.status`). `queued` waits for the
 *  running turn to pick its input up; `waiting` is parked on an approval. */
export const TURN_STATUSES = ["queued", "running", "waiting", "done", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Why a turn stopped (`assistant_turns.reason`). */
export const TURN_REASONS = ["done", "approval", "budget", "time", "error"] as const;
export type TurnReason = (typeof TURN_REASONS)[number];

/** Why a turn stopped short of an answer, as the transcript shows it. The
 *  engine writes the line as an assistant row (so the model reads it back)
 *  whose `subtype` names the kind, and the web draws a notice with one action
 *  for it: `error` and `unavailable` offer Try again, `budget` opens Plan,
 *  `time` offers Keep going. `unavailable` is a provider outage the engine
 *  retries by itself. `verify` asks for the code mailed to the person's
 *  address before the Free allowance serves them, and the turn picks up by
 *  itself once they enter it. `limit` is a Free turn refused for a reason
 *  that is not the person's month (their address's Free allowance is in use
 *  on another account, or Free turns are paused for the day). */
export const NOTICE_KINDS = ["error", "unavailable", "budget", "time", "safety", "verify", "limit"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
const NOTICE_SUBTYPE_PREFIX = "hosted_notice:";

/** The `subtype` a stop notice's row carries. */
export function noticeSubtype(kind: NoticeKind): string {
  return `${NOTICE_SUBTYPE_PREFIX}${kind}`;
}

/** The notice kind a message row carries, or null for any other row. */
export function noticeKindOf(subtype: string | null | undefined): NoticeKind | null {
  if (!subtype?.startsWith(NOTICE_SUBTYPE_PREFIX)) return null;
  const kind = subtype.slice(NOTICE_SUBTYPE_PREFIX.length) as NoticeKind;
  return (NOTICE_KINDS as readonly string[]).includes(kind) ? kind : null;
}

/** A safety cap on a placeholder title taken from a first message. A title
 *  is the whole first sentence; each surface truncates it to its own width
 *  with CSS, so a wide header shows what a narrow row cuts. */
export const PROMPT_TITLE_MAX_CHARS = 140;

/** A conversation's placeholder title from the person's first message: its
 *  first sentence, spaces collapsed, cut at a word only past
 *  PROMPT_TITLE_MAX_CHARS and with no ellipsis of its own. The server stores
 *  it at start so a conversation whose first turn fails is still named, and
 *  the web shows it before the row syncs. The title pass replaces it like any
 *  generated title. Empty for empty text. */
export function promptTitle(text: string | null | undefined): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  // The first sentence of an ask that has several, without a closing period.
  const flat = (line.replace(/\s+/g, " ").match(/^.+?[.?!](?=\s|$)/)?.[0] ?? line.replace(/\s+/g, " ")).replace(/\.$/, "");
  if (flat.length <= PROMPT_TITLE_MAX_CHARS) return flat;
  const cut = flat.slice(0, PROMPT_TITLE_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > PROMPT_TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "");
}

/** What woke a conversation (`assistant/entry.ts: wake`). `continue` is the
 *  engine waking itself because input arrived while a turn ran. */
export const WAKE_CAUSES = ["message", "routine", "approval", "continue"] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

/** A tool's risk level. Reads always run; writes pass the gate. */
export const TOOL_RISKS = ["read", "write"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

/** What the person has allowed for a write tool (`assistant_rules.decision`).
 *  With no rule the gate asks. */
export const RULE_DECISIONS = ["allow", "ask", "refuse"] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];
export const DEFAULT_RULE_DECISION: RuleDecision = "ask";

/** One wallet movement (`wallet_ledger.kind`). A `refund` takes a top-up's
 *  credit back after Stripe returned or lost the payment (a refund, a dispute);
 *  a `repay` moves allowance onto a debt such a refund left. */
export const LEDGER_KINDS = ["reserve", "release", "charge", "grant", "topup", "period_reset", "refund", "repay"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** How long one turn may run before it ends with reason `time`. */
export const TURN_DEADLINE_MS = 8 * 60 * 1000;

/** The longest message a person may give a hosted conversation, and the
 *  longest title one may start with. Every turn spends the owner's wallet on
 *  its input, so input is bounded where it is queued. */
export const HOSTED_INPUT_MAX_CHARS = 32_000;
export const HOSTED_TITLE_MAX_CHARS = 200;

/** Why an image sent to a hosted conversation is refused: the turn engine
 *  gives the model text only. The server refuses with it where input is
 *  queued, and the composer says it the moment an image is pasted or dropped. */
export const HOSTED_IMAGE_REFUSAL = "The assistant can't read images yet. Describe what's in it, or paste the text.";

export const PLAN_IDS = ["free", "plus", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanSpec = PlatformPlanSpec<PlanId>;

const HAIKU = CHEAP_MODEL;
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The shortest interval any routine repeats at, whatever the plan. Every
 *  firing wakes a paid turn with nobody watching, so a plan's own floor can
 *  raise this but nothing goes under it. */
export const ROUTINE_MIN_INTERVAL_MS = HOUR_MS;

/** Starting values pending the founder's call (spec "Plans"). Nothing else in
 *  the code may hardcode a price, an allowance or a limit. */
export const PLANS: Record<PlanId, PlanSpec> = {
  free: {
    id: "free",
    label: "Free",
    price_usd: 0,
    included_usd: 2,
    default_model: HAIKU,
    strong_model: HAIKU,
    routines: { max: 3, min_interval_ms: DAY_MS },
    concurrent_turns: 1,
    turn_ceiling_usd: 0.25,
  },
  plus: {
    id: "plus",
    label: "Plus",
    price_usd: 20,
    included_usd: 12,
    default_model: SONNET,
    strong_model: SONNET,
    routines: { max: 25, min_interval_ms: null },
    concurrent_turns: 2,
    turn_ceiling_usd: 1,
  },
  pro: {
    id: "pro",
    label: "Pro",
    price_usd: 60,
    included_usd: 40,
    default_model: SONNET,
    strong_model: OPUS,
    routines: { max: null, min_interval_ms: null },
    concurrent_turns: 3,
    turn_ceiling_usd: 2,
  },
};

/** What a top-up buys: model usage, in US dollars at cost, per dollar paid
 *  before tax. Below one so a top-up keeps the margin a plan keeps (Plus is
 *  $20 for $12 of usage) and covers Stripe's fee. A starting value pending
 *  the founder's call, like PLANS. */
export const TOPUP = {
  usage_usd_per_usd: 0.6,
  /** The amounts, in whole dollars before tax, a top-up can be bought in:
   *  what the plan screen offers and the only amounts checkout accepts. */
  amounts_usd: [10, 25],
} as const;

/** The usage a top-up of `paidUsd` (before tax) credits. */
export function topupCredit(paidUsd: number): number {
  return Math.round(paidUsd * TOPUP.usage_usd_per_usd * 1e6) / 1e6;
}

/** The answers an approval card offers, in order: the first is the yes. The
 *  turn engine writes them on the card and reads the pick back by label
 *  (convex/assistant/turns.ts approvalOf); a transcript reads `decline` to
 *  know the declined step already says the answer (lane.ts answerNote). */
/** Where a hosted routine's work arrives, said the same way on its approval
 *  card, in the assistant's reply (the tool result carries it) and on its
 *  row in Routines. A routine fires into its own conversation. */
/** Promises only the inbox: whether a notification also arrives depends on
 *  the device, which the card says for itself (web RoutineNotifyLine). */
export const ROUTINE_SHOWS_UP = "Each run arrives in your inbox.";

/** What Yes does on a routine's approval card, saying only what the card's
 *  summary and When line do not: that a repeating one runs until paused,
 *  and where each run arrives. The When line already says when it starts.
 *  The card's words (convex assistant/turns.ts approveWords) and the
 *  marketing page's drawn card both say it through here. */
export function routineYesWords(repeats: boolean): string {
  return repeats ? `Runs until you pause it. ${ROUTINE_SHOWS_UP}` : "Runs once. What it finds arrives in your inbox.";
}

export const APPROVAL_ANSWERS = { approve: "Approve", always: "Always allow", decline: "Decline" } as const;

/** What an approval's buttons say in hosted mode, where a card asks the way
 *  a person would: Yes, or Not now. The stored labels stay APPROVAL_ANSWERS,
 *  which the engine reads the answer by. */
export const APPROVAL_BUTTONS: Record<string, string> = {
  [APPROVAL_ANSWERS.approve]: "Yes",
  [APPROVAL_ANSWERS.always]: "Always allow",
  [APPROVAL_ANSWERS.decline]: "Not now",
};

/** Whether a reply leaves the next move to the person. Two readings, either
 *  enough: a question anywhere in its last paragraph ("Which one appeals to
 *  you? I'll look into it next."), or a question line anywhere in it, a
 *  line ending on "?" or a bolded question, since a reply that asks two
 *  things and then signs off ("Once I know those, I can sketch a plan.")
 *  still waits on them. Quoted lines and code are someone else's words and
 *  never count. The engine settles such a turn as the person's to answer,
 *  and the composer then reads "Reply…". */
export function replyAsksPerson(text: string | null | undefined): boolean {
  const own = ownLines(text ?? "");
  const paragraphs = own.join("\n").trim().split(/\n\s*\n/);
  if ((paragraphs[paragraphs.length - 1] ?? "").includes("?")) return true;
  return own.some((line) => /\?[*_)\]"'”’\s]*$/.test(line) || /(\*\*|__)[^*_]*\?\s*(\*\*|__)/.test(line));
}

/** Tools whose call is itself the whole answer to a quick ask: a to-do
 *  added, a routine set, a short note written. */
const QUICK_SAVE_TOOLS = new Set(["create_task", "schedule_routine", "write_doc"]);
/** Tools a quick save may look around with first without changing its kind. */
const QUICK_SAVE_READS = new Set(["list_tasks", "list_routines", "recall", "remember"]);
/** A reply longer than this is an answer to read, whatever it saved. */
export const QUICK_SAVE_REPLY_CHARS = 280;
/** A note longer than this is the content the person asked for. */
export const QUICK_SAVE_NOTE_CHARS = 400;

/** Whether a finished turn only saved what the person asked for ("Add a
 *  to-do: buy stamps"): at least one save, nothing else but looking around,
 *  a short note if any, and a short reply that asks nothing and holds no
 *  table. Such a turn files as read, since its receipt is not news; an
 *  answer the person has not seen stays new. */
export function turnIsQuickSave(calls: readonly { name: string; input: unknown }[], reply: string | null | undefined): boolean {
  const text = (reply ?? "").trim();
  if (!text || text.length > QUICK_SAVE_REPLY_CHARS || /^\s*\|/m.test(text) || replyAsksPerson(text)) return false;
  let saved = false;
  for (const call of calls) {
    if (QUICK_SAVE_READS.has(call.name)) continue;
    if (!QUICK_SAVE_TOOLS.has(call.name)) return false;
    if (call.name === "write_doc" && noteText(call.input).length > QUICK_SAVE_NOTE_CHARS) return false;
    saved = true;
  }
  return saved;
}

function noteText(input: unknown): string {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  const content = (value as { content?: unknown } | null)?.content;
  return typeof content === "string" ? content : "";
}

/** A reply's lines in the assistant's own voice: block quotes and fenced
 *  code dropped, and text inside quotation marks blanked. */
function ownLines(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(line)) continue;
    lines.push(line.replace(/"[^"\n]*"|“[^”\n]*”/g, "\"\"").trimEnd());
  }
  return lines;
}

/** An approval option's label as hosted mode shows it; any other label as is. */
export function approvalButtonLabel(label: string): string {
  return APPROVAL_BUTTONS[label] ?? label;
}

/** What one everyday request costs the assistant, in US dollars. A turn is
 *  one ask with every model call and tool it took. Prod's assistant_turns on
 *  2026-10-07 (76 charged turns): median $0.0039, mean $0.0048, p75 $0.0047,
 *  p90 $0.0075, a web search up to $0.035. A month mixes the two, so the
 *  mean sizes it, rounded up so the count never promises more than it buys.
 *  The plan screen sizes the Free month with it ("Room for about 400
 *  everyday requests"); remeasure as real usage grows. */
export const TYPICAL_REQUEST_USD = 0.005;

/** What every Free turn together may spend in one UTC day before new Free
 *  turns pause until the next (convex/assistant/freeGate.ts). The deployment's
 *  HOSTED_FREE_DAILY_USD overrides it. A ceiling on our own spend, not on
 *  any one person: each person's month is their plan's allowance. */
export const FREE_DAILY_CEILING_USD = 25;

/** Where Stripe sends a person back after checkout or the portal, and what
 *  `?<param>=` says happened. The server builds the URLs (convex/billing.ts)
 *  and Settings > Plan reads them (its return note), so both sides name the
 *  page and the outcomes from here. The address opens the settings modal on
 *  Plan with the query carried over (SettingsRedirect). */
export const BILLING_RETURN = {
  path: "/settings/plan",
  param: "billing",
  outcomes: ["done", "topup", "canceled"],
} as const;
export type BillingReturnOutcome = (typeof BILLING_RETURN.outcomes)[number];

/** The outcome a return URL's `?billing=` names, or null for anything else. */
export function billingReturnOutcome(raw: string | null | undefined): BillingReturnOutcome | null {
  return raw && (BILLING_RETURN.outcomes as readonly string[]).includes(raw) ? (raw as BillingReturnOutcome) : null;
}

/** Codecast's plans as the wallet reads them (@platform/assistant walletRules). */
export const PLAN_CATALOG: PlanCatalog<PlanId> = { plans: PLANS, free: "free" };

/** The plan for a stored id; anything unknown or absent is the free plan. */
export function planOf(id: string | null | undefined): PlanSpec {
  return planIn(PLAN_CATALOG, id);
}

/** The routine fields a plan limits. */
export interface RoutineShape {
  schedule_type: string;
  interval_ms?: number;
}

function describeInterval(ms: number): string {
  const days = ms / DAY_MS;
  if (Number.isInteger(days)) return days === 1 ? "day" : `${days} days`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  return hours <= 1 ? "hour" : `${hours} hours`;
}

export const HOSTED_ROUTINE_NO_EVENTS = "A hosted assistant runs routines on a schedule, not on events";

/** The shortest interval a recurring routine may repeat at on this plan: the
 *  plan's own floor, never below ROUTINE_MIN_INTERVAL_MS. Every surface that
 *  enforces or describes a routine's cadence reads it from here. */
export function routineFloor(plan: PlanSpec): number {
  return Math.max(plan.routines.min_interval_ms ?? 0, ROUTINE_MIN_INTERVAL_MS);
}

/** Why `plan` refuses a routine on a hosted conversation, or null when it
 *  fits. `armedOthers` counts the person's other armed hosted routines the
 *  routine competes with: every one when it is being armed, only the older
 *  ones when the dispatcher rechecks a routine already armed (so when a plan
 *  shrinks the oldest keep running). Every plan refuses event routines: an
 *  event's frame carries text written by outsiders (issue and comment titles)
 *  into a message sent as the owner, and nothing bounds how often it fires.
 *  Admitting them needs the turn engine to treat that block as untrusted. */
export function routineRefusal(plan: PlanSpec, routine: RoutineShape, armedOthers: number): string | null {
  if (routine.schedule_type === "event") {
    return HOSTED_ROUTINE_NO_EVENTS;
  }
  const { max, min_interval_ms: planFloor } = plan.routines;
  if (max !== null && armedOthers >= max) {
    return `The ${plan.label} plan runs up to ${max} routines at a time`;
  }
  const floor = routineFloor(plan);
  if (routine.schedule_type === "recurring" && !((routine.interval_ms ?? 0) >= floor)) {
    return planFloor !== null && planFloor >= ROUTINE_MIN_INTERVAL_MS
      ? `The ${plan.label} plan repeats a routine at most once every ${describeInterval(floor)}`
      : `A routine repeats at most once every ${describeInterval(floor)}`;
  }
  return null;
}
