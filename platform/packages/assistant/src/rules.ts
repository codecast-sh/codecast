// What a person has allowed a hosted assistant to do without asking: rules
// of allow, ask or refuse per tool, narrowed to the people a call reaches,
// laid over the turn's gate. Also the approval card's view of a call. No
// storage: the app keeps the rules and hands them in.
//
// How an "Always allow" narrows is decided per tool, by the module that
// defines the tool (MAIL_SCOPES, CALENDAR_SCOPES, WEB_SCOPES, and the app's
// own), and the app joins them into one table. The card (whether to offer
// Always allow, and what it says it covers) and the gate (which rules apply)
// both read that table, so they cannot disagree.
import type { Gate, GateDecision, ToolCallRequest } from "@platform/agent";
import { normalizeTimezone } from "./zone";

/** What a rule decides for its tool. With no rule the gate asks. */
export type RuleDecision = "allow" | "ask" | "refuse";

/** One stored rule, as the gate reads it. */
export interface RuleView {
  tool: string;
  decision: RuleDecision;
  /** The people the rule covers (`AllowScope.match`); absent for the whole tool. */
  match?: string;
}

/**
 * How an "Always allow" narrows for one call:
 *   never  The call is asked every time. A page the model chose can carry the
 *          person's data out in its address; a routine's prompt comes back
 *          later as the person's own words; an update that emails an event's
 *          guests reaches people the rule cannot name. Any tool not in the
 *          table is never, until someone decides how it narrows.
 *   tool   The call stays inside the person's own account, so one rule covers
 *          the whole tool.
 *   match  The call reaches other people, so the rule covers exactly the
 *          people this call reaches (or no one, for an event with no guests).
 */
export type AllowScope = { kind: "never" } | { kind: "tool" } | { kind: "match"; match: string; covers: string };

/** Each tool's narrowing, by tool name. */
export type AllowScopes = Readonly<Record<string, (input: Record<string, unknown>) => AllowScope>>;

export const NEVER: AllowScope = { kind: "never" };
export const WHOLE_TOOL: AllowScope = { kind: "tool" };
/** The match of a call that reaches no one outside the person's account. */
export const NO_ONE = "no one";

/** How an Always allow on this call narrows, by the table. */
export function allowScopeIn(scopes: AllowScopes, call: Pick<ToolCallRequest, "name" | "input">): AllowScope {
  return (Object.prototype.hasOwnProperty.call(scopes, call.name) ? scopes[call.name](call.input ?? {}) : undefined) ?? NEVER;
}

/** The rule match an Always allow on this call writes, and an allow rule must
 *  carry to cover it: the people it reaches, or undefined for a whole tool. */
export function scopeMatch(scope: AllowScope): string | undefined {
  return scope.kind === "match" ? scope.match : undefined;
}

function verdictOf(decision: GateDecision) {
  return typeof decision === "string" ? { verdict: decision } : decision;
}

/** The turn's gate with the person's rules applied to a write call it would
 *  ask about. A refuse rule for the tool refuses (one with a `match` only for
 *  the call's people). An allow rule runs it only when it covers exactly what
 *  the call's scope would write: never for a tool that is always asked, the
 *  tool as a whole, or the same people. A read tool that asks (a write to
 *  lasting memory after outside content) is always asked: no standing rule
 *  can waive that.
 *
 *  `readOutside` says whether content the person did not write (mail, events,
 *  pages) is in front of the model. While it is, an allow rule never waives a
 *  call that reaches other people: an email from an address the person always
 *  allows could otherwise steer the model into sending that address their
 *  private mail with no card. Rules for calls that stay in the account, or
 *  reach no one, still apply. */
export function withRules(base: Gate, rules: readonly RuleView[], scopes: AllowScopes, readOutside: () => boolean = () => false): Gate {
  return async (call) => {
    const decided = verdictOf(await base(call));
    if (decided.verdict !== "ask" || call.risk !== "write") return decided;
    const scope = allowScopeIn(scopes, call);
    const target = scopeMatch(scope);
    const mine = rules.filter((rule) => rule.tool === call.name);
    if (mine.some((rule) => rule.decision === "refuse" && (rule.match === undefined || rule.match === target))) return "refuse";
    if (scope.kind === "never" || (scope.kind === "match" && scope.match !== NO_ONE && readOutside())) return "ask";
    return mine.some((rule) => rule.decision === "allow" && rule.match === target) ? "allow" : "ask";
  };
}

// ── The approval card ───────────────────────────────────────────────────────

/** A tool or field name as words: `send_mail` reads "Send mail". */
export function humanLabel(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Text shown exactly as written: an inline code span with a fence longer
 *  than any backtick run inside, padded when the text starts or ends with a
 *  backtick or a space (CommonMark strips one space from each side). */
function literal(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(text) ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** A whole ISO 8601 instant with its offset, the shape a tool takes a time in. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** An instant as a person reads a time: "Wednesday, October 7 at 8:00 AM" on
 *  the clock of `timezone`. The year shows only when it is not this one, and
 *  the zone is named only when the person's is unknown and the clock is UTC,
 *  so a time nobody can place is never passed off as local. */
export function plainInstant(at: number, timezone: string | null | undefined, now = Date.now()): string {
  const timeZone = normalizeTimezone(timezone);
  const year = (t: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(t);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone,
    ...(year(at) === year(now) ? {} : { year: "numeric" }),
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
  return `${day} at ${time}${timezone && timeZone === timezone ? "" : " UTC"}`;
}

/** A repeat given in hours, as a person says it: 24 is "every day". */
export function plainEvery(hours: number): string {
  const count = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  if (hours % 168 === 0) return count(hours / 168, "week");
  if (hours % 24 === 0) return count(hours / 24, "day");
  return count(Math.round(hours * 100) / 100, "hour");
}

/** A field whose name says it is a repeat in hours (`repeat_every_hours`). */
const EVERY_HOURS = /(^|_)every_hours$/;

/** The exact draft or event a call would act with, as the card shows it:
 *  short fields as lines, long text whole in a block, nothing reworded. Every
 *  value the model wrote renders literally, so markdown in it (a link with
 *  other text, emphasis) cannot make the card show something other than what
 *  will be sent. Two shapes are read for the person instead of quoted, since
 *  nobody outside engineering can check them as written: an instant
 *  ("2026-10-07T08:00:00+00:00") reads as a day and a time on their own
 *  clock (`timezone`), and a repeat in hours reads as "every day". Both are
 *  words this function wrote from a parsed value, so they stay plain text.
 *
 *  The card is the one thing the person must read with care, so it says each
 *  fact once and keeps like with like. A short text the `question` above the
 *  draft already quotes (a routine's title, in "Set up a routine: "Morning
 *  weather"?") is left out. The lines that say when (an instant, a repeat)
 *  sit together after the others, whatever order the tool takes them in. */
export function approvalContext(input: Record<string, unknown>, opts: { timezone?: string | null; now?: number; question?: string } = {}): string {
  const lines: string[] = [];
  const when: string[] = [];
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))) {
      when.push(`**${humanLabel(key)}:** ${plainInstant(Date.parse(value), opts.timezone, opts.now)}`);
      continue;
    }
    if (typeof value === "number" && value > 0 && EVERY_HOURS.test(key)) {
      when.push(`**Repeats:** ${plainEvery(value)}`);
      continue;
    }
    const shown =
      typeof value === "string" ? value
      : Array.isArray(value) && value.every((item) => typeof item !== "object") ? value.join(", ")
      : typeof value === "boolean" ? (value ? "Yes" : "No")
      : typeof value === "number" ? String(value)
      : JSON.stringify(value, null, 2);
    if (shown.length > 120 || shown.includes("\n")) blocks.push(`**${humanLabel(key)}**\n\n${fenced(shown)}`);
    else if (typeof value === "string" && saidIn(opts.question, value)) continue;
    else lines.push(`**${humanLabel(key)}:** ${typeof value === "boolean" ? shown : literal(shown)}`);
  }
  return [[...lines, ...when].join("  \n"), ...blocks].filter(Boolean).join("\n\n");
}

/** Whether the question already shows this text whole: the exact text, three
 *  characters or more, not as a piece of a longer word ("Dan" is not said by
 *  a question about Dana). */
function saidIn(question: string | undefined, text: string): boolean {
  const said = text.trim();
  if (!question || said.length < 3) return false;
  for (let at = question.indexOf(said); at !== -1; at = question.indexOf(said, at + 1)) {
    const before = question[at - 1] ?? " ";
    const after = question[at + said.length] ?? " ";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}
