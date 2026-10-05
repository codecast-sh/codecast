// The hosted assistant's tool set for one turn (plan pl-840, build spec
// docs/architecture/hosted-assistant.md). toolsFor gives the turn engine
// every tool this person can use right now: Gmail and Calendar only as far
// as their Google connection allows, codecast's own verbs, and the web. With
// it comes a short note naming what they have not connected, for the system
// prompt, so the assistant can offer to set it up instead of failing.
//
// Every tool acts as the conversation's owner and nobody else. Google tokens
// are fetched inside each call (google.ts) and never appear in arguments,
// results or logs.
import { gateByRisk, type Gate, type MessageRow, type Tool } from "@platform/agent";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { googleCapabilities, type GoogleCapabilities } from "../../googleOAuth";
import { googleDepsFor, sharedTokens, type GoogleDeps } from "./google";
import { gmailTools } from "./gmail";
import { calendarTools } from "./calendar";
import { codecastTools } from "./codecast";
import { pageAllowedWithoutAsking, webTools, type WebDeps } from "./web";

export interface ToolsForOptions {
  /** Dollars a tool spends outside the turn's own model calls (search_web), to charge to the wallet. */
  onCost?: WebDeps["onCost"];
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
   * without asking when its URL is one the person wrote or a web tool found
   * this turn (pageAllowedWithoutAsking). Pass the rows the run works from.
   */
  gate: (rows: readonly MessageRow[]) => Gate;
}

export type GoogleAccess = GoogleCapabilities & { connected: boolean };

/** What a person's Google connections allow, across all of them: each
 *  capability (googleCapabilities, the rule the Connections screen shows) held
 *  by any one connection. */
export function googleAccess(connections: readonly { granted_scopes: readonly string[] }[]): GoogleAccess {
  const each = connections.map((c) => googleCapabilities(c.granted_scopes));
  const any = (key: keyof GoogleCapabilities) => each.some((can) => can[key]);
  return {
    connected: connections.length > 0,
    read_mail: any("read_mail"),
    modify_mail: any("modify_mail"),
    send_mail: any("send_mail"),
    calendar: any("calendar"),
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
  return missing.length
    ? `Google is connected, but you cannot ${missing.join(", or ")}. If they ask for that, offer to allow it from Connections.`
    : "";
}

/** Every tool the conversation's owner can use in this turn, and what they could still connect. */
export async function toolsFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  options: ToolsForOptions = {},
): Promise<ToolSet> {
  const connections: { granted_scopes: string[] }[] = await ctx.runQuery(internal.googleOAuth.connectionScopesForUser, { user_id: userId });
  const access = googleAccess(connections);
  const found = new Set<string>();
  const google = sharedTokens(options.google ?? googleDepsFor(ctx, userId));
  const googleWithFetch = options.fetch ? { ...google, fetch: options.fetch } : google;
  return {
    tools: [
      ...gmailTools(googleWithFetch, access),
      ...(access.calendar ? calendarTools(googleWithFetch) : []),
      ...codecastTools({ runQuery: ctx.runQuery, runMutation: ctx.runMutation, userId, conversationId }),
      ...webTools({ fetch: options.fetch, onCost: options.onCost, found }),
    ],
    note: connectionNote(access),
    gate: (rows) => (call) => (call.name === "fetch_page" && pageAllowedWithoutAsking(call.input.url, rows, found) ? "allow" : gateByRisk(call)),
  };
}

