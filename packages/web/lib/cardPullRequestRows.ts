// The inbox chip feed's pull request rows (pull_requests.sessionCardPRs)
// carry only the fields a chip draws. A leaf module: the store's replication
// applies the same overlay as the feeder.
import { SESSION_CARD_PR_FIELDS } from "@codecast/convex/convex/lib/prSessions";

type Row = Record<string, unknown>;

/** A pull request row some full feed wrote: every one carries its body, the chip feed never does. */
export function isFullPullRequest(row: { body?: unknown }): boolean {
  return typeof row.body === "string";
}

/**
 * Lay chip rows over the rows the store holds, so a push never drops what a
 * fuller feed cached (its body, its other links), and a chip field the
 * payload leaves out (a cleared draft flag) clears. A row nothing fuller has
 * written has no body, which is how the PR page and the timeline know it is
 * not loaded. The detail a fuller feed cached under an older state would
 * contradict the new one: the merge state goes until that feed sends it
 * again, and the checks, which live in pullRequestDetails, are hidden by
 * their reader while they were read under another checks_state
 * (lib/detailRows joinPullRequestDetail).
 */
export function overlayCardPullRequests(rows: readonly Row[] | undefined, cached: Record<string, Row> | undefined, pending?: Record<string, unknown>): Row[] {
  const locked = lockedFields(pending);
  return (rows ?? []).map((row) => {
    const prev = cached?.[String(row._id)];
    const next: Row = { ...prev };
    // A field this window wrote and the server has not echoed is the
    // window's, not the server's: carried here it would read as the echo and
    // release the lock early.
    for (const field of locked.get(String(row._id)) ?? []) delete next[field];
    for (const field of SESSION_CARD_PR_FIELDS) next[field] = row[field];
    if (prev && (prev.state !== row.state || prev.draft !== row.draft)) next.mergeable_state = undefined;
    return next;
  });
}

/** Pull request fields with a pending lock, by row id ("pullRequests:<id>:<field>"). */
function lockedFields(pending: Record<string, unknown> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key in pending ?? {}) {
    if (!key.startsWith("pullRequests:")) continue;
    const rest = key.slice("pullRequests:".length);
    const colon = rest.lastIndexOf(":");
    if (colon < 0 || (pending![key] as { type?: string })?.type !== "field") continue;
    const id = rest.slice(0, colon);
    const list = out.get(id);
    if (list) list.push(rest.slice(colon + 1));
    else out.set(id, [rest.slice(colon + 1)]);
  }
  return out;
}

/**
 * Replicated pull request rows for a follower's own store. The host ships a
 * whole row whenever it writes one, and the host's copy of anything but the
 * chip fields may be days old (hydrated from disk, then only chip fields
 * refreshed). Every surface that draws more than a chip (the PR page, the
 * timeline, a conversation) feeds that row in this window itself, so over a
 * full row this window holds only the host's chip fields land, and nothing
 * this window wrote and the server has not echoed is offered as the echo. A
 * row this window lacks, or holds only as a chip, lands as sent.
 */
export function overlayReplicatedPullRequests(rows: readonly Row[], cached: Record<string, Row> | undefined, pending?: Record<string, unknown>): Row[] {
  let out: Row[] | null = null;
  const locked = lockedFields(pending);
  rows.forEach((row, i) => {
    const prev = cached?.[String(row._id)];
    if (!prev || !isFullPullRequest(prev)) return;
    const next: Row = { ...prev };
    for (const field of locked.get(String(row._id)) ?? []) delete next[field];
    for (const field of SESSION_CARD_PR_FIELDS) next[field] = row[field];
    (out ??= [...rows])[i] = next;
  });
  return out ?? (rows as Row[]);
}
