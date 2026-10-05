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
//   ?<provider>=error&reason=<code>
//       The connector refused before it ever stored anything. Anyone can
//       write this link, so only a code the reason table knows is described;
//       anything else reads as the generic line.
//   ?<provider>=connected
//       A reconnect of an account already confirmed: nothing left to do.
//   ?success=true | ?error=<reason>
//       The GitHub App install return, which predates the connector protocol
//       and names no provider.
//
// The confirm token is a credential. Callers clear it from the URL as soon as
// they have read it (`strippedUrl` below), so a copied address bar or a shared
// screenshot cannot replay the confirmation.

import { APP_IDS, type AppId } from "@codecast/shared/contracts";
import { describeReturnReason } from "@codecast/shared/contracts/connectorReasons";

export type ConnectorReturn =
  /** A finished authorize waiting for this session to confirm it. */
  | { kind: "confirm"; provider: AppId; installationId: string; confirmToken: string }
  /** The connector refused. `reason` is a sentence that is safe to show:
   *  when it came from the URL, it is the table's words for a known code or
   *  the generic line, never text the link itself carried. */
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
      reason: describeReturnReason(query.get("reason")),
    };
  }

  const connected = toAppId([...query.entries()].find(([, v]) => v === "connected")?.[0]);
  if (connected) return { kind: "success", provider: connected };

  // The GitHub App install return, which names no provider of its own.
  if (query.get("success") === "true") return { kind: "success", provider: "github" };
  const githubError = query.get("error");
  if (githubError) return { kind: "error", provider: "github", reason: describeReturnReason(githubError) };

  return null;
}

/** The query key the mail and calendar connect (through Whisk) comes back
 *  with: /connect/whisk sends the browser to its lane page with
 *  `?whisk=connected`, or `?whisk=error&reason=<code>`. */
export const WHISK_RETURN_KEY = "whisk";

/**
 * Read a Whisk connect's outcome from a lane page's query. Like every
 * connector return, anyone can write the link, so an error's reason is the
 * table's sentence for a known code or the generic line, never the link's
 * own words. Null when the page was opened without one.
 */
export function parseWhiskReturn(search: string): { kind: "success" } | { kind: "error"; reason: string } | null {
  const query = params(search, "?");
  const outcome = query.get(WHISK_RETURN_KEY);
  if (outcome === "connected") return { kind: "success" };
  if (outcome === "error") return { kind: "error", reason: describeReturnReason(query.get("reason")) };
  return null;
}

/** The reason table lives in the shared contract so `cast integrations`
 *  describes a refusal in the same words as every web surface. */
export { describeConnectorError } from "@codecast/shared/contracts/connectorReasons";

/**
 * The same URL with every connector callback param removed, for the
 * replaceState that follows reading one. Query keys the page owns for other
 * reasons survive; only the callback's own keys go.
 */
export function strippedUrl(pathname: string, search: string, hash: string): string {
  const query = params(search, "?");
  for (const [key, value] of [...query.entries()]) {
    if (value === "pending" || value === "error" || value === "connected") query.delete(key);
  }
  for (const key of ["reason", "success", "error"]) query.delete(key);
  const frag = params(hash, "#");
  for (const key of ["installation", "confirm", "provider"]) frag.delete(key);
  const q = query.toString();
  const f = frag.toString();
  return pathname + (q ? `?${q}` : "") + (f ? `#${f}` : "");
}
