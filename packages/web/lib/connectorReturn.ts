// What an OAuth/App-install callback left in the URL when it landed back on
// /settings/integrations, read once and turned into something the page can act
// on. Pure — no React, no store, no window — so the parsing rules are testable
// on their own (lib/__tests__/connectorReturn.test.ts).
//
// Three shapes reach this page, all written by connectors that already exist:
//
//   ?<provider>=pending#installation=<id>&confirm=<token>&provider=<id>
//       The two-phase confirm. The redirect lands in SOME browser; only the
//       signed-in session that started the flow may finish it, so the token
//       rides the FRAGMENT (never sent to a server) and the page trades it for
//       a confirmed connection via confirmConnection. googleOAuth.ts omits the
//       fragment's `provider`, so the search key carries it there.
//   ?<provider>=error&reason=<text>
//       The connector refused before it ever stored anything.
//   ?success=true | ?error=missing_team|installation_failed
//       The GitHub App install return, which predates the connector protocol
//       and names no provider.
//
// The confirm token is a credential. Callers clear it from the URL as soon as
// they have read it (`strippedUrl` below), so a copied address bar or a shared
// screenshot cannot replay the confirmation.

import { APP_IDS, type AppId } from "@codecast/shared/contracts";

export type ConnectorReturn =
  /** A finished authorize waiting for this session to confirm it. */
  | { kind: "confirm"; provider: AppId; installationId: string; confirmToken: string }
  /** The connector refused. `reason` is its own words, shown verbatim. */
  | { kind: "error"; provider: AppId | null; reason: string }
  /** A connect flow that completed server-side with nothing left to do. */
  | { kind: "success"; provider: AppId };

/** Provider ids as they appear in a callback URL, mapped to our app ids.
 *  Google's connector writes `google`; the app it connects is Gmail. */
const URL_PROVIDER_ALIASES: Record<string, AppId> = { google: "gmail" };

function toAppId(raw: string | null | undefined): AppId | null {
  if (!raw) return null;
  const aliased = URL_PROVIDER_ALIASES[raw];
  if (aliased) return aliased;
  return (APP_IDS as readonly string[]).includes(raw) ? (raw as AppId) : null;
}

/** Accepts a full hash/search with or without its leading "#"/"?". */
function params(raw: string | null | undefined, lead: "#" | "?"): URLSearchParams {
  const s = raw ?? "";
  return new URLSearchParams(s.startsWith(lead) ? s.slice(1) : s);
}

/**
 * Read the connector callback out of `hash` and `search`. Returns null when
 * the URL carries no callback at all — the ordinary case of opening the page.
 */
export function parseConnectorReturn(hash: string, search: string): ConnectorReturn | null {
  const frag = params(hash, "#");
  const query = params(search, "?");

  const installationId = frag.get("installation");
  const confirmToken = frag.get("confirm");
  if (installationId && confirmToken) {
    // The fragment names the provider (oauthConnectors); when it does not
    // (googleOAuth), the `?<provider>=pending` key does.
    const provider =
      toAppId(frag.get("provider")) ??
      toAppId([...query.entries()].find(([, v]) => v === "pending")?.[0]);
    // A confirm token with no resolvable provider names no action to take —
    // guessing one would confirm the wrong connection.
    if (provider) return { kind: "confirm", provider, installationId, confirmToken };
  }

  const errored = [...query.entries()].find(([, v]) => v === "error");
  if (errored) {
    return {
      kind: "error",
      provider: toAppId(errored[0]),
      reason: query.get("reason") || "The connection was refused",
    };
  }

  // The GitHub App install return, which names no provider of its own.
  if (query.get("success") === "true") return { kind: "success", provider: "github" };
  const githubError = query.get("error");
  if (githubError) return { kind: "error", provider: "github", reason: githubError };

  return null;
}

/** Plain words for the reasons our own connectors write; anything else is the
 *  connector's own text, which is already a sentence. */
const KNOWN_REASONS: Record<string, string> = {
  missing_team: "You must be on a team to install the GitHub App — create or join one first.",
  installation_failed: "GitHub could not complete the install. Try again.",
  denied: "You declined the authorization.",
  bad_state: "The sign-in link expired before it came back. Start the connection again.",
  expired: "The confirmation link expired. Start the connection again.",
  no_such_installation: "That connection no longer exists. Start it again.",
};

export function describeConnectorError(reason: string): string {
  return KNOWN_REASONS[reason] ?? reason;
}

/**
 * The same URL with every connector callback param removed, for the
 * replaceState that follows reading one. Query keys the page owns for other
 * reasons survive; only the callback's own keys go.
 */
export function strippedUrl(pathname: string, search: string, hash: string): string {
  const query = params(search, "?");
  for (const [key, value] of [...query.entries()]) {
    if (value === "pending" || value === "error") query.delete(key);
  }
  for (const key of ["reason", "success", "error"]) query.delete(key);
  const frag = params(hash, "#");
  for (const key of ["installation", "confirm", "provider"]) frag.delete(key);
  const q = query.toString();
  const f = frag.toString();
  return pathname + (q ? `?${q}` : "") + (f ? `#${f}` : "");
}
