// A fork's seed is the direction the human gave the branch, delivered as the
// human's OWN next turn — raw text, no session wrapper, no sender. The branch
// agent sees exactly what it would see had the person typed the direction
// into that thread: nobody to report back to, nothing that says "fork".
//
// The web still marks the turn, and it does so from this stamp rather than
// from anything the agent can read: the pending row carries a fork-seed
// client_id, and the transcript echo adopts that client_id by content match
// (messages.findEchoedPendingMessage), so the mark survives delivery.
export const FORK_SEED_CLIENT_ID_PREFIX = "fork-seed-";

export function forkSeedClientId(key: string): string {
  return `${FORK_SEED_CLIENT_ID_PREFIX}${key}`;
}

export function isForkSeedClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === "string" && clientId.startsWith(FORK_SEED_CLIENT_ID_PREFIX);
}
