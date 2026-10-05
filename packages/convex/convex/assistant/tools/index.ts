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
import { googleCapabilities, type GoogleCapabilities } from "../../googleOAuth";
import { googleDepsFor, sharedTokens, type GoogleDeps } from "./google";
import { gmailTools } from "./gmail";
import { calendarTools } from "./calendar";
import { codecastTools } from "./codecast";
import { pageAllowedWithoutAsking, SEARCH_MAX_PER_TURN, searchesBefore, webTools } from "./web";

export interface ToolsForOptions {
  /** Overrides for tests: a fake Google and a fake fetch. */
  google?: GoogleDeps;
  fetch?: typeof fetch;
}

export interface ToolSet {
  tools: Tool[];
  /** What the person has not connected or allowed, for the system prompt. Empty when nothing is missing. */
  note: string;
  /**
   * The gate for this turn's run: gateByRisk, except that fetch_page runs
   * without asking when its URL is one the person typed or a search returned
   * this turn (pageAllowedWithoutAsking), and search_web is refused past
   * SEARCH_MAX_PER_TURN (searchesBefore). Pass the rows the run works from:
   * the history plus every row the run appends.
   */
  gate: (rows: readonly MessageRow[]) => Gate;
}

export type GoogleConnection = { email: string; granted_scopes: readonly string[] };
export type GoogleAccess = GoogleCapabilities & { connected: boolean; email?: string; others: string[] };

/** The Google account a turn works in: the confirmed connection that allows
 *  the most (googleCapabilities, the rule the Connections screen shows), the
 *  most recently updated on a tie. `connections` come newest first. */
export function googleAccount<C extends GoogleConnection>(connections: readonly C[]): C | undefined {
  const score = (c: GoogleConnection) => Object.values(googleCapabilities(c.granted_scopes)).filter(Boolean).length;
  return connections.reduce<C | undefined>((best, c) => (!best || score(c) > score(best) ? c : best), undefined);
}

/** What the turn's Google account allows, and the other accounts it leaves out. */
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

/** The note for what is missing, in the words the assistant can pass on. */
export function connectionNote(access: GoogleAccess): string {
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

/** Every tool the conversation's owner can use in this turn, and what they could still connect. */
export async function toolsFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  options: ToolsForOptions,
): Promise<ToolSet> {
  const connections: GoogleConnection[] = await ctx.runQuery(internal.googleOAuth.connectionScopesForUser, { user_id: userId });
  const access = googleAccess(connections);
  const found = new Set<string>();
  const google = sharedTokens(options.google ?? googleDepsFor(ctx, userId, access.email));
  const googleWithFetch = options.fetch ? { ...google, fetch: options.fetch } : google;
  return {
    tools: [
      ...gmailTools(googleWithFetch, access),
      ...(access.calendar ? calendarTools(googleWithFetch) : []),
      ...codecastTools({ runQuery: ctx.runQuery, runMutation: ctx.runMutation, userId, conversationId }),
      ...webTools({ fetch: options.fetch, found }),
    ],
    note: connectionNote(access),
    gate: (rows) => (call) => {
      if (call.name === "fetch_page" && pageAllowedWithoutAsking(call.input.url, rows, found)) return "allow";
      if (call.name === "search_web" && searchesBefore(rows, call.id) >= SEARCH_MAX_PER_TURN) {
        return { verdict: "refuse", reason: `No more than ${SEARCH_MAX_PER_TURN} web searches in one turn` };
      }
      return gateByRisk(call);
    },
  };
}

