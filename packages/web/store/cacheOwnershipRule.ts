import type { AuthTokenState } from "@platform/auth/web";

export type CacheOwnershipVerdict = "serve" | "withhold" | "purge";

/**
 * Who may read the on-disk store cache. The cache belongs to the account whose
 * server-confirmed user row it holds (meta currentUser); it is served only
 * when the stored token names that same principal. A token that is stored but
 * cannot be parsed, or a token store that cannot be read (a locked keychain),
 * is not a sign-out: nothing is served and nothing is destroyed. Every other
 * mismatch (no token, another account's token, a cache with no owner row)
 * means the rows on disk are not this principal's and are purged, keeping
 * only the principal's own pending input.
 */
export function cacheOwnershipVerdict(opts: {
  principal: string | null;
  owner: string | null;
  tokenState: AuthTokenState;
}): CacheOwnershipVerdict {
  if (opts.principal !== null && opts.owner === opts.principal) return "serve";
  if (opts.tokenState === "unparsable" || opts.tokenState === "unreadable") return "withhold";
  return "purge";
}
