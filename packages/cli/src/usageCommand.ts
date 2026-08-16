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
  fallbackProfiles,
  isUsageExhausted,
  isWindowRolled,
  livePercent,
  worstUsagePercent,
  type CcUsage,
} from "@codecast/shared/contracts";
import { formatDuration } from "./publishCommand.js";

export interface UsageProfile {
  name: string;
  email?: string;
  active?: boolean;
  usage?: CcUsage;
}

export interface RecoveryFlags {
  auto_switch: boolean;
  auto_continue: boolean;
}

export interface UsageWindowLine {
  label: string;
  percent: number; // as of now (0 once rolled)
  resets_at?: number;
  rolled: boolean;
}

export interface UsageReport {
  now: number;
  active: { name: string; email?: string; fetched_at?: number; windows: UsageWindowLine[] } | null;
  worst: number | null;
  exhausted: boolean;
  // Earliest future reset among the active account's windows at or above the
  // warn threshold — "when does the pressure ease".
  next_reset?: number;
  fallbacks: { name: string; email?: string; worst: number | null }[];
  recovery: RecoveryFlags | null; // null when the server could not be asked
}

// Where a meter turns orange in the web (usageTone): the point at which a
// long autonomous stretch should plan around the reset.
export const USAGE_WARN_PERCENT = 85;

export function buildUsageReport(
  profiles: UsageProfile[],
  now: number,
  recovery: RecoveryFlags | null,
): UsageReport {
  const active = profiles.find((p) => p.active) ?? null;
  const usage = active?.usage;
  const windows: UsageWindowLine[] = [];
  const push = (label: string, w?: { percent: number; resets_at?: number }) => {
    if (!w) return;
    windows.push({ label, percent: livePercent(w, now), resets_at: w.resets_at, rolled: isWindowRolled(w, now) });
  };
  if (usage) {
    push("Session (5h)", usage.session);
    push("Week (7d)", usage.weekly);
    push(usage.weekly_scoped?.label ? `${usage.weekly_scoped.label} (7d)` : "Model (7d)", usage.weekly_scoped);
    for (const s of usage.scoped ?? []) push(s.label, s);
  }
  const worst = worstUsagePercent(usage, now);
  const pressured = windows.filter((w) => !w.rolled && w.percent >= USAGE_WARN_PERCENT && w.resets_at && w.resets_at > now);
  const next_reset = pressured.length ? Math.min(...pressured.map((w) => w.resets_at as number)) : undefined;
  return {
    now,
    active: active ? { name: active.name, email: active.email, fetched_at: usage?.fetched_at, windows } : null,
    worst,
    exhausted: isUsageExhausted(usage, now),
    next_reset,
    fallbacks: fallbackProfiles(profiles, active?.email, now).map((p) => ({
      name: p.name,
      email: p.email,
      worst: worstUsagePercent(p.usage, now),
    })),
    recovery,
  };
}

/** One sentence on what a limit hit means for sessions on this machine, from
 * the recovery flags and the fallback set. Kept factual — the reader decides
 * whether to checkpoint. */
export function describeRecovery(r: UsageReport): string {
  const resetNote = r.next_reset ? ` (next reset in ${formatDuration(r.next_reset - r.now)})` : "";
  const hop = r.fallbacks[0]
    ? `${r.fallbacks.length} saved account(s) with headroom (best: ${r.fallbacks[0].name}${
        r.fallbacks[0].worst != null ? ` at ${Math.round(r.fallbacks[0].worst)}%` : ""
      })`
    : "no other saved account with headroom";
  if (!r.recovery) {
    return `On a limit: ${hop}; recovery flags unknown (server unreachable)${resetNote}.`;
  }
  if (r.recovery.auto_switch && r.fallbacks[0]) {
    return `On a limit: auto-switch hops to the freshest of ${hop} and continues parked sessions${resetNote}.`;
  }
  if (r.recovery.auto_continue) {
    return `On a limit: sessions park and resume on their own when the window resets${resetNote}; ${hop}${
      r.recovery.auto_switch ? "" : " (auto-switch off)"
    }.`;
  }
  return `On a limit: sessions park until you continue them (auto-switch and resume-at-reset are off)${resetNote}; ${hop}.`;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderUsageReport(r: UsageReport, c: Record<string, string>): string {
  const lines: string[] = [];
  if (!r.active) {
    lines.push(`${c.dim}No active Claude account with usage data yet — the daemon reports it within a few minutes.${c.reset}`);
    lines.push(describeRecovery(r));
    return lines.join("\n");
  }
  const age = r.active.fetched_at ? ` ${c.dim}as of ${formatDuration(r.now - r.active.fetched_at)} ago${c.reset}` : "";
  lines.push(`${c.cyan}${r.active.name}${c.reset} ${r.active.email ?? ""}${age}`);
  for (const w of r.active.windows) {
    const tone = w.percent >= 100 ? c.red : w.percent >= USAGE_WARN_PERCENT ? c.yellow : w.percent >= 60 ? c.yellow : c.green;
    const pct = w.rolled ? `${c.dim}reset${c.reset}` : `${tone}${pad(`${Math.round(w.percent)}%`, 4)}${c.reset}`;
    const reset = w.resets_at && w.resets_at > r.now ? `${c.dim}resets in ${formatDuration(w.resets_at - r.now)}${c.reset}` : "";
    lines.push(`  ${pad(w.label, 14)} ${pct} ${reset}`.trimEnd());
  }
  if (r.active.windows.length === 0) lines.push(`  ${c.dim}no limit windows reported${c.reset}`);
  lines.push(describeRecovery(r));
  return lines.join("\n");
}
