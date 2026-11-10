import type { InboxSession } from "../store/inboxStore";

// The corner color is keyed by the ROOT of the fork tree so every session in
// the same tree — parent, forks, forks-of-forks — renders the same color.
// Walk forked_from as far as the loaded cache allows; an unloaded ancestor's
// id is still a key all of its visible descendants agree on.
export function forkTreeRootId(session: InboxSession, sessions: Record<string, InboxSession>): string {
  let cur = session;
  const seen = new Set([cur._id]);
  while (cur.forked_from) {
    const parent = sessions[cur.forked_from];
    if (!parent || seen.has(parent._id)) return cur.forked_from;
    cur = parent;
    seen.add(cur._id);
  }
  return cur._id;
}
