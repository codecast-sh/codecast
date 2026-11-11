// Slack OAuth: the scopes an install asks for, the URLs it travels through,
// and the signed state that binds it to the person who started it. Pure
// helpers; the install flow itself lives in slack.ts.

import { tokenHasScope } from "./slackMirror";
import { signStateWith, verifyStateWith } from "./hmac";
import { webOrigins } from "./siteUrl";

// Everything the anchor needs plus everything channel mirroring needs
// (slackSync): read history both ways, post with a per-line name and face,
// join public channels, react, read files and match people by email.
export const BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "chat:write.customize",
  "im:history",
  "channels:read",
  "channels:history",
  "channels:join",
  // Invite and remove people from a mirrored channel (the room's member panel).
  "channels:manage",
  "groups:write",
  "groups:read",
  "groups:history",
  "users:read",
  "users:read.email",
  "reactions:read",
  "reactions:write",
  "files:read",
  "team:read",
].join(",");

// What a PERSON grants for themselves alongside the bot install: enough to
// list the private channels they are in and invite the bot into one. No
// history, no posting: their token never reads or writes a message.
export const USER_SCOPES = [
  "channels:read", "groups:read", "groups:write", "users:read",
  // Their own direct messages, read and written as them (slackSync DMs),
  // with the images shared in them.
  "im:read", "im:history", "mpim:read", "mpim:history", "chat:write", "files:read",
  // Their reactions, shown in Slack under their own name.
  "reactions:write",
].join(",");
/** The scopes a token needs before a person's DMs can come over. */
export const DM_SCOPES = ["im:read", "im:history", "mpim:read", "mpim:history", "chat:write", "files:read"];
export function tokenHasDmScopes(scopes: string | undefined | null): boolean {
  return DM_SCOPES.every((s) => tokenHasScope(scopes, s));
}

/** Can this person's own token post a message as them? */
export { tokenCanPost } from "./slackMirror";

export function convexSiteUrl(): string {
  return process.env.SLACK_REDIRECT_BASE || process.env.CONVEX_SITE_URL || "https://convex.codecast.sh";
}

export function webBaseUrl(): string {
  return process.env.SITE_URL || "https://codecast.sh";
}

// Slack redirects back to the AUTHENTICATED web app (not the Convex callback), so
// completion runs in the user's logged-in session and the install binds to the
// completer's own scope — a relayed state can't bind a victim's workspace to the
// relayer's team. This URI must match exactly between authorize and exchange.
// One page completes every install (anchor, chat mirror) and then returns the
// person to wherever they started (`return_to` in the signed state).
export function slackRedirectUri(origin?: string): string {
  return `${allowedWebOrigin(origin)}/slack/connect`;
}

// The web origins an install may return to. Each must also be registered as a
// redirect URL on the Slack app. Production plus the two local dev origins, so
// a mirror can be exercised from a dev web against the shared backend.
export function allowedWebOrigin(origin?: string): string {
  return origin && webOrigins().has(origin) ? origin : webBaseUrl();
}

export function slackAuthorizeUrl(state: string, origin?: string): string {
  const clientId = process.env.SLACK_CLIENT_ID || "";
  return (
    `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(BOT_SCOPES)}` +
    `&user_scope=${encodeURIComponent(USER_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(slackRedirectUri(origin))}` +
    `&state=${encodeURIComponent(state)}`
  );
}

// ── OAuth state signing (CSRF + binding integrity) ──────────────────────────
// The install `state` names which codecast anchor/user the install binds to, so
// it must be tamper-proof: sign it with the app secret and check freshness on the
// callback. Without this, a forged state could bind someone's workspace to the
// attacker's anchor.
export function signState(payload: Record<string, unknown>): Promise<string> {
  return signStateWith(process.env.SLACK_CLIENT_SECRET || "", payload);
}

/** Ten minutes matches the lifetime of the code Slack hands back, so a slow
 *  consent screen does not fail the install, while the leaked-state window
 *  stays small. */
export function verifyState(state: string): Promise<Record<string, any> | null> {
  return verifyStateWith(process.env.SLACK_CLIENT_SECRET || "", state, 10 * 60_000);
}
