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
  resolveDeviceProfile,
  type AutoSwitchProfile,
} from "./ccAccountsShared";
import { headroomScore, limitWindows, type CcUsage } from "@codecast/shared/contracts";

// Switch-ahead thresholds: the fleet moves off an account while its windows
// still have room, before Claude Code's grace window (at 100%) and its
// near-limit note (99.75% of the 5 hour window on Max 20x) ever reach a
// session. The margin covers the burn between two heartbeats of a busy fleet.
export const SWITCH_AHEAD_SESSION_PERCENT = 95;
export const SWITCH_AHEAD_WEEKLY_PERCENT = 97;
// A target must have this much more room than the account it replaces, so the
// fleet does not hop to an account it would leave again minutes later. Waived
// once the fleet is about to run out: any account below the thresholds beats a
// park, and the account left behind stays near its limit, so it is never a
// target to come back to.
export const SWITCH_AHEAD_MIN_GAIN = 10;
export const SWITCH_AHEAD_LAST_CALL_PERCENT = 99;
export const SWITCH_AHEAD_COOLDOWN_MS = 3 * 60 * 1000;
// A person who just moved the fleet (the banner, `cast accounts use`) is
// still draining paced continues onto that account: 200 resumes at 20s apart
// take over an hour. The 3-minute cooldown expires in the middle of that
// drain, and an unmeasured meter ranks behind every known percent, so the
// loop was leaving the account they picked for one at 80%.
export const MANUAL_TARGET_HOLD_MS = 2 * 60 * 60 * 1000;

type ManualTargetInput = {
  now: number;
  fleetEmail?: string;
  usage?: CcUsage | null;
  models?: readonly string[];
  lastAction?: string;
  lastActionAt?: number;
  decision?: { kind?: string; target_email?: string } | null;
};

/** A person's switch is still the latest thing this machine was told to do,
 *  and the hold has not expired. The fleet email may or may not have caught
 *  up: the command is in flight until it has. */
function manualSwitchFresh(input: ManualTargetInput): boolean {
  const { now, lastAction, lastActionAt, decision } = input;
  if (lastAction !== "manual" || lastActionAt == null) return false;
  if (now - lastActionAt > MANUAL_TARGET_HOLD_MS || now < lastActionAt) return false;
  return !!decision && decision.kind === "switch" && !!decision.target_email;
}

/** The fleet stays on the account a person just switched it to, until the
 *  hold expires or the account is actually near a limit. A missing meter is
 *  not near a limit: leaving an unmeasured account is how a new login gets
 *  abandoned for a worse known one. */
export function holdsManualTarget(input: ManualTargetInput): boolean {
  const { fleetEmail, usage, models, decision } = input;
  if (!manualSwitchFresh(input)) return false;
  if (decision!.target_email !== fleetEmail) return false;
  return !isNearUsageLimit(usage, input.now, models);
}

/** The switch a person asked for has not shown up in this machine's fleet
 *  email yet. The meter still describes the account they are leaving, so it
 *  must not pick the next hop, and it must not resume sessions there. */
export function awaitsManualTarget(input: ManualTargetInput): boolean {
  if (!manualSwitchFresh(input)) return false;
  return input.decision!.target_email !== input.fleetEmail;
}

/** The account is close enough to a limit that the fleet should leave it now:
 *  a live window at or past its threshold, or already spent. `models` are the
 *  models the fleet's sessions run: a model-scoped week ("Fable") counts only
 *  for them (limitWindows), the same rule the park-driven switch applies. */
export function isNearUsageLimit(
  usage: CcUsage | undefined | null,
  now: number,
  models?: readonly string[],
  floor?: { session: number; weekly: number },
): boolean {
  if (!usage) return false;
  if (isUsageExhausted(usage, now, models)) return true;
  const { session, weekly } = floor ?? { session: SWITCH_AHEAD_SESSION_PERCENT, weekly: SWITCH_AHEAD_WEEKLY_PERCENT };
  return limitWindows(usage, models).some((w) => livePercent(w, now) >= (w === usage.session ? session : weekly));
}

/**
 * Where the fleet should move BEFORE its account runs out, or null to stay.
 * Only for a machine on the fleet store, where a switch costs the running
 * sessions nothing. Reads the fleet account's meter (live statusLine readings
 * keep it within seconds) and ignores a reading taken before the fleet last
 * moved, which describes the previous account's burn. The target is the
 * account with the most room that is not itself near a limit, not tried in
 * this window without fresh evidence (the same blackout decideAutoSwitch
 * uses), and clearly better than staying. `models` are the models the fleet's
 * running sessions use; a scoped week of any other model is ignored on both
 * sides, so a pegged Fable week neither drives an Opus fleet away nor benches
 * an account with room for it.
 */
export function decideSwitchAhead(input: {
  now: number;
  fleetEmail?: string;
  fleetSince?: number;
  profiles: AutoSwitchProfile[];
  attempts: Array<{ profile: string; at: number }>;
  lastActionAt?: number;
  models?: readonly string[];
}): { profile: string } | null {
  const { now, fleetEmail, profiles, models } = input;
  const fleet = profiles.find((p) => p.email && p.email === fleetEmail);
  const usage = fleet?.usage;
  if (!usage || (input.fleetSince !== undefined && usage.fetched_at < input.fleetSince)) return null;
  if (!isNearUsageLimit(usage, now, models)) return null;
  if (input.lastActionAt && now - input.lastActionAt < SWITCH_AHEAD_COOLDOWN_MS) return null;
  const fleetPercent = headroomScore(usage, now);
  const lastCall = isNearUsageLimit(usage, now, models, {
    session: SWITCH_AHEAD_LAST_CALL_PERCENT,
    weekly: SWITCH_AHEAD_LAST_CALL_PERCENT,
  });
  const target = fallbackProfiles(profiles, fleetEmail, now, models).find((p) => {
    if (isNearUsageLimit(p.usage, now, models)) return false;
    const tried = input.attempts.reduce((max, a) => (a.profile === p.name && a.at > max ? a.at : max), 0);
    if (tried && now - tried < AUTO_SWITCH_SESSION_WINDOW_MS && (p.usage?.fetched_at ?? 0) < tried + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS) return false;
    return lastCall || headroomScore(p.usage, now) <= fleetPercent - SWITCH_AHEAD_MIN_GAIN;
  });
  return target ? { profile: target.name } : null;
}

// This token draws Cloudflare's "Attention Required" 403 when the line hosts
// present it together (2026-11-13: 39 sessions, while a plain request from
// each host passed and another account on those hosts kept working). The
// account stays usable everywhere else. A line host already on it can still
// leave; it is only kept out of the next choice.
const LINE_HOST_EDGE_REFUSED = new Set(["r.cameron.musgrave@gmail.com"]);

function emailKey(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

function hostsLineWork(device: { is_remote?: boolean; line_slots?: readonly unknown[] | null } | null | undefined): boolean {
  return !!device?.is_remote && !!device.line_slots?.length;
}

/** The line hosts must not be moved onto this email. */
export function lineHostRefusesEmail(
  device: { is_remote?: boolean; line_slots?: readonly unknown[] | null } | null | undefined,
  email: string | undefined | null,
): boolean {
  return hostsLineWork(device) && LINE_HOST_EDGE_REFUSED.has(emailKey(email));
}

/** Profiles a line host may be ranked onto. The account it is already on
 *  stays, so a near-limit reading can still move the host off it. Any other
 *  machine gets the list unchanged. */
export function dropLineHostRefused<P extends { email?: string | null }>(
  profiles: readonly P[],
  device: { is_remote?: boolean; line_slots?: readonly unknown[] | null } | null | undefined,
  currentEmail?: string | null,
): P[] {
  if (!hostsLineWork(device)) return profiles as P[];
  const current = emailKey(currentEmail);
  return profiles.filter((p) => {
    const email = emailKey(p.email);
    return !email || email === current || !LINE_HOST_EDGE_REFUSED.has(email);
  });
}

/** Whether a cloud host that keeps its own fleet should follow a switch onto
 *  this account. A line host does not follow one onto an email it refuses,
 *  even when it has the profile saved. */
export function fleetHostFollowsSwitch(
  device: { is_remote?: boolean; line_slots?: readonly unknown[] | null; cc_accounts?: { profiles: Array<{ name: string; email?: string }> } | null },
  target: { profile?: string; email?: string },
): boolean {
  const name = resolveDeviceProfile(device.cc_accounts, target);
  if (!name) return false;
  const email = target.email ?? device.cc_accounts?.profiles.find((p) => p.name === name)?.email;
  return !lineHostRefusesEmail(device, email);
}
