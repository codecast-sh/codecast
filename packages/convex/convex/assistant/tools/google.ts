// The one door the Gmail and Calendar tools call Google through. It asks the
// token getter (googleOAuth.googleAccessTokenForUser, bound to the
// conversation's owner) for a token that holds the scope the call needs,
// sends the request, and on a 401 refreshes once and tries again. The token
// lives only in the Authorization header: it never enters a tool's
// arguments, result, error or log line.
import { googleAccessTokenForUser, type GoogleTokenResult } from "../../googleOAuth";

/** How a call asks for a token: `force` refreshes it, and `stale` names the
 *  token Google just refused, so a shared cache refreshes once however many
 *  calls were refused together. */
export type GoogleTokenOptions = { force?: boolean; stale?: string };

/** What the Google tools need from the turn: a token for a scope, and fetch. */
export interface GoogleDeps {
  token: (scope: string, opts?: GoogleTokenOptions) => Promise<GoogleTokenResult>;
  /** Defaults to the global fetch; tests pass a fake. */
  fetch?: typeof fetch;
}

export type GoogleRequest = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  body?: unknown;
};

/** A URL with its query string; array values repeat the key, undefined ones drop. */
export function googleUrl(base: string, query: GoogleRequest["query"] = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(one));
  }
  return url.href;
}

/** The message a refused token turns into, said so the model can tell the person what to do. */
function tokenRefusal(result: Extract<GoogleTokenResult, { ok: false }>): string {
  if (result.code === "missing_scope") {
    return `Google is connected without this permission. Ask the person to allow ${result.grant ?? "it"} from Connections.`;
  }
  if (result.code === "not_connected") return "Google is not connected. Ask the person to connect Google from Connections.";
  if (result.code === "reconnect") return "The Google connection has expired. Ask the person to reconnect Google from Connections.";
  if (result.code === "not_configured") return "Google is not set up on this server.";
  return "Google is unavailable right now. Try again in a little while.";
}

/** Google's own error text, without anything that could echo a header. */
async function googleError(resp: Response): Promise<string> {
  let message = "";
  try {
    const body: any = await resp.json();
    message = typeof body?.error?.message === "string" ? body.error.message : typeof body?.error === "string" ? body.error : "";
  } catch {
    message = "";
  }
  return `Google answered ${resp.status}${message ? `: ${message.slice(0, 300)}` : ""}`;
}

/** One call to a Google API as the owner. Throws an Error whose message is
 *  safe to show the model; returns the parsed JSON (undefined for an empty body). */
export async function googleCall<T = any>(deps: GoogleDeps, scope: string, base: string, req: GoogleRequest = {}, signal?: AbortSignal): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const url = googleUrl(base, req.query);
  let refused: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await deps.token(scope, refused ? { force: true, stale: refused } : undefined);
    if (!token.ok) throw new Error(tokenRefusal(token));
    refused = token.access_token;
    const resp = await doFetch(url, {
      method: req.method ?? "GET",
      signal,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
    // A token Google no longer honours: refresh once, single flight, and retry.
    if (resp.status === 401 && attempt === 0) continue;
    if (!resp.ok) throw new Error(await googleError(resp));
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error("Google refused the connection's token. Ask the person to reconnect Google from Connections.");
}

/** Deps that ask for each scope's token once and share it across calls, so a
 *  search that reads 25 threads at once asks the token getter once. A refusal
 *  is not kept (the next call asks again); a forced refresh replaces the
 *  shared token unless another call already replaced the refused one. Build
 *  one per turn: a token outlives a turn but not a day. */
export function sharedTokens(deps: GoogleDeps): GoogleDeps {
  const tokens = new Map<string, Promise<GoogleTokenResult>>();
  const ask = (scope: string, opts?: GoogleTokenOptions) => {
    const pending = deps.token(scope, opts?.force ? { force: true } : undefined);
    tokens.set(scope, pending);
    const forget = () => tokens.get(scope) === pending && tokens.delete(scope);
    pending.then((t) => !t.ok && forget(), forget);
    return pending;
  };
  return {
    ...deps,
    token: async (scope, opts) => {
      const held = tokens.get(scope);
      if (!held) return ask(scope, opts);
      if (!opts?.force) return held;
      const current = await held.catch(() => undefined);
      // Someone already replaced the refused token: use theirs.
      if (current?.ok && current.access_token !== opts.stale) return current;
      const replaced = tokens.get(scope);
      return replaced && replaced !== held ? replaced : ask(scope, opts);
    },
  };
}

/** The deps for one owner, from inside the turn action. */
export function googleDepsFor(
  ctx: { runQuery: (ref: any, args: any) => Promise<any>; runMutation: (ref: any, args: any) => Promise<any> },
  userId: string,
): GoogleDeps {
  return { token: (scope, opts) => googleAccessTokenForUser(ctx, { user_id: userId, scope, ...(opts?.force ? { force: true } : {}) }) };
}
