// The daemon's side of the team's shared account pool (convex/accountPool.ts).
//
// Each pass asks the server what this machine owes the pool and what the pool
// owes it. As a HOLDER (the machine that keeps a shared account's setup-token)
// it seals the token to every teammate machine that lacks a current copy, with
// the same ECDH transport provider keys use, so the server only ever stores
// ciphertext. As a DRAWER it opens the copies sealed to it and keeps each as a
// `pool-…` profile: an index entry plus the token file, and no saved login.
// That is exactly the shape a token-only profile already has, so the fleet
// store, pins and switches carry it with no new launch code (fleetBearer,
// switchModeFor). A copy the server stops returning (the contributor took the
// account back, or either person left the team) is removed here, and the fleet
// moves off it if it was on it.

import * as fs from "fs";
import {
  accountTokenFilePath,
  accountTokenInfo,
  assertValidProfileName,
  invalidateAccountsCache,
  readAccountTokenValue,
  readProfileIndex,
  clearLaunchProfile,
  describeFleetWrite,
  fleetStoreEnabled,
  fleetStatePath,
  fleetStoreDir,
  moveFleetToFallback,
  profileStoreKeychainService,
  readFleetState,
  readLaunchRecord,
  removeAccountToken,
  storeCredentialFile,
  useFileStore,
  writeAccountToken,
  writeProfileIndex,
} from "./ccAccounts.js";
import { decryptProviderKeyPayload, encryptProviderKey } from "./providerKeyCrypto.js";
import { execFileAsync } from "./proc.js";

/** The label sealed copies carry (the transport's `provider` field). */
export const POOL_SEAL_LABEL = "claude-pool";
/** How often the daemon runs a pass. A take-back reaches a machine within one. */
export const POOL_PASS_INTERVAL_MS = 30_000;

type Sealed = { provider: string; epk: string; iv: string; ct: string };

export interface PoolState {
  seal: Array<{ share_id: string; email: string; targets: Array<{ device_id: string; pubkey: string; token_stored_at: number | null }> }>;
  copies: Array<{
    share_id: string;
    email: string;
    name: string;
    contributor_name: string;
    tier?: string;
    subscription?: string;
    token_stored_at: number;
    sealed: Sealed;
  }>;
}

export interface PoolBackend {
  state(): Promise<PoolState | null>;
  store(shareId: string, tokenStoredAt: number, copies: Array<{ device_id: string; sealed: Sealed }>): Promise<unknown>;
}

const sameAccount = (a: string | undefined, b: string) => !!a && a.trim().toLowerCase() === b;

/** The machine's own saved profile for an account (never a pool copy). */
export function ownProfileFor(email: string): string | undefined {
  return Object.entries(readProfileIndex().profiles).find(([, m]) => !m.pool_share_id && sameAccount(m.email, email))?.[0];
}

/** The pool copies kept on this machine, by share. */
export function installedPoolProfiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, meta] of Object.entries(readProfileIndex().profiles)) {
    if (meta.pool_share_id) out.set(meta.pool_share_id, name);
  }
  return out;
}

/** When a token file was stored, to the millisecond (its lifetime clock). */
const storedAt = (name: string): number | null => {
  const info = accountTokenInfo(name);
  return info ? Math.floor(info.stored_at) : null;
};

/** A copy is current when its file carries the holder's store time (to the second: filesystems round mtimes). */
const sameStoreTime = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1000;

/** A free profile name for a copy: the server's suggestion, suffixed when another profile already has it. */
function freeName(base: string, shareId: string): string {
  const profiles = readProfileIndex().profiles;
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base.slice(0, 38)}-${i}`;
    const taken = profiles[name];
    if (!taken || taken.pool_share_id === shareId) {
      assertValidProfileName(name);
      return name;
    }
  }
  throw new Error(`no free profile name for ${base}`);
}

/** Keep a pool copy as a token-only profile. The token file's mtime is set to
 *  the holder's store time, so the copy's one-year lifetime is the token's. */
export function installPoolCopy(copy: PoolState["copies"][number], token: string, now = Date.now()): string {
  const name = freeName(installedPoolProfiles().get(copy.share_id) ?? copy.name, copy.share_id);
  // The token first: an index entry with no token behind it is a profile the
  // fleet could pick and fail to carry.
  writeAccountToken(name, token);
  const stamp = new Date(copy.token_stored_at);
  fs.utimesSync(accountTokenFilePath(name), stamp, stamp);
  const index = readProfileIndex();
  index.profiles[name] = {
    email: copy.email,
    ...(copy.tier ? { tier: copy.tier } : {}),
    ...(copy.subscription ? { subscription: copy.subscription } : {}),
    saved_at: now,
    pool_share_id: copy.share_id,
    pool_contributor: copy.contributor_name,
  };
  writeProfileIndex(index);
  invalidateAccountsCache();
  return name;
}

/**
 * Move the fleet off a profile that is going away (a pool copy taken back),
 * before its credential is deleted: onto the best other account, else empty
 * the store, so no session keeps running on an account this machine may no
 * longer use. Sessions on an emptied store park on auth, which the server's
 * recovery sees. Returns what it did, or null when the fleet was elsewhere.
 */
export async function vacateFleetStore(name: string, now = Date.now()): Promise<string | null> {
  if (readFleetState()?.profile !== name) return null;
  const state = await moveFleetToFallback(name, now);
  if (state) return `moved the ${describeFleetWrite(state)}`;
  const dir = fleetStoreDir();
  if (useFileStore()) {
    try { fs.rmSync(storeCredentialFile(dir), { force: true }); } catch {}
  } else {
    await execFileAsync("/usr/bin/security", ["delete-generic-password", "-s", profileStoreKeychainService(dir)], { encoding: "utf-8", timeout: 30_000 }).catch(() => {});
  }
  try { fs.rmSync(fleetStatePath(), { force: true }); } catch {}
  if (readLaunchRecord()?.profile === name) clearLaunchProfile();
  invalidateAccountsCache();
  return "emptied the fleet store: no other account here can carry it";
}

/** Drop a pool copy: its token, its index entry, and the fleet off it. */
export async function removePoolProfile(name: string, now = Date.now()): Promise<string | null> {
  // The fleet leaves first, while the profile still names its account.
  const moved = await vacateFleetStore(name, now);
  removeAccountToken(name);
  const index = readProfileIndex();
  delete index.profiles[name];
  writeProfileIndex(index);
  invalidateAccountsCache();
  return moved;
}

/** One pass. Returns what it did, one line each, for the daemon log. */
export async function runPoolPass(backend: PoolBackend, configDir: string, now = Date.now()): Promise<string[]> {
  const state = await backend.state();
  if (!state) return [];
  const done: string[] = [];

  for (const share of state.seal) {
    const own = ownProfileFor(share.email);
    const token = own ? readAccountTokenValue(own) : null;
    const at = own ? storedAt(own) : null;
    if (!own || !token || at === null) {
      done.push(`cannot share ${share.email}: no live setup-token on this machine`);
      continue;
    }
    const stale = share.targets.filter((t) => !sameStoreTime(t.token_stored_at, at));
    if (stale.length === 0) continue;
    const copies = stale.map((t) => ({ device_id: t.device_id, sealed: encryptProviderKey(t.pubkey, POOL_SEAL_LABEL, token) }));
    await backend.store(share.share_id, at, copies);
    done.push(`sealed ${share.email} for ${stale.length} machine(s)`);
  }

  const installed = installedPoolProfiles();
  const wanted = new Set<string>();
  for (const copy of state.copies) {
    wanted.add(copy.share_id);
    const have = installed.get(copy.share_id);
    if (have && sameStoreTime(storedAt(have), copy.token_stored_at)) continue;
    let token: string;
    try {
      token = decryptProviderKeyPayload(configDir, copy.sealed);
    } catch {
      // Sealed to a key this machine no longer has (a reinstall): the holder
      // reseals once the heartbeat publishes the new key.
      done.push(`cannot open the copy of ${copy.email}: sealed to an older key of this machine`);
      continue;
    }
    const name = installPoolCopy(copy, token, now);
    done.push(`${have ? "refreshed" : "added"} ${name} (${copy.email}, from ${copy.contributor_name})`);
  }
  for (const [shareId, name] of installed) {
    if (wanted.has(shareId)) continue;
    const moved = await removePoolProfile(name, now);
    done.push(`removed ${name}: no longer in the pool${moved ? `; ${moved}` : ""}`);
  }
  return done;
}

/** The pass on the daemon's clock, against the signed-in backend. Only a
 *  machine on the fleet store takes part: a pool copy carries sessions only
 *  there (a take-back can empty it), so a remote or a machine with the fleet
 *  turned off neither holds copies nor draws. */
export function startPoolPasses(opts: {
  client: () => { query(name: any, args: any): Promise<any>; mutation(name: any, args: any, o?: any): Promise<any> } | null;
  token: () => string | undefined;
  deviceId: string;
  configDir: string;
  log: (line: string) => void;
}): ReturnType<typeof setInterval> | null {
  if (!fleetStoreEnabled()) return null;
  let running = false;
  const backend: PoolBackend = {
    state: async () => {
      const client = opts.client();
      const token = opts.token();
      if (!client || !token) return null;
      return client.query("accountPool:poolForDevice", { api_token: token, device_id: opts.deviceId });
    },
    store: async (shareId, tokenStoredAt, copies) => {
      const client = opts.client();
      if (!client) return null;
      return client.mutation("accountPool:storePoolCopies", { api_token: opts.token(), device_id: opts.deviceId, share_id: shareId, token_stored_at: tokenStoredAt, copies }, { skipQueue: true });
    },
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const line of await runPoolPass(backend, opts.configDir)) opts.log(`[ACCOUNT-POOL] ${line}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A backend without the pool functions yet answers "Could not find": quiet.
      if (!/Could not find/.test(message)) opts.log(`[ACCOUNT-POOL] pass failed: ${message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 15_000);
  return setInterval(() => void tick(), POOL_PASS_INTERVAL_MS);
}
