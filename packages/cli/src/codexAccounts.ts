// Codex (ChatGPT) account profiles — the OpenAI mirror of ccAccounts.ts, built
// on the same concepts so the whole pipeline (auto-enroll, resnapshot, usage
// cache, mtime-keyed heartbeat payload) stays one shared shape end-to-end.
//
// A Codex "account" is ONE artifact: ~/.codex/auth.json (auth mode + OAuth
// access/refresh/id tokens + account_id). Codex itself stores it as a plain
// 0600 file, so profiles live where the client's own secret lives: a snapshot
// dir per profile (~/.codecast/codex-accounts/<name>/auth.json). That dir
// doubles as a probe target — `codex app-server` honors CODEX_HOME, so
// `account/rateLimits/read` against a snapshot dir returns THAT account's
// limits without touching the live login (verified empirically, jx77vhq).
//
// Token-rotation rules, mirrored from the Claude side:
//   - The ACTIVE account is only ever probed via the real ~/.codex. A probe
//     can refresh tokens; refreshing a COPY of the live grant would rotate the
//     refresh token out from under the login.
//   - DORMANT profiles are only probed via their snapshot dir. A refresh there
//     rewrites the snapshot in place — which is correct: the snapshot is that
//     account's only credential holder, so it stays fresh by construction.
//   - save-on-fresher: whenever the live auth.json is newer than the saved
//     profile covering it (a re-login or codex's own refresh), re-snapshot.

import * as fs from "fs";
import * as path from "path";
import { createMtimeGatedCache, deriveProfileName, isLegacyDerivedName } from "./ccAccounts.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { readProfileIndexFile } from "./readForUpdate.js";
import {
  codexHome,
  collectCodexUsageSnapshot,
  fetchRateLimitsViaAppServer,
  parseRateLimitsReadResult,
  type CodexUsageSnapshot,
} from "./codexUsage.js";
import { defaultConfigDir } from "./config/configDir.js";
import {
  fetchCodexBackendUsage,
  mergeCodexUsage,
  nextUsageRetry,
  type UsageRetryState,
} from "./codexBackendUsage.js";

export class CodexAccountError extends Error {}

function profilesRoot(): string {
  return path.join(defaultConfigDir(), "codex-accounts");
}

export function profileDir(name: string): string {
  return path.join(profilesRoot(), name);
}

function indexPath(): string {
  return path.join(defaultConfigDir(), "codex-accounts.json");
}

function usageCachePath(): string {
  return path.join(defaultConfigDir(), "codex-usage-accounts.json");
}

function activeAuthPath(): string {
  return path.join(codexHome(), "auth.json");
}

// ---------------------------------------------------------------------------
// auth.json identity (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface CodexAuthSummary {
  email?: string;
  account_id?: string;
  plan?: string; // chatgpt_plan_type from the id_token ("pro", "plus", …)
  last_refresh?: number; // epoch ms of the last token rotation
  /** Real OAuth tokens present — an account worth snapshotting/probing.
   * API-key-only logins have no rotating grant and no per-account limits. */
  usable: boolean;
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
  if (typeof tokens?.account_id === "string" && tokens.account_id) {
    summary.account_id = tokens.account_id;
  }
  const lastRefresh = Date.parse(parsed?.last_refresh ?? "");
  if (Number.isFinite(lastRefresh)) summary.last_refresh = lastRefresh;
  const idToken = tokens?.id_token;
  if (typeof idToken === "string") {
    const payload = idToken.split(".")[1];
    if (payload) {
      try {
        const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const claims = JSON.parse(Buffer.from(pad, "base64url").toString("utf-8"));
        if (typeof claims?.email === "string" && claims.email) summary.email = claims.email;
        const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
        if (typeof plan === "string" && plan) summary.plan = plan;
      } catch {
        /* malformed token — identity stays partial */
      }
    }
  }
  return summary;
}

export function readActiveCodexAuth(): string | null {
  try {
    return fs.readFileSync(activeAuthPath(), "utf-8");
  } catch {
    return null;
  }
}

export function activeCodexSummary(): CodexAuthSummary {
  return decodeCodexAuth(readActiveCodexAuth());
}

// ---------------------------------------------------------------------------
// Non-secret index + profile snapshots
// ---------------------------------------------------------------------------

export interface CodexProfileMeta {
  email?: string;
  account_id?: string;
  plan?: string;
  saved_at?: number;
}

interface ProfileIndex {
  profiles: Record<string, CodexProfileMeta>;
}

export function readProfileIndex(): ProfileIndex {
  return readProfileIndexFile<CodexProfileMeta>(
    indexPath(),
    (message) => new CodexAccountError(message),
  );
}

function writeProfileIndex(index: ProfileIndex): void {
  atomicWriteFile(indexPath(), JSON.stringify(index, null, 2), { mode: 0o644 });
}

// Same charset rule as Claude profiles — names land in dir names and commands.
const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

/** Snapshot the active login into a named profile dir. Refuses unusable blobs
 * (API-key-only or logged out) so a bad save can't poison a good profile. */
export function saveCodexProfile(name: string): CodexProfileMeta & { name: string } {
  if (!VALID_PROFILE_NAME.test(name)) {
    throw new CodexAccountError(`Invalid profile name "${name}"`);
  }
  const raw = readActiveCodexAuth();
  const summary = decodeCodexAuth(raw);
  if (!raw || !summary.usable) {
    throw new CodexAccountError(
      "No usable Codex login found — run `codex login` first (API-key logins have no account to save)",
    );
  }
  // No mkdir: the writer creates the directory, and derives 0700 from the 0600
  // it is asked for. Stating the directory mode here too would be a second place
  // to change if auth.json's mode ever moves, which is how the two drift apart.
  const dir = profileDir(name);
  atomicWriteFile(path.join(dir, "auth.json"), raw, { mode: 0o600 });
  const meta: CodexProfileMeta = {
    email: summary.email,
    account_id: summary.account_id,
    plan: summary.plan,
    saved_at: Date.now(),
  };
  const index = readProfileIndex();
  index.profiles[name] = meta;
  writeProfileIndex(index);
  invalidateCodexAccountsCache();
  return { name, ...meta };
}

export function readProfileAuth(name: string): string | null {
  try {
    return fs.readFileSync(path.join(profileDir(name), "auth.json"), "utf-8");
  } catch {
    return null;
  }
}

/** One account, resolved to everything a per-account backend call needs. */
export interface CodexAccountTarget {
  /** Machine-local profile name; undefined when the active login is not
   *  enrolled yet (a fresh `codex login` before the daemon's auto-save). */
  name?: string;
  /** Account identity — account_id, email fallback. The key the usage cache and
   *  the reset-credit ledger both use, because a profile name can be renamed
   *  and the account cannot. */
  account: string;
  email?: string;
  /** The CODEX_HOME whose auth.json speaks for this account: the real ~/.codex
   *  for the active login, that profile's snapshot dir for a dormant one — the
   *  same seam every other per-account probe uses, and never the other way
   *  round (a snapshot of the live grant goes stale the moment codex rotates). */
  home: string;
  active: boolean;
  usage?: CodexUsageSnapshot;
}

/**
 * Resolve `name` (a saved profile) or, with no name, the account this machine
 * is currently logged into. Throws CodexAccountError when there is no such
 * account or no usable login behind it.
 */
export function resolveCodexAccount(name?: string): CodexAccountTarget {
  const active = activeCodexSummary();
  const index = readProfileIndex();
  const usage = readUsageCache().accounts;
  const isActive = (meta: CodexProfileMeta): boolean =>
    !!((active.account_id && meta.account_id === active.account_id) ||
      (active.email && meta.email === active.email));

  if (name) {
    const meta = index.profiles[name];
    if (!meta) throw new CodexAccountError(`No saved Codex profile "${name}"`);
    const account = meta.account_id || meta.email;
    if (!account) throw new CodexAccountError(`Profile "${name}" has no account identity`);
    const activeHere = isActive(meta);
    return {
      name,
      account,
      email: meta.email,
      home: activeHere ? codexHome() : profileDir(name),
      active: activeHere,
      usage: usage[account],
    };
  }

  if (!active.usable) throw new CodexAccountError("No Codex account is signed in here (run `codex login`)");
  const account = active.account_id || active.email;
  if (!account) throw new CodexAccountError("The active Codex login carries no account identity");
  return {
    name: Object.entries(index.profiles).find(([, meta]) => isActive(meta))?.[0],
    account,
    email: active.email,
    home: codexHome(),
    active: true,
    usage: usage[account],
  };
}

/** The saved profile covering a login, matched by account_id with email as the
 * fallback. One predicate, because "is this account already saved", "which
 * profile do I re-snapshot into" and "which account is this pane on" are the
 * same question asked three times. */
function profileCovering(
  index: ProfileIndex,
  summary: CodexAuthSummary,
): [string, CodexProfileMeta] | undefined {
  if (!summary.usable || (!summary.account_id && !summary.email)) return undefined;
  return Object.entries(index.profiles).find(
    ([, meta]) =>
      (summary.account_id && meta.account_id === summary.account_id) ||
      (summary.email && meta.email === summary.email),
  );
}

/** The saved profile covering the machine's CURRENT ~/.codex login — the name a
 * pane launched right now records, and the one every live pane is compared
 * against. Undefined when the login is unusable or not enrolled yet: a switch
 * we cannot name must order no restarts. */
export function activeCodexProfileName(): string | undefined {
  return profileCovering(readProfileIndex(), activeCodexSummary())?.[0];
}

/** Enroll the active login as a profile iff none covers it yet (matched by
 * account_id, email fallback) — the daemon calls this so `codex login` is the
 * only manual step, ever. Mirrors autoSaveActiveProfile. */
export function autoSaveActiveCodexProfile(): (CodexProfileMeta & { name: string }) | null {
  const active = activeCodexSummary();
  if (!active.usable || (!active.account_id && !active.email)) return null;
  const index = readProfileIndex();
  if (profileCovering(index, active)) return null;
  return saveCodexProfile(deriveProfileName(active.email, Object.keys(index.profiles)));
}

/** Codex twin of ccAccounts' migrateLegacyProfileNames: rename profiles still
 * carrying the old auto-derived form (email domain's org part) to the current
 * derivation (the local part). A profile is a directory, so the snapshot moves
 * with one rename. Returns the renames performed. */
export function migrateLegacyCodexProfileNames(): Array<{ from: string; to: string }> {
  const index = readProfileIndex();
  const renames: Array<{ from: string; to: string }> = [];
  for (const [name, meta] of Object.entries(index.profiles)) {
    if (!isLegacyDerivedName(name, meta.email)) continue;
    const desired = deriveProfileName(
      meta.email,
      Object.keys(index.profiles).filter((n) => n !== name),
    );
    if (desired === name) continue;
    try {
      fs.renameSync(profileDir(name), profileDir(desired));
    } catch {
      continue; // snapshot dir missing or target blocked — leave the row as-is
    }
    index.profiles[desired] = meta;
    delete index.profiles[name];
    renames.push({ from: name, to: desired });
  }
  if (renames.length) {
    writeProfileIndex(index);
    invalidateCodexAccountsCache();
  }
  return renames;
}

/** Re-snapshot the active login into the profile covering it whenever the live
 * auth.json rotated past the stored copy (compared by last_refresh, mtime as
 * tiebreak-free fallback). Cheap no-op when already in step. */
export function resnapshotIfActiveCodexFresher(): string | null {
  const raw = readActiveCodexAuth();
  const active = decodeCodexAuth(raw);
  if (!raw) return null;
  const match = profileCovering(readProfileIndex(), active);
  if (!match) return null;
  const [name] = match;
  const stored = decodeCodexAuth(readProfileAuth(name));
  if ((active.last_refresh ?? 0) <= (stored.last_refresh ?? 0)) return null;
  try {
    saveCodexProfile(name);
    return name;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-account usage snapshots
// ---------------------------------------------------------------------------

interface UsageCache {
  // Keyed by account_id (email fallback) — same identity the index carries.
  accounts: Record<string, CodexUsageSnapshot>;
  // When each account's ChatGPT-backend supplement may be asked again after a
  // refusal, same keys. Kept beside the snapshots rather than inside one
  // because the heartbeat payload sends a snapshot to Convex through a closed
  // validator: a snapshot carrying an extra field would have the whole account
  // inventory rejected. So this stays local, and only this file reads it.
  backend_retries?: Record<string, UsageRetryState>;
}

export function readUsageCache(): UsageCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCachePath(), "utf-8"));
    if (parsed && typeof parsed.accounts === "object") {
      if (!parsed.backend_retries || typeof parsed.backend_retries !== "object") delete parsed.backend_retries;
      return parsed;
    }
  } catch {}
  return { accounts: {} };
}

export interface CodexUsageRefreshSummary {
  probed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
  // The ChatGPT-backend supplement, reported apart from the app-server probe:
  // it can fail on its own without costing the account its meters.
  backend_failed: Array<{ name: string; reason: string }>;
  backend_deferred: string[]; // still inside a recorded backoff window
}

// How long to leave an account alone once the backend has confirmed it has no
// session window to report.
const BACKEND_AGREED_COOLOFF_MS = 60 * 60 * 1000;

/** The rest state after a backend reading that filled no hole. Not a failure —
 * `failures: 0` keeps it out of the doubling ladder, so the next real refusal
 * starts from the base delay. */
function agreedNoSessionWindow(now: number): UsageRetryState {
  return {
    retry_at: now + BACKEND_AGREED_COOLOFF_MS,
    failures: 0,
    reason: "no session window on this plan",
    failed_at: now,
  };
}

/**
 * Refresh usage for the active login + every dormant profile. Sequence per
 * cycle: enroll/refresh the active profile, probe the active account via the
 * REAL ~/.codex (RPC + rollout-log model mix), then probe each dormant profile
 * via its snapshot dir. Per-account throttle so callers can invoke freely.
 */
export async function refreshCodexUsageSnapshots(
  opts: {
    now?: number;
    minIntervalMs?: number;
    // Test seam: receives the CODEX_HOME to probe (undefined = real home).
    rpcFetch?: (codexHomeDir?: string) => Promise<any | null>;
    // Test seam for the ChatGPT-backend supplement. Receives the same home, so
    // each account is read through its own auth.json. Throwing a
    // CodexUsageHttpError here is what drives the per-account backoff.
    backendFetch?: (codexHomeDir: string) => Promise<Omit<CodexUsageSnapshot, "models"> | null>;
  } = {},
): Promise<CodexUsageRefreshSummary> {
  const now = opts.now ?? Date.now();
  const minInterval = opts.minIntervalMs ?? 4 * 60 * 1000;
  const rpcFetch = opts.rpcFetch ?? ((home?: string) => fetchRateLimitsViaAppServer({ codexHome: home }));
  const backendFetch = opts.backendFetch ?? ((home: string) => fetchCodexBackendUsage(home, { now }));
  const summary: CodexUsageRefreshSummary = {
    probed: [],
    skipped: [],
    failed: [],
    backend_failed: [],
    backend_deferred: [],
  };

  // Keep the profile store in step with the live login before probing.
  try {
    autoSaveActiveCodexProfile();
    resnapshotIfActiveCodexFresher();
  } catch {
    /* enrollment is best-effort; probing still works without a profile */
  }

  const active = activeCodexSummary();
  const activeKey = active.account_id || active.email;
  const index = readProfileIndex();
  const hasAnyCodex = !!activeKey || Object.keys(index.profiles).length > 0;
  if (!hasAnyCodex) return summary;

  const cache = readUsageCache();
  const knownKeys = new Set<string>();
  let wrote = false;

  const probe = async (label: string, key: string, home?: string, models?: boolean) => {
    knownKeys.add(key);
    const prev = cache.accounts[key];
    if (prev && now - prev.fetched_at < minInterval) {
      summary.skipped.push(label);
      return;
    }
    let snap: CodexUsageSnapshot | null = null;
    try {
      snap = parseRateLimitsReadResult(await rpcFetch(home), now);
    } catch {
      snap = null;
    }
    // The ChatGPT backend supplements what the app-server left blank — most
    // often the five-hour session window, which reads as headroom when absent.
    // The RPC stays authoritative: mergeCodexUsage only fills holes. Skipped
    // while this account is backing off from a refusal, and skipped entirely
    // for a home we cannot name (the active probe passes the real ~/.codex).
    //
    // The trigger names only what the backend is asked FOR. Missing reset
    // credits are not on it: having none is the ordinary state of an account,
    // so treating that as a hole would send every account to the endpoint on
    // every cycle forever.
    if (home && (!snap || !snap.session || !snap.plan_type)) {
      const retry = cache.backend_retries?.[key];
      if (retry && now < retry.retry_at) {
        summary.backend_deferred.push(label);
      } else {
        try {
          const backend = await backendFetch(home);
          snap = mergeCodexUsage(snap, backend);
          // The backend answered and the hole is still there: this plan has no
          // five-hour window at all (verified on a live Pro account, where both
          // sources report the weekly bucket alone). Asking again every tick
          // would buy nothing, so rest — the app-server keeps the meters fresh
          // meanwhile, and an upgraded plan is picked up within the hour.
          const next = backend && !snap?.session ? agreedNoSessionWindow(now) : undefined;
          if (next) {
            (cache.backend_retries ??= {})[key] = next;
            wrote = true;
          } else if (backend && retry) {
            delete cache.backend_retries![key];
            wrote = true;
          }
        } catch (err) {
          (cache.backend_retries ??= {})[key] = nextUsageRetry(retry, err, now);
          wrote = true;
          summary.backend_failed.push({
            name: label,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    // The active account has the rollout logs to lean on: model mix always,
    // limit windows too when the RPC fails (binary missing, transient error).
    if (models) {
      let logsSnap: CodexUsageSnapshot | null = null;
      try {
        logsSnap = collectCodexUsageSnapshot(now);
      } catch {}
      if (snap) {
        if (logsSnap?.models) snap.models = logsSnap.models;
      } else {
        snap = logsSnap;
      }
    }
    if (snap) {
      cache.accounts[key] = snap;
      summary.probed.push(label);
      wrote = true;
    } else {
      summary.failed.push({ name: label, reason: "rate-limits probe returned nothing" });
    }
  };

  if (activeKey && active.usable) {
    // Real home, never a snapshot copy — a probe here may rotate the live grant
    // and only the live store may absorb that.
    await probe("active", activeKey, codexHome(), true);
  }
  for (const [name, meta] of Object.entries(index.profiles)) {
    const key = meta.account_id || meta.email;
    if (!key) continue;
    if (activeKey && key === activeKey) {
      knownKeys.add(key);
      continue; // the active probe covers it — never probe the snapshot copy
    }
    if (!decodeCodexAuth(readProfileAuth(name)).usable) {
      summary.skipped.push(name);
      knownKeys.add(key);
      continue;
    }
    await probe(name, key, profileDir(name));
  }

  if (wrote) {
    for (const key of Object.keys(cache.accounts)) {
      if (!knownKeys.has(key)) delete cache.accounts[key];
    }
    for (const key of Object.keys(cache.backend_retries ?? {})) {
      if (!knownKeys.has(key)) delete cache.backend_retries![key];
    }
    atomicWriteFile(usageCachePath(), JSON.stringify(cache, null, 2), { mode: 0o644 });
    invalidateCodexAccountsCache();
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Heartbeat payload (non-secret) — same shape as the Claude inventory
// ---------------------------------------------------------------------------

export interface CodexAccountsHeartbeatPayload {
  active_email?: string;
  active_uuid?: string; // account_id — same field name as the Claude payload
  profiles: Array<{
    name: string;
    email?: string;
    subscription?: string; // ChatGPT plan ("pro", "plus", …)
    usage?: Omit<CodexUsageSnapshot, "plan_type">;
  }>;
}

const payloadCache = createMtimeGatedCache<CodexAccountsHeartbeatPayload | null>(
  () => [indexPath(), activeAuthPath(), usageCachePath()],
  () => {
    let value: CodexAccountsHeartbeatPayload | null = null;
    try {
      const active = activeCodexSummary();
      const usage = readUsageCache().accounts;
      const profiles = Object.entries(readProfileIndex().profiles)
        .map(([name, meta]) => {
          const snap = usage[meta.account_id || meta.email || ""];
          let usageOut: CodexAccountsHeartbeatPayload["profiles"][number]["usage"];
          let plan = meta.plan;
          if (snap) {
            const { plan_type, ...rest } = snap;
            usageOut = rest;
            // The RPC's live plan reading beats the id_token claim saved at
            // snapshot time (upgrades/downgrades show without a re-login).
            if (plan_type) plan = plan_type;
          }
          return { name, email: meta.email, subscription: plan, usage: usageOut };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (active.email || active.account_id || profiles.length > 0) {
        value = { active_email: active.email, active_uuid: active.account_id, profiles };
      }
    } catch {
      value = null;
    }
    return value;
  },
);

export function invalidateCodexAccountsCache(): void {
  payloadCache.invalidate();
}

export function getCodexAccountsHeartbeatPayload(): CodexAccountsHeartbeatPayload | null {
  return payloadCache.get();
}
