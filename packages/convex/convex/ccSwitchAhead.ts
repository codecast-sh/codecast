// Switch ahead: the decision to move a fleet-store machine off an account
// before it runs out, rather than after its sessions park on it. Pure, like
// the rest of the account decisions in ccAccountsShared.ts; switchAheadCheck
// (accountSwitch.ts) acts on it.

import {
  AUTO_SWITCH_ATTEMPT_EVIDENCE_MS,
  AUTO_SWITCH_SESSION_WINDOW_MS,
  fallbackProfiles,
  isUsageExhausted,
  livePercent,
  type AutoSwitchProfile,
} from "./ccAccountsShared";
import { headroomScore, type CcUsage } from "@codecast/shared/contracts";

// Switch-ahead thresholds: the fleet moves off an account while its windows
// still have room, before Claude Code's grace window (at 100%) and its
// near-limit note (99.75% of the 5 hour window on Max 20x) ever reach a
// session. The margin covers the burn between two heartbeats of a busy fleet.
export const SWITCH_AHEAD_SESSION_PERCENT = 95;
export const SWITCH_AHEAD_WEEKLY_PERCENT = 97;
// A target must have this much more room than the account it replaces, so two
// nearly spent accounts never trade the fleet back and forth.
export const SWITCH_AHEAD_MIN_GAIN = 10;
export const SWITCH_AHEAD_COOLDOWN_MS = 3 * 60 * 1000;

/** The account is close enough to a limit that the fleet should leave it now:
 *  a live window at or past its threshold, or already spent. */
export function isNearUsageLimit(usage: CcUsage | undefined | null, now: number): boolean {
  if (!usage) return false;
  if (isUsageExhausted(usage, now)) return true;
  const at = (w: { percent: number; resets_at?: number } | undefined, limit: number) => !!w && livePercent(w, now) >= limit;
  return at(usage.session, SWITCH_AHEAD_SESSION_PERCENT) ||
    at(usage.weekly, SWITCH_AHEAD_WEEKLY_PERCENT) ||
    at(usage.weekly_scoped, SWITCH_AHEAD_WEEKLY_PERCENT);
}

/**
 * Where the fleet should move BEFORE its account runs out, or null to stay.
 * Only for a machine on the fleet store, where a switch costs the running
 * sessions nothing. Reads the fleet account's meter (live statusLine readings
 * keep it within seconds) and ignores a reading taken before the fleet last
 * moved, which describes the previous account's burn. The target is the
 * account with the most room that is not itself near a limit, not tried in
 * this window without fresh evidence (the same blackout decideAutoSwitch
 * uses), and clearly better than staying.
 */
export function decideSwitchAhead(input: {
  now: number;
  fleetEmail?: string;
  fleetSince?: number;
  profiles: AutoSwitchProfile[];
  attempts: Array<{ profile: string; at: number }>;
  lastActionAt?: number;
}): { profile: string } | null {
  const { now, fleetEmail, profiles } = input;
  const fleet = profiles.find((p) => p.email && p.email === fleetEmail);
  const usage = fleet?.usage;
  if (!usage || (input.fleetSince !== undefined && usage.fetched_at < input.fleetSince)) return null;
  if (!isNearUsageLimit(usage, now)) return null;
  if (input.lastActionAt && now - input.lastActionAt < SWITCH_AHEAD_COOLDOWN_MS) return null;
  const fleetPercent = headroomScore(usage, now);
  const target = fallbackProfiles(profiles, fleetEmail, now).find((p) => {
    if (isNearUsageLimit(p.usage, now)) return false;
    const tried = input.attempts.reduce((max, a) => (a.profile === p.name && a.at > max ? a.at : max), 0);
    if (tried && now - tried < AUTO_SWITCH_SESSION_WINDOW_MS && (p.usage?.fetched_at ?? 0) < tried + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS) return false;
    return headroomScore(p.usage, now) <= fleetPercent - SWITCH_AHEAD_MIN_GAIN;
  });
  return target ? { profile: target.name } : null;
}
