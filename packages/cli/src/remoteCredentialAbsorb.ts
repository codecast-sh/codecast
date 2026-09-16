// A remote Mac runs a pushed COPY of the primary's Claude login.
//
// The primary's daemon ships that copy to ~/.claude/.credentials.json — the file
// form Claude Code reads on Linux (remote/session-move.ts, credentialPushArgs).
// Claude Code on macOS reads the keychain item instead and never looks at the
// file, so on a Mac remote the push landed nowhere: the keychain kept whatever
// login it last had (on InterGalactic, a logged-out stub) and every session
// parked on "Login expired". The keychain cannot be written over plain ssh
// (`security` answers "User interaction is not allowed"), so the remote daemon,
// which runs in the GUI session, is the one process placed to fold the pushed
// file into the item Claude Code reads.
//
// The refresh token is stripped on the way in. A refresh token is single use: a
// remote that rotated it would spend the primary's, and the primary's next
// refresh would fail with invalid_grant and log the laptop out (ccLiveGate.ts
// has the same race between the daemon and a live claude). Without it the
// remote can only spend the access token the primary keeps pushing — ~8h per
// token, re-pushed on every primary refresh and every 30 minutes besides — and
// a session that outlives one token reads "Login expired" until the next push
// lands, never a stranded laptop.

import { credentialHealth } from "./ccAccounts.js";

/** The pushed blob minus what a remote must never hold. Compact JSON so two
 *  absorbs of the same push compare equal; null when the blob is not a Claude
 *  OAuth credential at all. */
export function stripRefreshToken(raw: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const { refreshToken: _rt, refreshTokenExpiresAt: _rte, ...rest } = oauth;
  return JSON.stringify({ ...parsed, claudeAiOauth: rest });
}

export type AbsorbPlan =
  | { action: "write"; credential: string; expiresAt: number }
  | { action: "skip"; reason: string };

/**
 * Decide whether the keychain login should become the pushed one.
 *
 * Writes when the pushed copy carries a live access token that outlasts what
 * the keychain holds — a dead stub, an expired login, or an older push. Leaves
 * a keychain login that is at least as fresh alone, so a push already absorbed
 * is a no-op and a login someone made on the remote by hand is not clobbered by
 * a staler copy.
 */
export function planPushedCredentialAbsorb(args: {
  pushed: string | null;
  active: string | null;
  now?: number;
}): AbsorbPlan {
  const now = args.now ?? Date.now();
  const pushedHealth = credentialHealth(args.pushed, now);
  if (!pushedHealth.pushable) {
    return { action: "skip", reason: `pushed credential unusable: ${pushedHealth.reason ?? "unknown"}` };
  }
  const credential = stripRefreshToken(args.pushed!);
  if (!credential) return { action: "skip", reason: "pushed credential is not a Claude OAuth blob" };
  const activeHealth = credentialHealth(args.active, now);
  if (activeHealth.pushable && (activeHealth.expiresAt ?? 0) >= (pushedHealth.expiresAt ?? 0)) {
    return { action: "skip", reason: "keychain login is at least as fresh as the pushed copy" };
  }
  return { action: "write", credential, expiresAt: pushedHealth.expiresAt! };
}
