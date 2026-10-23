// Vault values for the daemon's known-value redaction (knownValueRedaction.ts).
//
// Every value the user can read in the Vault, on every machine they run a
// daemon, so a secret echoed by a command or pasted into a prompt becomes
// `[redacted:known:<name>]` before the transcript syncs (docs/architecture/vault.md).
//
// The store's 60 s tick calls refresh(), and so does every `cast vault` read
// before it hands a value out (refreshDaemonRedaction). That asks
// /cli/vault/redaction-version, a cheap query, and fetches
// /cli/vault/redaction-values only when the version moved. Values live in this closure and nowhere else: nothing here logs,
// persists or throws a value, and log lines name counts and HTTP statuses.
// A network failure keeps the last good set (a value stays redacted through an
// outage); a refused token clears it, since that user can no longer read them.

import * as fs from "node:fs";
import { defaultConfigDir } from "../config/configDir.js";
import { readHookToken } from "../hookIdentity.js";
import type { KnownValue } from "../knownValueRedaction.js";
import { hookPortFile } from "../loopbackIdentity.js";

/** The daemon's loopback route that polls the Vault now (daemon.ts startHookServer); the hook token admits it. */
export const VAULT_REFRESH_PATH = "/hook/vault-refresh";

/**
 * Ask this machine's daemon to poll the Vault before a read hands a value out,
 * so a value stored or rotated within the last tick is already redacted when
 * the command's output reaches a transcript. It answers once the poll landed.
 * Best effort and bounded: with no daemon here nothing syncs a transcript.
 */
export async function refreshDaemonRedaction(configDir = defaultConfigDir(), timeoutMs = 5_000): Promise<void> {
  try {
    const port = parseInt(fs.readFileSync(hookPortFile(configDir), "utf-8").trim(), 10);
    const token = readHookToken(configDir);
    if (!(port > 0) || !token) return;
    await fetch(`http://127.0.0.1:${port}${VAULT_REFRESH_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* no daemon, or a slow one: the next tick covers it */ }
}

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
