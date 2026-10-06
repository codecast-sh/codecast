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
//
// The mail, calendar and web tools are @platform/assistant's, written over an
// injected transport: Whisk through the person's WhiskCall, the web through
// web.ts's binding. Codecast's own verbs (codecast.ts) are its own.
import { gateByRisk, type Gate, type MessageRow, type Tool } from "@platform/agent";
import { CALENDAR_SCOPES, calendarTools, MAIL_SCOPES, mailTools, whiskCalendar, whiskMailbox, type AllowScopes } from "@platform/assistant";
import type { Id } from "../../_generated/dataModel";
import { whiskAccessFor, type WhiskAccess } from "../../whisk";
import { whiskConnectOpen, whiskWebUrl, type WhiskCall } from "../../lib/whisk";
import { CODECAST_SCOPES, codecastTools, PERSON_APPROVED_TOOLS } from "./codecast";
import { pageAllowedWithoutAsking, SEARCH_MAX_PER_TURN, searchesBefore, WEB_SCOPES, webTools } from "./web";

/** How an Always allow narrows for every tool the assistant may be offered
 *  (@platform/assistant rules): the one table the approval card and the
 *  turn's rules both read. A tool missing here is always asked. */
export const ALLOW_SCOPES: AllowScopes = { ...MAIL_SCOPES, ...CALENDAR_SCOPES, ...WEB_SCOPES, ...CODECAST_SCOPES };

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

/** What the assistant says while mail and calendar cannot be connected yet:
 *  this deployment holds Whisk's settings, but Connect leads nowhere
 *  (whiskConnectOpen is false), so no Connect button shows anywhere. */
export const MAIL_COMING_NOTE =
  "Mail and calendar are coming soon through Whisk, so you cannot read or send the person's mail or see their calendar yet. If they ask for that, say plainly that it is coming soon. Do not offer to connect them, and do not mention a Connect button or a settings step.";

/** The note for what is missing, in the words the assistant can pass on.
 *  `connectOpen` is the same gate every Connect button reads (whisk.ts
 *  connectAvailable), so the note never promises a button the screen hides. */
export function connectionNote(access: WhiskAccess, connectOpen: boolean = whiskConnectOpen()): string {
  if (access.state === "not_configured") {
    return "Mail and calendar are not available on this server, so you cannot read or send the person's mail or see their calendar. Do not offer to connect them.";
  }
  if ((access.state === "not_connected" || access.state === "reconnect") && !connectOpen) return MAIL_COMING_NOTE;
  if (access.state === "not_connected") {
    return "The person has not connected their mail and calendar, so you cannot read or send their mail or see their calendar. If they ask for that, offer to connect them: it takes one step in Settings, under Integrations, and goes through Whisk, their mail app. A Connect button shows under your reply.";
  }
  if (access.state === "reconnect") {
    return "The person's mail and calendar connection has to be made again, so you cannot use their mail or calendar now. If they ask for that, offer to reconnect them in Settings, under Integrations. A Connect button shows under your reply.";
  }
  const can = access.can;
  const missing = [
    ...(!can.read_mail ? ["read their mail"] : []),
    ...(can.read_mail && !can.modify_mail ? ["draft, archive or label mail"] : []),
    ...(can.read_mail && !can.send_mail ? ["send mail"] : []),
    ...(!can.calendar ? ["see or change their calendar"] : []),
  ];
  return missing.length
    ? `Mail and calendar are connected through Whisk, but you cannot ${missing.join(", or ")}. If they ask for that, offer to connect them again in Settings, under Integrations.`
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
  const mailbox = whiskMailbox(connected?.call ?? NO_WHISK, whiskWebUrl());
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

