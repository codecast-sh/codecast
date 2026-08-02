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
import * as os from "os";
import * as path from "path";
import { deriveProfileName, isLegacyDerivedName } from "./ccAccounts.js";
import {
  codexHome,
  collectCodexUsageSnapshot,
  fetchRateLimitsViaAppServer,
  parseRateLimitsReadResult,
  type CodexUsageSnapshot,
} from "./codexUsage.js";

export class CodexAccountError extends Error {}

/** $HOME first (bun's os.homedir() caches at startup and ignores later env
 * changes, which breaks $HOME-sandboxed tests), os.homedir() as fallback. */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

function codecastDir(): string {
  return process.env.CODECAST_DIR || path.join(homeDir(), ".codecast");
}

function profilesRoot(): string {
  return path.join(codecastDir(), "codex-accounts");
}

export function profileDir(name: string): string {
  return path.join(profilesRoot(), name);
}

function indexPath(): string {
  return path.join(codecastDir(), "codex-accounts.json");
}

function usageCachePath(): string {
  return path.join(codecastDir(), "codex-usage-accounts.json");
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
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), "utf-8"));
    if (parsed && typeof parsed.profiles === "object") return parsed;
  } catch {}
  return { profiles: {} };
}

function atomicWriteFile(filePath: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}

function writeProfileIndex(index: ProfileIndex): void {
  atomicWriteFile(indexPath(), JSON.stringify(index, null, 2), 0o644);
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
  const dir = profileDir(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path.join(dir, "auth.json"), raw, 0o600);
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

/** Enroll the active login as a profile iff none covers it yet (matched by
 * account_id, email fallback) — the daemon calls this so `codex login` is the
 * only manual step, ever. Mirrors autoSaveActiveProfile. */
export function autoSaveActiveCodexProfile(): (CodexProfileMeta & { name: string }) | null {
  const active = activeCodexSummary();
  if (!active.usable || (!active.account_id && !active.email)) return null;
  const index = readProfileIndex();
  const covered = Object.values(index.profiles).some(
    (meta) =>
      (active.account_id && meta.account_id === active.account_id) ||
      (active.email && meta.email === active.email),
  );
  if (covered) return null;
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
  if (!raw || !active.usable || (!active.account_id && !active.email)) return null;
  const index = readProfileIndex();
  const match = Object.entries(index.profiles).find(
    ([, meta]) =>
      (active.account_id && meta.account_id === active.account_id) ||
      (active.email && meta.email === active.email),
  );
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
}

export function readUsageCache(): UsageCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageCachePath(), "utf-8"));
    if (parsed && typeof parsed.accounts === "object") return parsed;
  } catch {}
  return { accounts: {} };
}

export interface CodexUsageRefreshSummary {
  probed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
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
  } = {},
): Promise<CodexUsageRefreshSummary> {
  const now = opts.now ?? Date.now();
  const minInterval = opts.minIntervalMs ?? 4 * 60 * 1000;
  const rpcFetch = opts.rpcFetch ?? ((home?: string) => fetchRateLimitsViaAppServer({ codexHome: home }));
  const summary: CodexUsageRefreshSummary = { probed: [], skipped: [], failed: [] };

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
    atomicWriteFile(usageCachePath(), JSON.stringify(cache, null, 2), 0o644);
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

let payloadCache: {
  value: CodexAccountsHeartbeatPayload | null;
  indexMtime: number;
  authMtime: number;
  usageMtime: number;
} | null = null;

function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function invalidateCodexAccountsCache(): void {
  payloadCache = null;
}

export function getCodexAccountsHeartbeatPayload(): CodexAccountsHeartbeatPayload | null {
  const indexMtime = mtimeOf(indexPath());
  const authMtime = mtimeOf(activeAuthPath());
  const usageMtime = mtimeOf(usageCachePath());
  if (
    payloadCache &&
    payloadCache.indexMtime === indexMtime &&
    payloadCache.authMtime === authMtime &&
    payloadCache.usageMtime === usageMtime
  ) {
    return payloadCache.value;
  }
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
  payloadCache = { value, indexMtime, authMtime, usageMtime };
  return value;
}
