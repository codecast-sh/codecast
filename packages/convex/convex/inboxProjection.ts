import { INBOX_WINDOW_CAPS } from "@codecast/shared/contracts";
import type { Id } from "./_generated/dataModel";
// The per-user inbox triage/visibility stamps, projected off a conversation
// doc. EVERY query that emits a conversation summary the client may seed into
// its sessions cache (fork children, fork parent details, palette recents,
// task-linked sessions, …) must spread this in. The client's cache is
// local-first and persists seeded rows across reloads, so a summary that omits
// these fields seeds a stashed/dismissed/killed session as an ACTIVE row — it
// then renders as a needs-input card on every boot until a full row re-delivers
// the stamps (the "forks flash in the inbox on reload" bug, ct-42666).
//
// All five are free fields already on the doc in hand — no extra reads.
export function inboxVisibilityFields(conv: {
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_stash_hidden?: boolean | null;
  inbox_killed_at?: number | null;
  inbox_pinned_at?: number | null;
}) {
  return {
    inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
    inbox_stashed_at: conv.inbox_stashed_at ?? null,
    inbox_stash_hidden: conv.inbox_stash_hidden ?? null,
    inbox_killed_at: conv.inbox_killed_at ?? null,
    inbox_pinned_at: conv.inbox_pinned_at ?? null,
  };
}

// Pinned rows are a deliberate, bounded set: the inbox scan reads the newest
// INBOX_PINNED_CAP pins (by_user_pinned, descending) and flags overflow, so the
// cap is enforced where the user can see it — a pin that would exceed it is
// refused by every writer (conversations.patchConversation throws; the dispatch
// patch rail drops the field). Sync-convergence C2. Single source: the shared
// window caps (INBOX_WINDOW_CAPS), which the replica's selection also reads.
export const INBOX_PINNED_CAP = INBOX_WINDOW_CAPS.pinned;

export const PIN_CAP_ERROR = `Pin limit reached: you already hold ${INBOX_PINNED_CAP} pinned sessions. Unpin one to pin another.`;

// True when `patch` pins a row that is not pinned yet and the user already
// holds the cap. One indexed read, only on a pin.
export async function pinCapExceeded(
  ctx: { db: any },
  userId: Id<"users">,
  conv: { inbox_pinned_at?: number | null },
  patch: Record<string, any>,
): Promise<boolean> {
  if (!patch.inbox_pinned_at || conv.inbox_pinned_at) return false;
  const pinned = await ctx.db
    .query("conversations")
    .withIndex("by_user_pinned", (q: any) => q.eq("user_id", userId).gt("inbox_pinned_at", 0))
    .take(INBOX_PINNED_CAP);
  return pinned.length >= INBOX_PINNED_CAP;
}
