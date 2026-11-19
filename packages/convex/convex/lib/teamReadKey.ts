// A team read key's shape and limits. The key is cc_trk_ and 48 hex
// characters (24 random bytes), the shape of an enrollment token. A leaf, so
// the HTTP route and Team settings can use it without loading teamReadKeys.ts.
export const TEAM_READ_KEY_PREFIX = "cc_trk_";
const TEAM_READ_KEY = /^cc_trk_[0-9a-f]{48}$/;

/** The lifetimes an admin picks from when minting. Every key expires. */
export const TEAM_READ_KEY_EXPIRY_DAYS = [30, 90, 365] as const;
export type TeamReadKeyExpiryDays = (typeof TEAM_READ_KEY_EXPIRY_DAYS)[number];

/** Keys a team may hold that are neither revoked nor expired. */
export const MAX_LIVE_TEAM_READ_KEYS = 10;

export function newTeamReadKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return TEAM_READ_KEY_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isTeamReadKey(key: string): boolean {
  return TEAM_READ_KEY.test(key);
}
