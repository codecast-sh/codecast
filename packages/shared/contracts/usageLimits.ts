// Account usage-limit windows: the compact per-account snapshot the daemon
// probes from the provider's usage endpoint (percentages + reset times only —
// never tokens) and the pure predicates every reader applies to it. Shared by
// the Convex backend (auto-switch decision, validators), the web (meters,
// header chip), and the CLI (`cast usage`), so a window means the same thing
// wherever it is read.

export type CcUsageWindow = { percent: number; resets_at?: number; label?: string };

export type CcUsage = {
  fetched_at: number;
  session?: CcUsageWindow; // rolling short window (5h / sub-24h)
  weekly?: CcUsageWindow; // 7d, all models
  weekly_scoped?: CcUsageWindow; // 7d, model-scoped
  extra?: { percent: number; enabled: boolean };
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

/** Order accounts by how much room they have left: known headroom first
 * (lowest worst-window percent wins), accounts with no usage data after every
 * known one — eligible, just unproven. Stable for ties. */
export function rankByHeadroom<P extends { usage?: CcUsage | null }>(profiles: P[], now: number): P[] {
  const score = (p: P): number => (p.usage ? (worstUsagePercent(p.usage, now) ?? 0) : 101);
  return [...profiles].sort((a, b) => score(a) - score(b));
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
