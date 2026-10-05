// The hosted assistant's tool set for one turn (plan pl-840, build spec
// docs/architecture/hosted-assistant.md). toolsFor gives the turn engine
// every tool this person can use right now: Gmail and Calendar only as far
// as their Google connection allows, codecast's own verbs, and the web. With
// it comes a short note naming what they have not connected, for the system
// prompt, so the assistant can offer to set it up instead of failing.
//
// Every tool acts as the conversation's owner and nobody else. Google tokens
// are fetched inside each call (google.ts) and never appear in arguments,
// results or logs. A turn works in one Google account (googleAccount): every
// Gmail and Calendar call names it, so a thread read from one mailbox is never
// drafted, labelled or answered from another.
import { gateByRisk, type Gate, type MessageRow, type Tool } from "@platform/agent";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { googleAccount, googleCapabilities, googleConfigured, type GoogleCapabilities, type GoogleConnection } from "../../googleOAuth";
import { googleDepsFor, sharedTokens, type GoogleDeps } from "./google";
import { gmailMailbox } from "./gmail";
import { mailTools } from "./mail";
import { calendarTools } from "./calendar";
import { googleCalendar } from "./googleCalendar";
import { codecastTools, PERSON_APPROVED_TOOLS } from "./codecast";
import { pageAllowedWithoutAsking, SEARCH_MAX_PER_TURN, searchesBefore, webTools } from "./web";

export interface ToolsForOptions {
  /** Overrides for tests: a fake Google and a fake fetch. A fake Google
   *  stands in for a configured one (googleConfigured). */
  google?: GoogleDeps;
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
}

export type GoogleAccess = GoogleCapabilities & { connected: boolean; email?: string; others: string[] };

/** What the turn's Google account (googleAccount, the rule the Connections
 *  screen marks too) allows, and the other accounts it leaves out. */
export function googleAccess(connections: readonly GoogleConnection[]): GoogleAccess {
  const account = googleAccount(connections);
  const can = googleCapabilities(account?.granted_scopes ?? []);
  return {
    ...can,
    connected: !!account,
    ...(account ? { email: account.email } : {}),
    others: connections.filter((c) => c !== account).map((c) => c.email),
  };
}

/** The note for what is missing, in the words the assistant can pass on.
 *  `configured` is false when this server cannot connect Google at all, so
 *  there is nothing to offer. */
export function connectionNote(access: GoogleAccess, configured: boolean): string {
  if (!configured) {
    return "Mail and calendar are not available on this server, so you cannot read or send the person's mail or see their calendar. Do not offer to connect Google.";
  }
  if (!access.connected) {
    return "The person has not connected Google, so you cannot read or send their mail or see their calendar. If they ask for that, offer to connect Google from Connections.";
  }
  const missing = [
    ...(!access.modify_mail ? ["draft, archive or label mail (allow gmail.modify)"] : []),
    ...(!access.send_mail ? ["send mail (allow gmail.send)"] : []),
    ...(!access.calendar ? ["see or change their calendar (allow calendar.events)"] : []),
  ];
  const others = access.others.length
    ? `You work in the Google account ${access.email} only; ${access.others.join(", ")} ${access.others.length === 1 ? "is" : "are"} connected too, but you cannot use ${access.others.length === 1 ? "it" : "them"} yet.`
    : "";
  return [
    missing.length ? `Google is connected, but you cannot ${missing.join(", or ")}. If they ask for that, offer to allow it from Connections.` : "",
    others,
  ].filter(Boolean).join(" ");
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

/** Every tool the conversation's owner can use in this turn, and what they could still connect. */
export async function toolsFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  options: ToolsForOptions = {},
): Promise<ToolSet> {
  // On a server with no Google client every token ask fails, so no Google
  // tool is offered, whatever rows the person has.
  const configured = !!options.google || googleConfigured();
  const connections: GoogleConnection[] = configured ? await ctx.runQuery(internal.googleOAuth.connectionScopesForUser, { user_id: userId }) : [];
  const access = googleAccess(connections);
  const google = sharedTokens(options.google ?? googleDepsFor(ctx, userId, access.email));
  const googleWithFetch = options.fetch ? { ...google, fetch: options.fetch } : google;
  const mailbox = gmailMailbox(googleWithFetch);
  const calendar = googleCalendar(googleWithFetch);
  const tools = [
    ...mailTools(mailbox, access),
    ...(access.calendar ? calendarTools(calendar) : []),
    ...codecastTools({ runQuery: ctx.runQuery, runMutation: ctx.runMutation, userId, conversationId }),
    ...webTools({ fetch: options.fetch }),
  ];
  // Every outside tool, offered now or not: history read through a
  // connection the person has since narrowed or removed is still in front
  // of the model.
  const outside = outsideToolNames([...mailTools(mailbox, ALL_MAIL), ...calendarTools(calendar), ...tools]);
  return {
    tools,
    note: connectionNote(access, configured),
    gate: (rows) => (call) => {
      if (call.name === "fetch_page" && pageAllowedWithoutAsking(call.input.url, rows)) return "allow";
      if (call.name === "remember" && readOutsideContent(rows, outside)) return "ask";
      if (call.name === "search_web" && searchesBefore(rows, call.id) >= SEARCH_MAX_PER_TURN) {
        return { verdict: "refuse", reason: `No more than ${SEARCH_MAX_PER_TURN} web searches in one turn` };
      }
      return gateByRisk(call);
    },
  };
}

