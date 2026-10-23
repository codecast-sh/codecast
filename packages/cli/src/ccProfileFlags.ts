// Flags stamped on a saved profile in the profile index (CcProfileMeta): an
// organization's refusal of subscription access, set by the daemon's usage
// refresh, and a reservation for one job, set by a person. The heartbeat
// reports both, and auto-switch reads them (fallbackProfiles).
import { CcAccountError, invalidateAccountsCache, readProfileIndex, writeProfileIndex } from "./ccAccounts.js";

/** The account's organization refuses subscription OAuth: the 403 Claude
 *  Code shows as "Your organization has disabled Claude subscription access".
 *  The usage endpoint throws it as a CloudApiError, the model probe as a
 *  CcAccountError quoting the body; both carry the provider's wording. */
export function isOrgAccessRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /oauth_not_allowed_for_organization|not allowed for this organization/i.test(message);
}

/** Keep saved profiles for one job (`purpose`), or give them back with null.
 *  Returns the names whose reservation changed; an unknown name throws. */
export function setReserved(names: readonly string[], purpose: string | null): string[] {
  const index = readProfileIndex();
  const unknown = names.filter((n) => !index.profiles[n]);
  if (unknown.length) throw new CcAccountError(`no saved profile named ${unknown.join(", ")} (cast accounts ls)`);
  const changed: string[] = [];
  for (const name of names) {
    const { reserved_for: prev, ...rest } = index.profiles[name];
    if ((prev ?? null) === purpose) continue;
    index.profiles[name] = purpose ? { ...rest, reserved_for: purpose } : rest;
    changed.push(name);
  }
  if (changed.length) {
    writeProfileIndex(index);
    invalidateAccountsCache();
  }
  return changed;
}

/** Stamp (or clear, with `at` null) an account's org refusal on every profile
 *  covering it. Returns the profile names whose stamp changed. */
export function setAccessRefused(key: string, at: number | null): string[] {
  const index = readProfileIndex();
  const changed: string[] = [];
  for (const [name, meta] of Object.entries(index.profiles)) {
    if ((meta.uuid || meta.email) !== key || !!meta.access_refused_at === (at !== null)) continue;
    const { access_refused_at: _prev, ...rest } = meta;
    index.profiles[name] = at === null ? rest : { ...rest, access_refused_at: at };
    changed.push(name);
  }
  if (changed.length) {
    writeProfileIndex(index);
    invalidateAccountsCache();
  }
  return changed;
}
