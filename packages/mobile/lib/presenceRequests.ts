// Which confirmation another of the person's devices asked for the phone to
// show (components/PresenceRequests): the newest still pending that this
// phone neither began itself nor set aside. Pure, so it is testable.
import type { PresenceAction } from '@codecast/shared/contracts/secrets';

export type PresenceRequest = { challenge_id: string; action: PresenceAction; label?: string; from?: string; expires_at: number };

/** Challenge ids this phone opened itself: its own presses never come back to it as a request. */
export const ownChallenges = new Set<string>();

export function pickPresenceRequest(rows: readonly PresenceRequest[] | undefined, setAside: ReadonlySet<string>, now: number): PresenceRequest | null {
  return (rows ?? []).find((r) => r.expires_at > now && !ownChallenges.has(r.challenge_id) && !setAside.has(r.challenge_id)) ?? null;
}
