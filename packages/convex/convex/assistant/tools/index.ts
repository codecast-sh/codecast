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
import type { Tool } from "@platform/agent";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  CALENDAR_EVENTS_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  googleScopeGranted,
} from "../../googleOAuth";
import { googleDepsFor, type GoogleDeps } from "./google";
import { gmailTools } from "./gmail";
import { calendarTools } from "./calendar";
import { codecastTools } from "./codecast";
import { webTools, type WebDeps } from "./web";

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
}

/** What a person's Google connections allow, across all of them. */
export function googleAccess(connections: readonly { granted_scopes: readonly string[] }[]) {
  const any = (scope: string) => connections.some((c) => googleScopeGranted(c.granted_scopes, scope));
  return {
    connected: connections.length > 0,
    read: any(GMAIL_READONLY_SCOPE),
    modify: any(GMAIL_MODIFY_SCOPE),
    send: any(GMAIL_SEND_SCOPE),
    calendar: any(CALENDAR_EVENTS_SCOPE),
  };
}

/** The note for what is missing, in the words the assistant can pass on. */
export function connectionNote(access: ReturnType<typeof googleAccess>): string {
  if (!access.connected) {
    return "The person has not connected Google, so you cannot read or send their mail or see their calendar. If they ask for that, offer to connect Google from Connections.";
  }
  const missing = [
    ...(!access.modify ? ["draft, archive or label mail (allow gmail.modify)"] : []),
    ...(!access.send ? ["send mail (allow gmail.send)"] : []),
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
  const google = options.google ?? googleDepsFor(ctx, userId);
  const googleWithFetch = options.fetch ? { ...google, fetch: options.fetch } : google;
  return {
    tools: [
      ...gmailTools(googleWithFetch, access),
      ...(access.calendar ? calendarTools(googleWithFetch) : []),
      ...codecastTools({ runQuery: ctx.runQuery, runMutation: ctx.runMutation, userId, conversationId }),
      ...webTools({ fetch: options.fetch, onCost: options.onCost }),
    ],
    note: connectionNote(access),
  };
}
