// The hosted assistant's tool set for one turn (plan pl-840, build spec
// docs/architecture/hosted-assistant.md). toolsFor gives the turn engine
// every tool this person can use right now: mail and calendar only as far as
// their Whisk connection allows, codecast's own verbs, and the web. With it
// comes a short note naming what they have not connected, for the system
// prompt, so the assistant can offer to set it up instead of failing.
//
// Every tool acts as the conversation's owner and nobody else. Mail and
// calendar go through Whisk with the owner's app token (convex/whisk.ts
// whiskAccessFor), which lives inside the call closure and never appears in
// arguments, results or logs. Codecast holds no Google token for them.
import { gateByRisk, type Gate, type MessageRow, type Tool } from "@platform/agent";
import type { Id } from "../../_generated/dataModel";
import { whiskAccessFor, type WhiskAccess } from "../../whisk";
import type { WhiskCall } from "../../lib/whisk";
import { mailTools } from "./mail";
import { calendarTools } from "./calendar";
import { whiskCalendar, whiskMailbox } from "./whisk";
import { codecastTools, PERSON_APPROVED_TOOLS } from "./codecast";
import { pageAllowedWithoutAsking, SEARCH_MAX_PER_TURN, searchesBefore, webTools } from "./web";

export interface ToolsForOptions {
  /** Overrides for tests: the person's Whisk access (a fake Whisk behind a
   *  connected one) and a fake fetch. */
  whisk?: WhiskAccess;
  fetch?: typeof fetch;
}

export interface ToolSet {
  tools: Tool[];
  /** What the person has not connected or allowed, for the system prompt. Empty when nothing is missing. */
  note: string;
  /**
   * The gate for this turn's run: gateByRisk, except that fetch_page runs
   * without asking when its URL is one the person typed
   * (pageAllowedWithoutAsking), search_web is refused past
   * SEARCH_MAX_PER_TURN (searchesBefore), and remember asks once outside
   * content is anywhere the model can see it (readOutsideContent). Pass the
   * rows the run works from: the history plus every row the run appends.
   */
  gate: (rows: readonly MessageRow[]) => Gate;
  /** Whether outside content (readOutsideContent) is anywhere in these rows:
   *  the one taint check, read by the gate for remember and by the turn's
   *  rules (turns.withRules) for an allow rule that reaches other people. */
  readOutside: (rows: readonly MessageRow[]) => boolean;
}

/** The note for what is missing, in the words the assistant can pass on. */
export function connectionNote(access: WhiskAccess): string {
  if (access.state === "not_configured") {
    return "Mail and calendar are not available on this server, so you cannot read or send the person's mail or see their calendar. Do not offer to connect them.";
  }
  if (access.state === "not_connected") {
    return "The person has not connected their mail and calendar, so you cannot read or send their mail or see their calendar. If they ask for that, offer to connect mail and calendar from Connections; it goes through Whisk, their mail app.";
  }
  if (access.state === "reconnect") {
    return "The person's mail and calendar connection has to be made again, so you cannot use their mail or calendar now. If they ask for that, offer to reconnect mail and calendar from Connections.";
  }
  const can = access.can;
  const missing = [
    ...(!can.read_mail ? ["read their mail"] : []),
    ...(can.read_mail && !can.modify_mail ? ["draft, archive or label mail"] : []),
    ...(can.read_mail && !can.send_mail ? ["send mail"] : []),
    ...(!can.calendar ? ["see or change their calendar"] : []),
  ];
  return missing.length
    ? `Mail and calendar are connected through Whisk, but you cannot ${missing.join(", or ")}. If they ask for that, offer to connect mail and calendar again from Connections.`
    : "";
}

/** The names of the tools whose results can bring in text the person did
 *  not write or approve: mail, calendar, the web, and their tasks and docs.
 *  Only the codecast tools in PERSON_APPROVED_TOOLS are left out. */
export function outsideToolNames(tools: readonly Tool[]): Set<string> {
  return new Set(tools.filter((t) => t.source && !PERSON_APPROVED_TOOLS.has(t.name)).map((t) => t.name));
}

/**
 * Whether any row the run works from calls a tool that brought in outside
 * content. Every such row is in front of the model, earlier turns' replayed
 * history included, so an instruction an email or page carried can steer it
 * in any later turn. remember runs without asking only when there is none,
 * so a fact outside text steered the model to never lands in the person's
 * lasting memory, where later turns would read it back as their own
 * preference, without the person seeing it first.
 */
export function readOutsideContent(rows: readonly MessageRow[], outside: ReadonlySet<string>): boolean {
  return rows.some((row) => row.tool_calls?.some((call) => outside.has(call.name)));
}

const ALL_MAIL = { read_mail: true, modify_mail: true, send_mail: true };

/** A Whisk that is not there: the tool definitions still name every outside
 *  tool for the taint check, and none of them is offered. */
const NO_WHISK: WhiskCall = async () => {
  throw new Error("Mail and calendar are not connected.");
};

/** Every tool the conversation's owner can use in this turn, and what they could still connect. */
export async function toolsFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  options: ToolsForOptions = {},
): Promise<ToolSet> {
  const access = options.whisk ?? (await whiskAccessFor(ctx, userId, options.fetch));
  const connected = access.state === "connected" ? access : null;
  const mailbox = whiskMailbox(connected?.call ?? NO_WHISK);
  const calendar = whiskCalendar(connected?.call ?? NO_WHISK);
  const tools = [
    ...(connected ? mailTools(mailbox, connected.can) : []),
    ...(connected?.can.calendar ? calendarTools(calendar) : []),
    ...codecastTools({ runQuery: ctx.runQuery, runMutation: ctx.runMutation, userId, conversationId }),
    ...webTools({ fetch: options.fetch }),
  ];
  // Every outside tool, offered now or not: history read through a
  // connection the person has since narrowed or removed is still in front
  // of the model.
  const outside = outsideToolNames([...mailTools(mailbox, ALL_MAIL), ...calendarTools(calendar), ...tools]);
  const readOutside = (rows: readonly MessageRow[]) => readOutsideContent(rows, outside);
  return {
    tools,
    note: connectionNote(access),
    readOutside,
    gate: (rows) => (call) => {
      if (call.name === "fetch_page" && pageAllowedWithoutAsking(call.input.url, rows)) return "allow";
      if (call.name === "remember" && readOutside(rows)) return "ask";
      if (call.name === "search_web" && searchesBefore(rows, call.id) >= SEARCH_MAX_PER_TURN) {
        return { verdict: "refuse", reason: `No more than ${SEARCH_MAX_PER_TURN} web searches in one turn` };
      }
      return gateByRisk(call);
    },
  };
}

