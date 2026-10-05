// Whisk (whisk.email, ~/src/mail) is the product family's mail and calendar
// engine (docs/architecture/hosted-assistant.md, "Mail and calendar go
// through Whisk"). Codecast never holds a Gmail or Calendar token: the person
// connects codecast to Whisk once, Whisk mints a revocable app token, and
// codecast calls the same Convex functions the `whisk` CLI calls with it.
//
// This module is the leaf both halves read: the deployment's Whisk settings,
// what an app token's scopes let the assistant do, the link that opens a
// thread in Whisk, and the one door every call goes through (whiskHttpCall).
// It imports nothing from the generated api, so the connect module
// (convex/whisk.ts) and the assistant's tools can both load it alone.

/** The app id codecast is registered under in Whisk (its lib/apps.ts). */
export const WHISK_APP_ID = "codecast";

/** The `app_installations` provider a person's Whisk connection is stored under. */
export const WHISK_PROVIDER = "whisk";

/** The codecast page Whisk returns to with its one-time code. Whisk allows
 *  exactly this path on codecast.sh (plus WHISK_APP_RETURN_URLS_CODECAST on
 *  its side for a local or staging codecast). */
export const WHISK_RETURN_PATH = "/connect/whisk";

/** The default web home of Whisk, where its links open. */
export const WHISK_WEB_URL = "https://whisk.email";

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

/** The link that opens a thread in Whisk, the format `whisk link` prints. */
export function whiskThreadLink(threadId: string, webUrl = whiskWebUrl()): string {
  return `${webUrl}/#t/${encodeURIComponent(threadId.trim())}`;
}

// ── What a grant allows ─────────────────────────────────────────────────────

/** What the assistant may do with the person's mail and calendar. The
 *  Connections screen and the tools read the same answer. */
export type MailAbilities = { read_mail: boolean; modify_mail: boolean; send_mail: boolean; calendar: boolean };

/**
 * The abilities an app token's scopes give (Whisk lib/apps.ts APP_SCOPES).
 * Drafting needs `mail.read` too, since Whisk drafts from the thread's text
 * (its DRAFT_FROM_THREAD), and the mail tools that change mail (draft,
 * archive, label) come as one set, so modify needs draft and organize. The
 * calendar tools read and write as one set too.
 */
export function whiskAbilities(scopes: readonly string[]): MailAbilities {
  const has = (scope: string) => scopes.includes(scope);
  const read_mail = has("mail.read");
  return {
    read_mail,
    modify_mail: read_mail && has("mail.draft") && has("mail.organize"),
    send_mail: read_mail && has("mail.send"),
    calendar: has("calendar.read") && has("calendar.write"),
  };
}

// ── Calling Whisk ───────────────────────────────────────────────────────────

/** One call to a Whisk Convex function, as the connected person. `path` is
 *  the function's Convex path ("sync:getAccount", "ai/actions:draftReply");
 *  the token is added by the caller, never passed in `args`. */
export type WhiskCall = <T = any>(
  kind: "query" | "mutation" | "action",
  path: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

/** The sentence a Whisk function threw, without Convex's wrapping (the rule
 *  Whisk's own serverErrorMessage follows). */
export function whiskThrown(raw: string): string {
  const uncaught = raw.match(/Uncaught \w*Error: ([^\n]+)/);
  return (uncaught ? uncaught[1] : raw.split("\n")[0]).trim();
}

/** A Whisk refusal in words the assistant can pass on. Whisk refuses a
 *  revoked or unknown token, and a call outside the token's scopes, as
 *  "Unauthorized: unknown token"; a person with no mailbox left as "no
 *  connected accounts". Anything else is Whisk's own sentence. */
export function whiskRefusal(message: string): string {
  if (/^Unauthorized: (unknown|missing) token/i.test(message)) {
    return "Whisk no longer accepts this connection. Ask the person to connect mail and calendar again from Connections.";
  }
  if (/no connected accounts/i.test(message)) {
    return "No mailbox is connected in Whisk. Ask the person to add one in Whisk (whisk.email), then try again.";
  }
  return message;
}

/**
 * The real door: Convex's HTTP API on Whisk's deployment (POST
 * /api/<kind> with the function path and its args), with the person's app
 * token added to every call. The token travels only in the request body to
 * Whisk; it never enters a result, an error or a log line. Every error is a
 * sentence safe to show the model.
 */
export function whiskHttpCall(convexUrl: string, token: string, fetchImpl: typeof fetch = fetch): WhiskCall {
  return async (kind, path, args, signal) => {
    let resp: Response;
    try {
      resp = await fetchImpl(`${convexUrl}/api/${kind}`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, args: { ...args, token }, format: "json" }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Whisk could not be reached. Try again in a little while.");
    }
    let body: any;
    try {
      body = await resp.json();
    } catch {
      throw new Error(`Whisk answered ${resp.status}. Try again in a little while.`);
    }
    if (body?.status === "success") return body.value;
    const message = typeof body?.errorMessage === "string" ? whiskThrown(body.errorMessage) : `Whisk answered ${resp.status}`;
    throw new Error(whiskRefusal(message));
  };
}
