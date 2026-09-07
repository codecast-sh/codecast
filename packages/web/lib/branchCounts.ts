import type { ForkChild } from "../store/inboxStore";

// Branch sizes for the fork chips. Pure arithmetic over fields the rows already
// carry (message_count, fork_copied, fork_status), kept out of the component
// file so Fast Refresh keeps BranchSelector's state across edits.

// This branch's own size: total messages minus the history it inherited from the
// parent up to the fork point (fork_copied). Falls back to the raw count for
// legacy forks missing the cursor.
export function branchSizeOf(fork: Pick<ForkChild, "message_count" | "fork_copied">): number {
  const total = fork.message_count ?? 0;
  if (typeof fork.fork_copied !== "number") return total;
  return Math.max(0, total - fork.fork_copied);
}

// The origin line's own size since the fork point: everything it holds minus
// the prefix the forks copied out of it. fork_copied is exactly that prefix
// (the copy walks the origin up to the fork-point timestamp), so no message
// scan is needed — both numbers already sit on rows the client holds live.
// Only a completed server fork can vouch for the prefix: a copy in flight
// reports a partial cursor, and a client-seeded stub only knows the history
// it had loaded. Undefined when nothing can vouch, so the chip hides the number
// rather than show a guess.
export function originSizeSinceFork(
  forks: ReadonlyArray<Pick<ForkChild, "fork_copied" | "fork_status" | "optimistic">>,
  originMessageCount: number | undefined,
): number | undefined {
  if (typeof originMessageCount !== "number") return undefined;
  const vouching = forks.find(
    (f) => !f.optimistic && f.fork_status !== "copying" && typeof f.fork_copied === "number",
  );
  if (!vouching) return undefined;
  return Math.max(0, originMessageCount - vouching.fork_copied!);
}
