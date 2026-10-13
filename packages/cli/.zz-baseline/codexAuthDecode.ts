/**
 * The auth.json identity decoder, a leaf: codexAccounts.ts
 * re-exports it for the accounts commands, and remote/agentAuth.ts reads it
 * directly so the agent logins bundle (on the daemon's and session-move's
 * static graph) does not drag the codex usage cluster along. Its one import
 * is the sign-in expiry rule, itself a leaf the web shares.
 */
import { signInExpired } from "@codecast/shared/contracts/cloudAgents";

/** Whether the login's access token has run out (a login with no expiry has not). */
export function codexAccessExpired(summary: Pick<CodexAuthSummary, "access_expires_at">, now = Date.now()): boolean {
  return signInExpired(summary.access_expires_at, now);
}

export interface CodexAuthSummary {
  email?: string;
  account_id?: string;
  plan?: string; // chatgpt_plan_type from the id_token ("pro", "plus", …)
  last_refresh?: number; // epoch ms of the last token rotation
  /** Real OAuth tokens present — an account worth snapshotting/probing.
   * API-key-only logins have no rotating grant and no per-account limits. */
  usable: boolean;
  /** Epoch ms the access token stops working (its `exp` claim). Codex
   * refreshes it on its own; a reader that never refreshes (the Codex Cloud
   * mirror) treats a past value as a signed-out machine. */
  access_expires_at?: number;
  /** Signed in with an API key (OPENAI_API_KEY), not a ChatGPT account: no tokens, no plan, no cloud tasks. */
  api_key?: true;
}

/** A JWT's claims, unverified: we only read our own machine's file for display metadata and expiry. */
export function jwtClaims(token: unknown): Record<string, any> | null {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return null;
  try {
    const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(pad, "base64url").toString("utf-8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null; // malformed token: identity stays partial
  }
}

/** Decode identity from an auth.json blob. The id_token is a JWT whose payload
 * carries the login email and ChatGPT plan; no verification needed — we only
 * ever read our own machine's file for display metadata. */
export function decodeCodexAuth(raw: string | null): CodexAuthSummary {
  if (!raw) return { usable: false };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { usable: false };
  }
  const tokens = parsed?.tokens;
  const summary: CodexAuthSummary = {
    usable: !!(tokens && (tokens.refresh_token || tokens.access_token)),
  };
  if (!summary.usable && typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY) summary.api_key = true;
  if (typeof tokens?.account_id === "string" && tokens.account_id) {
    summary.account_id = tokens.account_id;
  }
  const lastRefresh = Date.parse(parsed?.last_refresh ?? "");
  if (Number.isFinite(lastRefresh)) summary.last_refresh = lastRefresh;
  const claims = jwtClaims(tokens?.id_token);
  if (typeof claims?.email === "string" && claims.email) summary.email = claims.email;
  const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  if (typeof plan === "string" && plan) summary.plan = plan;
  const exp = jwtClaims(tokens?.access_token)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) summary.access_expires_at = exp * 1000;
  return summary;
}
