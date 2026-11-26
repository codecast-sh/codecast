import type { CcUsageSnapshot } from "./ccAccounts.js";
import type { RateLimitFingerprint } from "./ccRateLimitHeaders.js";

// Account attribution for a scope-less token. A setup-token can't read its own
// profile or usage, but every model response carries the account's unified
// rate-limit windows. Two credentials whose window reset timestamps match to
// the second belong to the same account — that is how a freshly minted token
// is checked against the profile it was minted for before it is stored (the
// browser may have been signed into a different account; the token itself
// can't say whose it is).

/** How two credentials' windows compare, judged on reset times alone
 *  (utilization moves between two probes seconds apart).
 *  - "different": a reset both carry differs, or only one side has a 5-hour
 *    window (two plans, so two accounts).
 *  - "same": the 7d and 5h resets both match.
 *  - "weekly": the 7d reset matches and neither side has a 5-hour window. An
 *    account without one sends no 5h headers at all (two Team seats,
 *    2026-11-25), so for it the weekly reset is all there is. That is weak
 *    evidence: resets land on the hour, so unrelated accounts share one about
 *    once in 168, and seats created together more often.
 *  - "unknown": a side carries no 7d reset, so nothing can be compared. */
export type FingerprintMatch = "same" | "weekly" | "different" | "unknown";

export function compareAccountFingerprints(a: RateLimitFingerprint, b: RateLimitFingerprint): FingerprintMatch {
  if (a.seven_day_reset == null || b.seven_day_reset == null) return "unknown";
  if (a.seven_day_reset !== b.seven_day_reset) return "different";
  if (a.five_hour_reset == null && b.five_hour_reset == null) return "weekly";
  return a.five_hour_reset === b.five_hour_reset ? "same" : "different";
}

/** A snapshot's reset (ms) and a header's reset (s) name the same second. */
function sameResetSecond(ms: number | undefined, s: number | null): boolean {
  return ms != null && s != null && Math.abs(ms / 1000 - s) <= 2;
}

/** Which SAVED profile a scope-less token belongs to, judged from the usage
 *  snapshots (each carries that account's window reset times, fetched with the
 *  profile's own credential). The 7d reset is stable for a week and must match;
 *  the 5h reset must match too while the snapshot's window is still open (a
 *  closed window has rolled since, so its stale reset proves nothing). Exactly
 *  one hit names the owner; none or several = unknown. */
export function attributeFingerprint(
  fp: RateLimitFingerprint,
  profiles: Record<string, { uuid?: string; email?: string }>,
  usage: Record<string, CcUsageSnapshot>,
  now: number,
): string | null {
  if (fp.seven_day_reset == null) return null;
  const hits: string[] = [];
  for (const [name, meta] of Object.entries(profiles)) {
    const snap = usage[meta.uuid || meta.email || ""];
    if (!snap || !sameResetSecond(snap.weekly?.resets_at, fp.seven_day_reset)) continue;
    const sessionOpen = snap.session?.resets_at != null && snap.session.resets_at > now;
    if (sessionOpen && !sameResetSecond(snap.session?.resets_at, fp.five_hour_reset)) continue;
    hits.push(name);
  }
  return hits.length === 1 ? hits[0] : null;
}

export type MintedOwner = { owner: string; caveat?: string } | { rejected: string };

/**
 * Whose account a freshly minted setup-token is, before it is stored.
 * `mine` is the fingerprint of `profile`'s saved login, or null when that login
 * could not be asked (dead, expired, the probe threw). `label` names the
 * account to the person (its email when known).
 *
 * It rejects only on proof of a different account: the direct comparison, or,
 * when that could not run, `profile`'s own snapshot of this week. Anything
 * short of a full match is stored for `profile` (the account the guided flow
 * told the person to sign into) with a note saying how far it was checked: a
 * weekly-only match, a weekly window another saved account shares, or nothing
 * comparable at all. When nothing can be compared, the usage snapshots of the
 * saved profiles are the witness.
 *
 * A snapshot moves the token to ANOTHER saved profile only on both windows:
 * writing it there replaces that profile's token, and a weekly reset alone is
 * shared by seats created together.
 */
export function judgeMintedOwner(input: {
  profile: string;
  label: string;
  mine: RateLimitFingerprint | null;
  minted: RateLimitFingerprint;
  profiles: Record<string, { uuid?: string; email?: string }>;
  usage: Record<string, CcUsageSnapshot>;
  now: number;
}): MintedOwner {
  const { profile, label, mine, minted, profiles, usage, now } = input;
  // With no saved login to ask, the profile's own snapshot can still rule it
  // out: a weekly reset is fixed for the week, so a current one that differs
  // from the token's is a different account.
  const ownWeekly = usage[profiles[profile]?.uuid || profiles[profile]?.email || ""]?.weekly?.resets_at;
  const ownSnapshotDisagrees = ownWeekly != null && ownWeekly > now && minted.seven_day_reset != null && !sameResetSecond(ownWeekly, minted.seven_day_reset);
  const compared = mine ? compareAccountFingerprints(mine, minted) : "unknown";
  const match = compared === "unknown" && ownSnapshotDisagrees ? "different" : compared;
  if (match === "same") return { owner: profile };
  if (match === "weekly") {
    // An account with a 5-hour window cannot be the owner of a token whose
    // responses carry none.
    const twins = Object.entries(profiles)
      .filter(([name, meta]) => {
        const snap = usage[meta.uuid || meta.email || ""];
        return name !== profile && !snap?.session && sameResetSecond(snap?.weekly?.resets_at, minted.seven_day_reset);
      })
      .map(([name, meta]) => meta.email ?? name);
    if (twins.length) {
      const others = twins.length > 1 ? `${twins[0]} and ${twins.length - 1} more share` : `${twins[0]} shares`;
      return { owner: profile, caveat: `not verified — ${others} this account's weekly window` };
    }
    return { owner: profile, caveat: `checked on the weekly window only (${label} has no 5-hour window)` };
  }
  const attributed = attributeFingerprint(minted, profiles, usage, now);
  // attributeFingerprint checks the 5h reset only while the snapshot's window
  // is open; without one, its hit rests on the weekly reset alone.
  const attributedSnap = attributed ? usage[profiles[attributed].uuid || profiles[attributed].email || ""] : undefined;
  const strong = !!attributedSnap?.session?.resets_at && attributedSnap.session.resets_at > now;
  if (match === "different") {
    // The direct comparison ruled `profile` out, whatever a snapshot says.
    if (attributed && attributed !== profile && strong) return { owner: attributed };
    return {
      rejected: `the browser signed into a different Claude account than ${label} — sign in to claude.ai as ${label} and try again`,
    };
  }
  if (attributed && strong) return { owner: attributed };
  if (attributed && attributed !== profile) {
    const other = profiles[attributed].email ?? attributed;
    return { owner: profile, caveat: `not verified — its weekly window matches ${other}` };
  }
  if (attributed === profile) return { owner: profile, caveat: "checked on the weekly window only" };
  return {
    owner: profile,
    caveat: mine
      ? `not verified — the rate-limit windows of ${label} and the new token could not be compared`
      : `not verified — the saved login for ${label} could not vouch for it`,
  };
}
