// Vault values for the daemon's known-value redaction (knownValueRedaction.ts).
//
// Every value the user can read in the Vault, on every machine they run a
// daemon, so a secret echoed by a command or pasted into a prompt becomes
// `[redacted:known:<name>]` before the transcript syncs (docs/architecture/vault.md).
//
// The store's 60 s tick calls refresh(). That asks /cli/vault/redaction-version,
// a cheap query, and fetches /cli/vault/redaction-values only when the version
// moved. Values live in this closure and nowhere else: nothing here logs,
// persists or throws a value, and log lines name counts and HTTP statuses.
// A network failure keeps the last good set (a value stays redacted through an
// outage); a refused token clears it, since that user can no longer read them.

import type { KnownValue } from "../knownValueRedaction.js";

export type VaultRedactionDeps = {
  endpoint: () => { siteUrl: string; apiToken: string } | null;
  log?: (line: string) => void;
  fetch?: typeof fetch;
};

export type VaultRedactionSource = {
  values: () => KnownValue[];
  /** Resolves true when the held set changed. Overlapping calls share one poll. */
  refresh: () => Promise<boolean>;
};

class Refused extends Error {}

export function vaultRedactionSource(deps: VaultRedactionDeps): VaultRedactionSource {
  const doFetch = deps.fetch ?? fetch;
  let held: KnownValue[] = [];
  let version: string | null = null;
  let token: string | null = null;
  let inflight: Promise<boolean> | null = null;

  const post = async (siteUrl: string, apiToken: string, urlPath: string): Promise<any> => {
    const res = await doFetch(`${siteUrl}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw new Refused();
    const json = (await res.json().catch(() => null)) as any;
    if (/^Unauthorized/.test(String(json?.error ?? ""))) throw new Refused();
    if (!res.ok || !json || json.error) throw new Error(`HTTP ${res.status} from ${urlPath}`);
    return json;
  };

  const clear = (why: string): boolean => {
    const had = held.length > 0;
    held = [];
    version = null;
    if (had) deps.log?.(`[VAULT-REDACTION] cleared: ${why}`);
    return had;
  };

  const poll = async (): Promise<boolean> => {
    const ep = deps.endpoint();
    if (!ep) return clear("not signed in");
    // Another account's version string says nothing about this one's values.
    if (ep.apiToken !== token) { token = ep.apiToken; version = null; }
    try {
      const { version: current } = await post(ep.siteUrl, ep.apiToken, "/cli/vault/redaction-version");
      if (version !== null && current === version) return false;
      const got = await post(ep.siteUrl, ep.apiToken, "/cli/vault/redaction-values");
      const next: KnownValue[] = [];
      for (const v of got.values ?? []) {
        if (typeof v?.value === "string" && typeof v?.name === "string") next.push({ value: v.value, name: v.name });
      }
      held = next;
      version = String(got.version ?? current);
      deps.log?.(`[VAULT-REDACTION] ${next.length} values from ${new Set(next.map((v) => v.name)).size} secrets`);
      return true;
    } catch (e) {
      if (e instanceof Refused) return clear("token refused");
      deps.log?.(`[VAULT-REDACTION] poll failed, keeping ${held.length} values: ${(e as Error)?.message ?? e}`);
      return false;
    }
  };

  return {
    values: () => held,
    refresh: () => (inflight ??= poll().finally(() => { inflight = null; })),
  };
}
