// Whisk (whisk.email, ~/src/mail) is the product family's mail and calendar
// engine (docs/architecture/hosted-assistant.md, "Mail and calendar go
// through Whisk"). Codecast never holds a Gmail or Calendar token: the person
// connects codecast to Whisk once, Whisk mints a revocable app token, and
// codecast calls the same Convex functions the `whisk` CLI calls with it.
//
// This module is the leaf both halves read: the deployment's Whisk settings,
// and, from @platform/assistant's whisk module, what an app token's scopes
// let the assistant do, the link that opens a thread in Whisk, and the one
// door every call goes through (whiskHttpCall). It imports nothing from the
// generated api, so the connect module (convex/whisk.ts) and the assistant's
// tools can both load it alone.
import { WHISK_WEB_URL, whiskThreadLink as threadLinkAt } from "@platform/assistant/whisk";

export { WHISK_WEB_URL, whiskAbilities, whiskHttpCall, whiskRefusal, whiskThrown } from "@platform/assistant/whisk";
export type { MailAbilities, WhiskCall } from "@platform/assistant/whisk";

/** The app id codecast is registered under in Whisk (its lib/apps.ts). */
export const WHISK_APP_ID = "codecast";

/** The `app_installations` provider a person's Whisk connection is stored under. */
export const WHISK_PROVIDER = "whisk";

/** The codecast page Whisk returns to with its one-time code. Whisk allows
 *  exactly this path on codecast.sh (plus WHISK_APP_RETURN_URLS_CODECAST on
 *  its side for a local or staging codecast). */
export const WHISK_RETURN_PATH = "/connect/whisk";

export type WhiskEnv = {
  /** The app secret the code exchange presents (WHISK_APP_SECRET_CODECAST). */
  secret: string;
  /** Whisk's Convex deployment, where its functions answer (WHISK_CONVEX_URL). */
  convexUrl: string;
  /** Its HTTP actions host, where the code exchange lives. */
  siteUrl: string;
  /** Its web app, for the connect page and thread links. */
  webUrl: string;
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function whiskWebUrl(): string {
  return trimSlash(process.env.WHISK_WEB_URL || WHISK_WEB_URL);
}

/** The deployment's Whisk settings, or null when it cannot connect Whisk:
 *  both the app secret and Whisk's Convex URL must be set. */
export function whiskEnv(): WhiskEnv | null {
  const secret = process.env.WHISK_APP_SECRET_CODECAST;
  const convexUrl = process.env.WHISK_CONVEX_URL;
  if (!secret || !convexUrl) return null;
  const base = trimSlash(convexUrl);
  return {
    secret,
    convexUrl: base,
    siteUrl: trimSlash(process.env.WHISK_SITE_URL || base.replace(/\.convex\.cloud$/, ".convex.site")),
    webUrl: whiskWebUrl(),
  };
}

/** Whether this deployment can connect mail and calendar through Whisk. */
export function whiskConfigured(): boolean {
  return whiskEnv() !== null;
}

/** Whether Whisk serves its side of a connect (the whisk.email/connect page
 *  and the code exchange), so a Connect button leads somewhere. Set
 *  WHISK_CONNECT_OPEN=1 once that ships: until then a deployment can hold
 *  Whisk's settings for the tools while Connect stays hidden, rather than
 *  sending a newcomer to a page Whisk does not have. */
export function whiskConnectOpen(): boolean {
  return whiskConfigured() && process.env.WHISK_CONNECT_OPEN === "1";
}

/** Where a connect comes back to: the page the person started on when it is
 *  this deployment's own site, one of its subdomains or a local dev server,
 *  so a dev or staging tester returns to themselves; else the deployment's
 *  site. Whisk checks the return against its own list of allowed returns. */
export function whiskReturnBase(origin: string | undefined, site: string): string {
  if (!origin) return site;
  let url: URL;
  let home: URL;
  try {
    url = new URL(origin);
    home = new URL(site);
  } catch {
    return site;
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  const ours = url.protocol === "https:" && (url.hostname === home.hostname || url.hostname.endsWith(`.${home.hostname}`));
  return local || ours ? url.origin : site;
}

/** The link that opens a thread in this deployment's Whisk. */
export function whiskThreadLink(threadId: string, webUrl = whiskWebUrl()): string {
  return threadLinkAt(threadId, webUrl);
}
