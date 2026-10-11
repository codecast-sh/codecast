// The usage poll: one pass over the active login and every saved profile,
// reading each account's limit windows from the usage endpoint into the usage
// cache. Only the daemon's timer and a person pressing refresh run it, so the
// daemon loads this module when it polls rather than on every boot.

import { atomicWriteFile } from "./atomicWrite.js";
import {
  activeAccountSummary,
  credentialHealth,
  fetchTokenUsageSnapshot,
  fetchUsageSnapshot,
  isLivePollOverdue,
  isLiveUsageFresh,
  isOrgAccessRefusal,
  markLoginExpired,
  noteActiveAccount,
  parseProfile,
  readAccountTokenValue,
  readActiveCredentialAsync,
  readProfileIndex,
  readProfileSecretAsync,
  readUsageCache,
  refreshActiveCredential,
  refreshProfileCredential,
  resnapshotActiveProfile,
  setAccessRefused,
  usageCachePath,
  type CcProfile,
  type CcUsageSnapshot,
} from "./ccAccounts.js";
import { nextUsageRetry, type UsageRetryState } from "./usageRetry.js";

export interface UsageRefreshSummary {
  probed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
  // Dormant profiles whose tokens were rotated on this pass to make the probe
  // possible (see refreshProfileCredential).
  rotated: string[];
  // Dormant profiles whose refresh token the endpoint refused on this pass:
  // now marked login_expired_at in the index.
  expired: string[];
}

/**
 * Refresh usage snapshots for the active login + every saved profile. A
 * dormant profile whose access token has lapsed is rotated first with its own
 * refresh token (refreshProfileCredential) — its reading otherwise froze at
 * the last probe before the token died, and a frozen pegged window kept the
 * account out of auto-switch for days. A profile already marked login-expired
 * is skipped (its last snapshot survives) until a re-save clears the mark.
 * Per-account probes are throttled by `minIntervalMs` (0 = probe everything
 * now) so callers can invoke this freely.
 */
export async function refreshUsageSnapshots(
  opts: {
    fetchImpl?: typeof fetch;
    now?: number;
    minIntervalMs?: number;
    // Profiles a live claude runs on (their store, ccLiveGate): the session
    // rotates those itself, and a second rotation here would strand it.
    heldProfiles?: ReadonlySet<string>;
    // A live claude runs on the keychain login (ccLiveGate): it rotates that
    // login itself, so an expired active token is read back later, not rotated.
    activeHeld?: boolean;
  } = {},
): Promise<UsageRefreshSummary> {
  const now = opts.now ?? Date.now();
  const minInterval = opts.minIntervalMs ?? 4 * 60 * 1000;
  const cache = readUsageCache();
  const summary: UsageRefreshSummary = { probed: [], skipped: [], failed: [], rotated: [], expired: [] };

  const jobs = new Map<string, { label: string; token: string; viaToken?: boolean }>();
  const activeCred = await readActiveCredentialAsync();
  const active = activeAccountSummary(activeCred);
  const activeKey = active?.uuid || active?.email;
  const activeSince = noteActiveAccount(activeKey, now);
  // Keychain reads go async: this runs on a daemon timer, and a busy keychain
  // answered `security` in 2 to 3s (7 calls in one day's log, 2026-09-02).
  // The signed-in grant is the authority for its own account. A saved profile
  // of that account is often an older refresh token: refreshing the copy gets
  // a 401 and would stamp the login expired while this machine is still signed
  // in (2026-09-22: claude@, the fullest account, marked dead two seconds after
  // a switch back onto it).
  const activeHealth = activeCred ? credentialHealth(activeCred, now) : null;
  let activeKeySettled = false;
  if (activeKey && activeCred && activeHealth?.pushable) {
    try {
      const token = JSON.parse(activeCred)?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) {
        jobs.set(activeKey, { label: "active", token });
        activeKeySettled = true;
      }
    } catch {}
  } else if (activeKey && activeCred && activeHealth?.usable && opts.activeHeld) {
    activeKeySettled = true;
    summary.skipped.push("active");
  } else if (activeKey && activeCred && activeHealth?.usable) {
    activeKeySettled = true;
    const rotated = await refreshActiveCredential({ fetchImpl: opts.fetchImpl, now });
    if (rotated.refreshed) {
      summary.rotated.push("active");
      const fresh = await readActiveCredentialAsync();
      try {
        const token = fresh ? JSON.parse(fresh)?.claudeAiOauth?.accessToken : undefined;
        if (typeof token === "string" && token) jobs.set(activeKey, { label: "active", token });
      } catch {}
      // The rotation spent the previous refresh token. Fold the new pair into
      // the saved profile before a later switch restores the spent one.
      resnapshotActiveProfile();
    } else if (rotated.dead) {
      const doomed = readProfileIndex();
      const match = Object.entries(doomed.profiles).find(([, meta]) => (meta.uuid || meta.email) === activeKey);
      if (match && !match[1].login_expired_at) {
        markLoginExpired(match[0], now);
        summary.expired.push(match[0]);
      }
    } else if (rotated.reason) {
      summary.failed.push({ name: "active", reason: rotated.reason });
    }
  }
  const index = readProfileIndex();
  const knownKeys = new Set<string>();
  // When the saved login cannot be read (dead, or held by a live session), a
  // live setup token still reads the account's windows (fetchTokenUsageSnapshot).
  // Without it the meter froze while that account's sessions kept running.
  const viaSetupToken = (key: string, name: string): boolean => {
    const setupToken = readAccountTokenValue(name);
    if (setupToken) jobs.set(key, { label: name, token: setupToken, viaToken: true });
    return !!setupToken;
  };
  for (const [name, meta] of Object.entries(index.profiles)) {
    const key = meta.uuid || meta.email;
    if (!key) continue;
    knownKeys.add(key);
    if (jobs.has(key)) continue; // active covers it with the freshest token
    // The live grant was already judged above. A stale snapshot of the same
    // account must not get its own refresh, or a 401 on the spent copy stamps
    // the signed-in login dead.
    if (key === activeKey && activeKeySettled) {
      summary.skipped.push(name);
      continue;
    }
    if (meta.login_expired_at) {
      if (!viaSetupToken(key, name)) summary.skipped.push(name); // dead grant — keep last snapshot, no retry
      continue;
    }
    const raw = await readProfileSecretAsync(name);
    let profile: CcProfile | null = null;
    try {
      profile = raw ? parseProfile(raw) : null;
    } catch {
      profile = null;
    }
    if (!profile) {
      // An index entry with no readable secret behind it (keychain item gone,
      // blob corrupt): nothing can probe or switch to it. Same standing as a
      // refused grant — dead until the account signs in again and is
      // re-saved — so it is marked the same way rather than skipped in
      // silence, where it would read as live with a frozen meter.
      markLoginExpired(name, now);
      summary.expired.push(name);
      continue;
    }
    let token = profile.credentials?.claudeAiOauth?.accessToken;
    if (!credentialHealth(JSON.stringify(profile.credentials), now).pushable) {
      const prev = cache.accounts[key];
      // A live feed keeps fetched_at moving, so only the overdue rule can get
      // past this for an account whose sessions are running.
      if (prev && now - prev.fetched_at < minInterval && !isLivePollOverdue(prev, now)) {
        summary.skipped.push(name); // inside the throttle — rotating now would buy nothing
        continue;
      }
      if (opts.heldProfiles?.has(name)) {
        // A live session rotates this store; read it back next pass.
        if (!viaSetupToken(key, name)) summary.skipped.push(name);
        continue;
      }
      const rotated = await refreshProfileCredential(name, { fetchImpl: opts.fetchImpl, now });
      if (!rotated.refreshed) {
        if (rotated.dead) summary.expired.push(name);
        else summary.failed.push({ name, reason: rotated.reason ?? "token refresh failed" });
        continue;
      }
      summary.rotated.push(name);
      token = rotated.accessToken;
    }
    if (typeof token === "string" && token) jobs.set(key, { label: name, token });
  }
  if (activeKey) knownKeys.add(activeKey);

  const retries: Record<string, UsageRetryState> = { ...cache.retries };
  let retriesChanged = false;

  const probed = new Map<string, CcUsageSnapshot>();
  for (const [key, job] of jobs) {
    const prev = cache.accounts[key];
    // A just-activated account is probed regardless of the throttle: its last
    // snapshot predates the switch, and the server holds off judging the
    // account until one fetched after the activation lands.
    const predatesActivation =
      key === activeKey && activeSince !== undefined && !!prev && prev.fetched_at < activeSince;
    const backoff = retries[key];
    // Why: the endpoint named a wait (429 Retry-After) or we picked one after a
    // refusal; asking again before it earns another refusal and, on a 429, can
    // extend the block. This outranks both the activation probe and the live
    // feed's overdue stamp — no local urgency makes a rate-limited endpoint
    // answer. A human pressing refresh comes in with minInterval 0 and is let
    // through; only the poll is held (ct-49527).
    if (minInterval > 0 && backoff && now < backoff.retry_at) {
      summary.skipped.push(job.label);
      continue;
    }
    const mustProbe = predatesActivation || isLivePollOverdue(prev, now);
    // A session of this account feeds the windows every turn, so a poll would
    // spend the usage endpoint's tight budget for a staler answer (ct-49525).
    if (!mustProbe && (isLiveUsageFresh(prev, now) || (prev && now - prev.fetched_at < minInterval))) {
      summary.skipped.push(job.label);
      continue;
    }
    try {
      // polled_at is what bounds the live feed's hold on this poll; it rides
      // the snapshot so a later live update can carry it forward.
      const snap = job.viaToken
        ? await fetchTokenUsageSnapshot(job.token, prev, { fetchImpl: opts.fetchImpl, now })
        : await fetchUsageSnapshot(job.token, { fetchImpl: opts.fetchImpl, now });
      probed.set(key, { ...snap, polled_at: now });
      summary.probed.push(job.label);
      if (retries[key]) {
        delete retries[key]; // recovered — the next failure starts at 30s again
        retriesChanged = true;
      }
      setAccessRefused(key, null); // the organization lets it in again
    } catch (err) {
      retries[key] = nextUsageRetry(retries[key], err, now);
      retriesChanged = true;
      // Keeps being probed on the backoff, so the stamp clears on its own.
      if (isOrgAccessRefusal(err)) setAccessRefused(key, now);
      summary.failed.push({ name: job.label, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (probed.size > 0 || retriesChanged) {
    // Re-read rather than write back the copy taken before the probes: a live
    // statusLine post can land during them (keychain reads and the endpoint
    // together run for seconds), and writing the stale copy would erase it.
    const latest = readUsageCache();
    for (const [key, snap] of probed) {
      const disk = latest.accounts[key];
      // A live post landed while this pass ran. Its unified windows are newer,
      // so keep them and take from the endpoint only what it alone can say —
      // including the stamp that lets the feed hold off the next poll.
      latest.accounts[key] =
        disk && disk.fetched_at > snap.fetched_at
          ? {
              ...disk,
              polled_at: snap.polled_at,
              ...(snap.weekly_scoped && { weekly_scoped: snap.weekly_scoped }),
              ...(snap.extra && { extra: snap.extra }),
            }
          : snap;
    }
    // Drop entries for deleted profiles so the cache can't grow unbounded.
    for (const key of Object.keys(latest.accounts)) {
      if (!knownKeys.has(key)) delete latest.accounts[key];
    }
    for (const key of Object.keys(retries)) {
      if (!knownKeys.has(key)) delete retries[key];
    }
    if (Object.keys(retries).length > 0) latest.retries = retries;
    else delete latest.retries;
    atomicWriteFile(usageCachePath(), JSON.stringify(latest, null, 2), { mode: 0o644 });
  }
  return summary;
}
