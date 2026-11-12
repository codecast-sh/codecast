// `cast usage` — the active Claude account's limit windows and what happens
// to a session on this machine if it hits one. Reads the daemon's usage cache
// (~/.codecast/cc-usage.json, refreshed every ~5 minutes) — nothing here
// touches the provider — and applies the same predicates the web meters and
// the auto-switch decision use, so "N accounts with headroom" is exactly the
// set auto-switch would choose from.
//
// Written for an agent as much as a human: a session about to start a long
// autonomous stretch can check its room and reset time first, instead of
// discovering the wall as a failed tool call.

import {
  USAGE_WARN_PERCENT,
  describeLimitRecovery,
  fallbackProfiles,
  formatAgo,
  formatCountdown,
  nextPressuredReset,
  isUsageExhausted,
  isWindowRolled,
  labeledUsageWindows,
  livePercent,
  switchUsagePercent,
  worstUsagePercent,
  type CcUsage,
  type RecoveryMode,
} from "@codecast/shared/contracts";
import { accountTokenInfo, activeAccountSummary, launchProfileName, listProfiles, readActiveCredential, readUsageCache } from "./ccAccounts.js";
import type { UsageRetryState } from "./usageRetry.js";

export interface UsageProfile {
  name: string;
  email?: string;
  active?: boolean;
  usage?: CcUsage;
  // The daemon's poll is backing off for this account (429 or repeated
  // failures). Local to this machine — the heartbeat can't carry it, see the
  // UsageCache comment in ccAccounts.ts.
  retry?: UsageRetryState;
  // What decides whether auto-switch may land on it (fallbackProfiles), so the
  // accounts this command counts as headroom are the ones auto-switch would pick.
  login_expired_at?: number;
  access_refused_at?: number;
  setup_token?: { expires_at: number } | null;
  reserved_for?: string;
}

export interface RecoveryFlags {
  auto_switch: boolean;
  auto_continue: boolean;
  // Which of the four recovery modes the machine is in. Optional so an older
  // server (flags only) still produces a report.
  mode?: RecoveryMode;
}

export interface UsageWindowLine {
  label: string;
  percent: number; // as of now (0 once rolled)
  resets_at?: number;
  rolled: boolean;
}

export interface UsageReport {
  now: number;
  active: {
    name: string;
    email?: string;
    fetched_at?: number;
    windows: UsageWindowLine[];
    extra?: {
      enabled: boolean;
      percent: number;
      limit?: number;
      used?: number;
      spend_limit_reached?: boolean;
    };
    // Why the reading may be older than the poll interval suggests.
    retry?: UsageRetryState;
  } | null;
  worst: number | null;
  exhausted: boolean;
  // Earliest future reset among the active account's windows at or above the
  // warn threshold — "when does the pressure ease".
  next_reset?: number;
  fallbacks: { name: string; email?: string; worst: number | null }[];
  recovery: RecoveryFlags | null; // null when the server could not be asked
}

// Where a meter turns orange in the web (usageTone): the point at which a
// long autonomous stretch should plan around the reset. Defined with the
// shared recovery sentence, which reads it too.
export { USAGE_WARN_PERCENT };

/** This machine's saved profiles joined with the daemon's usage cache. The
 * active login need not be a saved profile — it still has a cache entry, so
 * it is synthesized as one when no profile covers it. */
export function loadLocalUsageProfiles(credential: string | null = readActiveCredential()): UsageProfile[] {
  const { accounts: cache, retries } = readUsageCache();
  // "active" here is the account sessions run on: the launch profile after a
  // token switch, else the keychain login (fallbacks exclude it, meters lead
  // with it).
  const launch = launchProfileName();
  const profiles: UsageProfile[] = listProfiles(credential).map((p) => ({
    name: p.name,
    email: p.email,
    active: launch ? p.name === launch : p.active,
    usage: cache[p.uuid || p.email || ""],
    retry: retries?.[p.uuid || p.email || ""],
    login_expired_at: p.login_expired_at,
    access_refused_at: p.access_refused_at,
    setup_token: accountTokenInfo(p.name),
    reserved_for: p.reserved_for,
  }));
  const active = activeAccountSummary(credential);
  const activeKey = active?.uuid || active?.email;
  if (active && activeKey && !profiles.some((p) => p.active)) {
    profiles.push({
      name: "(active login)",
      email: active.email,
      active: true,
      usage: cache[activeKey],
      retry: retries?.[activeKey],
    });
  }
  return profiles;
}

export function buildUsageReport(
  profiles: UsageProfile[],
  now: number,
  recovery: RecoveryFlags | null,
): UsageReport {
  const active = profiles.find((p) => p.active) ?? null;
  const usage = active?.usage;
  const windows: UsageWindowLine[] = [];
  for (const w of usage ? labeledUsageWindows(usage) : []) {
    windows.push({ label: w.label, percent: livePercent(w, now), resets_at: w.resets_at, rolled: isWindowRolled(w, now) });
  }
  const extra = usage?.extra;
  const extraNote =
    extra && ((extra.limit ?? 0) > 0 || (extra.used ?? 0) > 0)
      ? {
          enabled: extra.enabled,
          percent: extra.percent,
          limit: extra.limit,
          used: extra.used,
          spend_limit_reached: extra.spend_limit_reached,
        }
      : undefined;
  const worst = worstUsagePercent(usage, now);
  const next_reset = nextPressuredReset(usage, now);
  return {
    now,
    active: active
      ? { name: active.name, email: active.email, fetched_at: usage?.fetched_at, windows, extra: extraNote, retry: active.retry }
      : null,
    worst,
    exhausted: isUsageExhausted(usage, now),
    next_reset,
    fallbacks: fallbackProfiles(profiles, active?.email, now).map((p) => ({
      name: p.name,
      email: p.email,
      worst: switchUsagePercent(p.usage, now),
    })),
    recovery,
  };
}

/** One sentence on what a limit hit means for sessions on this machine. The
 * words live in the shared contracts so the role page prints the same ones. */
export const describeRecovery = (r: UsageReport): string => describeLimitRecovery(r);

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderUsageReport(r: UsageReport, c: Record<string, string>): string {
  const lines: string[] = [];
  if (!r.active) {
    lines.push(`${c.dim}No active Claude account with usage data yet — the daemon reports it within a few minutes.${c.reset}`);
    lines.push(describeRecovery(r));
    return lines.join("\n");
  }
  const age = r.active.fetched_at ? ` ${c.dim}as of ${formatAgo(r.now - r.active.fetched_at)}${c.reset}` : "";
  lines.push(`${c.cyan}${r.active.name}${c.reset} ${r.active.email ?? ""}${age}`);
  for (const w of r.active.windows) {
    const tone = w.percent >= 100 ? c.red : w.percent >= USAGE_WARN_PERCENT ? c.yellow : w.percent >= 60 ? c.yellow : c.green;
    const pct = w.rolled ? `${c.dim}reset${c.reset}` : `${tone}${pad(`${Math.round(w.percent)}%`, 4)}${c.reset}`;
    const reset = w.resets_at && w.resets_at > r.now ? `${c.dim}resets in ${formatCountdown(w.resets_at - r.now)}${c.reset}` : "";
    lines.push(`  ${pad(w.label, 14)} ${pct} ${reset}`.trimEnd());
  }
  if (r.active.windows.length === 0) lines.push(`  ${c.dim}no limit windows reported${c.reset}`);
  const extra = r.active.extra;
  if (extra) {
    const money = (n: number) =>
      n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    const dollars =
      extra.limit != null && extra.used != null ? `${money(extra.used)} / ${money(extra.limit)}` : null;
    const tone = extra.spend_limit_reached || extra.percent >= 100 ? c.red : extra.enabled ? c.yellow : c.dim;
    const status = extra.spend_limit_reached
      ? "cap reached"
      : extra.enabled
        ? `${Math.round(extra.percent)}% used`
        : "off";
    lines.push(`  ${pad("Extra spend", 14)} ${tone}${dollars ?? status}${c.reset}${dollars ? ` ${c.dim}${status}${c.reset}` : ""}`.trimEnd());
  }
  const retry = r.active.retry;
  if (retry) {
    // The numbers above are the last GOOD reading. Without this line a stuck
    // poll is invisible: the meters simply stop moving and read as headroom.
    const when =
      retry.retry_at > r.now ? `next try in ${formatCountdown(retry.retry_at - r.now)}` : "next try on the coming poll";
    const streak = retry.failures > 1 ? ` ${c.dim}(${retry.failures} in a row)${c.reset}` : "";
    const named = retry.retry_after ? " as the endpoint asked" : "";
    lines.push(`  ${c.yellow}usage poll failing${c.reset}${streak} ${c.dim}${retry.reason} · ${when}${named}${c.reset}`);
  }
  lines.push(describeRecovery(r));
  return lines.join("\n");
}

/** One saved account's row in `cast usage --all`. */
export interface AccountUsageRow {
  name: string;
  email?: string;
  active: boolean;
  /** What decides whether a session can land on it now, most binding first. */
  status: "active" | "reserved" | "login expired" | "access refused" | "exhausted" | "no data" | "headroom";
  /** Whether auto-switch would pick it (fallbackProfiles), the same set `cast usage` counts. */
  switch_target: boolean;
  worst: number | null;
  windows: UsageWindowLine[];
  fetched_at?: number;
  reserved_for?: string;
}

/** Every saved account with its windows, from the daemon's cache: what `cast usage` says for the active one, for all of them. */
export function buildAccountUsage(profiles: UsageProfile[], now: number): AccountUsageRow[] {
  const activeEmail = profiles.find((p) => p.active)?.email;
  const targets = new Set(fallbackProfiles(profiles, activeEmail, now).map((p) => p.name));
  return profiles.map((p) => {
    const tokenLive = !!p.setup_token && p.setup_token.expires_at > now;
    const status: AccountUsageRow["status"] = p.active ? "active"
      : p.reserved_for ? "reserved"
        : p.access_refused_at ? "access refused"
          : p.login_expired_at && !tokenLive ? "login expired"
            : !p.usage ? "no data"
              : isUsageExhausted(p.usage, now) ? "exhausted"
                : "headroom";
    return {
      name: p.name,
      email: p.email,
      active: !!p.active,
      status,
      switch_target: targets.has(p.name),
      worst: worstUsagePercent(p.usage, now),
      windows: (p.usage ? labeledUsageWindows(p.usage) : []).map((w) => ({ label: w.label, percent: livePercent(w, now), resets_at: w.resets_at, rolled: isWindowRolled(w, now) })),
      fetched_at: p.usage?.fetched_at,
      ...(p.reserved_for ? { reserved_for: p.reserved_for } : {}),
    };
  });
}

/** One line per account: name, each window's percent and reset, then its status. */
export function renderAccountUsage(rows: AccountUsageRow[], now: number, c: Record<string, string>): string {
  if (!rows.length) return `${c.dim}No saved profiles. Save the current login with:${c.reset} cast accounts save <name>`;
  const width = Math.max(...rows.map((r) => r.name.length)) + 1;
  const lines = rows.map((r) => {
    const windows = r.windows.map((w) => {
      const tone = w.percent >= 100 ? c.red : w.percent >= USAGE_WARN_PERCENT ? c.yellow : c.green;
      const pct = w.rolled ? `${c.dim}reset${c.reset}` : `${tone}${Math.round(w.percent)}%${c.reset}`;
      const reset = !w.rolled && w.resets_at && w.resets_at > now ? ` ${c.dim}${formatCountdown(w.resets_at - now)}${c.reset}` : "";
      return `${w.label} ${pct}${reset}`;
    }).join(`${c.dim} · ${c.reset}`) || `${c.dim}no windows${c.reset}`;
    const tone = r.status === "active" ? c.cyan : r.status === "headroom" ? c.green : r.status === "exhausted" || r.status === "login expired" || r.status === "access refused" ? c.red : c.dim;
    const age = r.fetched_at ? ` ${c.dim}${formatAgo(now - r.fetched_at)}${c.reset}` : "";
    return `${r.active ? "●" : "○"} ${pad(r.name, width)} ${windows}  ${tone}${r.status}${c.reset}${age}`;
  });
  const targets = rows.filter((r) => r.switch_target);
  lines.push(`${c.dim}${targets.length} of ${rows.length} accounts are auto-switch targets now (headroom, reachable, not reserved)${c.reset}`);
  const best = [...targets].sort((a, b) => (a.worst ?? 100) - (b.worst ?? 100))[0];
  if (best) lines.push(`${c.dim}Sessions parked on a limit continue now on ${best.name}, workers included:${c.reset} cast accounts use ${best.name} --continue --yes --include-subagents`);
  return lines.join("\n");
}
