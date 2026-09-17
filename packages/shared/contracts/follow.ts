// The follow lease, in numbers both halves agree on.
//
// A follower holds a lease on the leader and renews it while their window is
// on the follow; the leader writes their place only while a live lease exists.
// The two constants carry one invariant — the renew cadence sits well inside
// the lease, so a renew that is merely late does not read as a follower who
// went away. They live here because the web hook that renews and the convex
// functions that expire the lease must read the same numbers, and importing
// the convex module from the browser drags every query and mutation in that
// file (and its whole `./functions` chain) into the client bundle.

/** A lease older than this is dead: the follower's window closed or slept. */
export const FOLLOW_LEASE_MS = 30_000;
/** The follower renews at this cadence, well inside the lease. */
export const FOLLOW_RENEW_MS = 10_000;
