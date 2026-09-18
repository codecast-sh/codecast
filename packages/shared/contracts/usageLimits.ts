// Account usage-limit windows: the compact per-account snapshot the daemon
// probes from the provider's usage endpoint (percentages + reset times only —
// never tokens) and the pure predicates every reader applies to it. Shared by
// the Convex backend (auto-switch decision, validators), the web (meters,
// header chip), and the CLI (`cast usage`), so a window means the same thing
// wherever it is read.

export type CcUsageWindow = { percent: number; resets_at?: number; label?: string };

/** Extra usage credits (overflow spend past the plan windows). `limit`/`used`
 *  are dollars from the provider's `extra_usage` block; absent on accounts
 *  that have never configured extra spend. */
export type CcExtraUsage = {
  percent: number;
  enabled: boolean;
  limit?: number;
  used?: number;
  spend_limit_reached?: boolean;
};

export type CcUsage = {
  fetched_at: number;
  session?: CcUsageWindow; // rolling short window (5h / sub-24h)
  weekly?: CcUsageWindow; // 7d, all models
  weekly_scoped?: CcUsageWindow; // 7d, model-scoped
  extra?: CcExtraUsage;
  scoped?: { label: string; percent: number; resets_at?: number }[];
  credits?: { has_credits: boolean; unlimited?: boolean; balance?: string };
  reset_credits?: { available: number };
  models?: { model: string; label: string; tokens: number; share: number }[];
};

/** A limit window whose reset time has already passed has ROLLED: the snapshot
 * describes a window that no longer exists. `resets_at` is absolute, so this
 * stays true however old the snapshot is — a 5h window read 17h ago rolled
 * long ago, and its percent is history, not a reading. A window with no known
 * reset time can never be proven rolled. */
export function isWindowRolled(w: { resets_at?: number } | undefined | null, now: number): boolean {
  return !!w && w.resets_at != null && w.resets_at <= now;
}

/** A window's utilization AS OF `now`: 0 once it has rolled, since a fresh
 * window starts empty. The one place display and decision logic agree on what
 * a stale snapshot still means. */
export function livePercent(w: { percent: number; resets_at?: number }, now: number): number {
  return isWindowRolled(w, now) ? 0 : w.percent;
}

export function limitWindows(usage: CcUsage): { percent: number; resets_at?: number }[] {
  return [usage.session, usage.weekly, usage.weekly_scoped, ...(usage.scoped ?? [])].filter(
    (w): w is NonNullable<typeof w> => !!w,
  );
}

/** The worst (highest) utilization across an account's limit windows AS OF
 * `now` — what a single summary meter should show. Rolled windows count as 0,
 * so a dormant account stops reading "100%" forever. Null when no usage data
 * exists. */
export function worstUsagePercent(usage: CcUsage | undefined | null, now: number): number | null {
  if (!usage) return null;
  const windows = limitWindows(usage);
  return windows.length ? Math.max(...windows.map((w) => livePercent(w, now))) : null;
}

/** An account with no headroom RIGHT NOW: some window is pegged and its reset
 * is still in the future. A pegged window whose reset has passed doesn't count
 * — the snapshot is just stale, the window has rolled. Neither does a pegged
 * window on an account with usage credits switched on: Claude Code keeps
 * working on credits past the plan limit ("Now using usage credits"), so the
 * account is usable until the credit budget itself is spent. Such an account
 * still ranks after every account with plan headroom (rankByHeadroom scores
 * it at 100), so credits are the fallback, never the first pick. */
export function isUsageExhausted(usage: CcUsage | undefined | null, now: number): boolean {
  if (!usage) return false;
  if (!limitWindows(usage).some((w) => livePercent(w, now) >= 100)) return false;
  return !(usage.extra?.enabled && usage.extra.percent < 100);
}

/** "resets in …" for a limit window: minute precision under an hour, hours and
 * minutes under two days (minutes only while under ten hours — a 5h window's
 * remaining minutes matter, a weekly one's don't), then days. */
export function formatCountdown(msFromNow: number): string {
  const mins = Math.max(1, Math.round(msFromNow / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60 > 0 && hours < 10 ? `${mins % 60}m` : ""}`.trim();
  return `${Math.round(hours / 24)}d`;
}

export function formatAgo(msAgo: number): string {
  const mins = Math.round(msAgo / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A rolled window whose snapshot was taken BEFORE the reset is not 0% used —
 *  it is unmeasured. livePercent returns 0 so a display meter does not stay
 *  pegged at the old 100%; a switch decision that treated that 0 as "most
 *  headroom" hopped to accounts whose usage probe had been 401ing for hours
 *  (the new window may already be spent). Null = unknown, same standing as
 *  no usage data. */
export function switchUsagePercent(usage: CcUsage | undefined | null, now: number): number | null {
  if (!usage) return null;
  const windows = limitWindows(usage);
  if (!windows.length) return null;
  for (const w of windows) {
    if (isWindowRolled(w, now) && (w.resets_at == null || usage.fetched_at <= w.resets_at)) {
      return null;
    }
  }
  return worstUsagePercent(usage, now);
}

/** One account's standing: the SINGLE source both the usage bars and the
 * switch decision read, so a person can predict what the switcher will do
 * from what the meter shows. `percent` is the worst live window; `null` when
 * the snapshot has not measured the current windows (a window rolled since the
 * last probe) — the meter renders that as "stale" and the ranker sorts it
 * behind every account with a known number, the SAME fact in both places
 * rather than a confident-green meter beside a switcher that skips the
 * account. `pegged` is a spent account (isUsageExhausted). */
export type UsageStanding = {
  percent: number | null;
  pegged: boolean;
  // percent is null because a rolled window was never re-probed (vs. no usage
  // data at all) — the case that needs a "refresh to see room" hint.
  stale: boolean;
};

export function usageStanding(usage: CcUsage | undefined | null, now: number): UsageStanding {
  const percent = switchUsagePercent(usage, now);
  return { percent, pegged: isUsageExhausted(usage, now), stale: percent === null && !!usage };
}

/** The short standing label shared by the header chip, the park card and the
 * switch banner so all three name an account identically: "at limit" when
 * pegged, "stale" when a rolled window is unmeasured, "no data" when nothing
 * was ever read, else "N% used". */
export function standingLabel(usage: CcUsage | undefined | null, now: number): string {
  const s = usageStanding(usage, now);
  if (s.pegged) return "at limit";
  if (s.percent === null) return s.stale ? "stale" : "no data";
  return `${Math.round(s.percent)}% used`;
}

/** Order accounts by how much room they have left: known headroom first
 * (lowest worst-window percent wins), accounts with no usage data — or a
 * snapshot that has not measured the current windows — after every known
 * one. Eligible, just unproven. Stable for ties. Reads usageStanding, the
 * same standing the bars render, so the top pick is the one a person would
 * point to on the meters. */
export function rankByHeadroom<P extends { usage?: CcUsage | null }>(profiles: P[], now: number): P[] {
  return [...profiles].sort((a, b) => headroomScore(a.usage, now) - headroomScore(b.usage, now));
}

/** The sort key behind rankByHeadroom, for callers that order something other
 * than a flat list of profiles (a panel that groups an email's accounts, say):
 * the worst live window's percent, and 101 when the current windows have not
 * been measured, so an unproven account ranks behind every known number. */
export function headroomScore(usage: CcUsage | undefined | null, now: number): number {
  return usageStanding(usage, now).percent ?? 101;
}

/** The other accounts a limit-parked session could fall back to: every saved
 * profile that is not the active login, shows no pegged window, and whose
 * saved login still works (`login_expired_at`: the daemon's token refresh was
 * refused, so a switch there lands on a dead credential and parks on an auth
 * banner instead of un-parking anything). Best headroom first. Shared by the
 * auto-switch decision (which further excludes profiles already tried this
 * window) and `cast usage`, so what the CLI reports as "N accounts with
 * headroom" is the set auto-switch would choose from. */
export function fallbackProfiles<
  P extends { email?: string; usage?: CcUsage | null; login_expired_at?: number | null },
>(profiles: P[], activeEmail: string | undefined, now: number): P[] {
  return rankByHeadroom(
    profiles.filter(
      (p) => p.email && p.email !== activeEmail && !p.login_expired_at && !isUsageExhausted(p.usage, now),
    ),
    now,
  );
}

// ---------------------------------------------------------------------------
// Explaining a recovery decision
// ---------------------------------------------------------------------------

/** What the recovery loop most recently did, or wants to do. Recorded by the
 * server on every switch, proposal, continue and exhaustion so a person can
 * read WHY the account changed instead of noticing it after the fact. */
export type RecoveryDecision = {
  kind: "switch" | "propose" | "continue" | "exhausted";
  at: number;
  target_email?: string;
  target_name?: string;
  target_percent?: number;
  from_email?: string;
  parked_count?: number;
  pegged_window?: string;
};

/** One sentence naming what happened and why: which window pegged, how many
 * sessions it parked, and where the loop moved (or wants to move). The single
 * wording shared by the park card, the settings page and the CLI, so an
 * account change is never explained two different ways. Written in past tense
 * for what was done and future for what is proposed. */
export function describeDecision(d: RecoveryDecision | undefined | null): string | null {
  if (!d) return null;
  const sessions =
    d.parked_count && d.parked_count > 0
      ? `${d.parked_count} session${d.parked_count === 1 ? "" : "s"}`
      : "sessions";
  // The cause, when the meters named a pegged window. Without one the honest
  // statement is just that the sessions parked — never invent a reason.
  const cause = d.pegged_window
    ? `${d.pegged_window} hit its limit on ${d.from_email ?? "the active account"}`
    : `${d.from_email ?? "the active account"} could not continue`;
  const target = d.target_name ?? d.target_email;
  const standing = d.target_percent != null ? ` (${Math.round(d.target_percent)}% used)` : "";
  switch (d.kind) {
    case "switch":
      return `${cause}, parking ${sessions} — switched to ${target ?? "another account"}${standing} and continued them.`;
    case "propose":
      return `${cause}, parking ${sessions}. Recommended: ${target ?? "another account"}${standing} — waiting for you to approve the switch.`;
    case "continue":
      return `${sessions} parked, then the window reopened — continued them on the same account, no switch.`;
    case "exhausted":
      return `${cause}, parking ${sessions} — every saved account is spent, waiting for the earliest window to reset.`;
  }
}

/** The four ways a machine can recover when a session parks on a usage limit.
 * "ask" recommends a switch and waits for approval; "auto" switches without
 * asking; "resume" never changes accounts and waits for the window to reset;
 * "off" leaves sessions parked. */
export type RecoveryMode = "ask" | "auto" | "resume" | "off";

/** The one recovery mode a machine is in, derived from the stored flags so the
 * web selector, the CLI and the decision all read it the same way.
 *
 * Ask-first is the DEFAULT: a machine that has never chosen recommends a
 * switch and waits, rather than either moving its login unannounced or sitting
 * on a limit it could recover from. Every other mode is an explicit choice, so
 * a machine that opted into auto-switch keeps it. Ask-first also wins over a
 * stray auto-switch flag (setRecoveryMode keeps the two exclusive, but a
 * legacy row could carry both). */
export function recoveryModeOf(device: {
  cc_auto_switch?: boolean | null;
  cc_recovery_ask?: boolean | null;
  cc_auto_continue?: boolean | null;
}): RecoveryMode {
  if (device.cc_recovery_ask === true) return "ask";
  if (device.cc_auto_switch === true) return "auto";
  // An explicit "recover nothing" stands on its own, whether or not the ask
  // flag was ever written.
  if (device.cc_auto_continue === false) return "off";
  // Never chosen: the default. An explicit `false` is someone turning asking
  // off, and that means same-account resume only.
  return device.cc_recovery_ask === false ? "resume" : "ask";
}

// ---------------------------------------------------------------------------
// Resume pacing
// ---------------------------------------------------------------------------

/** How far apart sessions may be resumed in one burst.
 *
 * Every resumed session's FIRST request carries its whole context, so a revive
 * is not N cheap messages — it is N large ones. Enough of them inside a minute
 * trip the provider's per-minute cap, and the 429 that comes back is rendered
 * as a usage limit: the sessions re-park, the recovery loop reads those parks
 * as "this account is spent too", and rotates to another account to do it all
 * again (2026-09-17: a machine moved its login five times in nineteen minutes,
 * chasing a rate limit rather than a real quota).
 *
 * One value for BOTH resume paths — the paced continue and the account switch
 * — because they are the same act, and a fast path beside a slow one only
 * means the fast one sets the real rate. */
export const RESUME_BURST_SPACING_MS = 20_000;

/** How many sessions one pass may resume before handing the rest to the next
 * tick. Spacing alone bounds the rate but not the burst: with fifty parked
 * sessions a single pass still walks the whole fleet, and the tail is spending
 * an account's window on work nobody is waiting for. */
export const RESUME_BURST_BATCH = 3;
