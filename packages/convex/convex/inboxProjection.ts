// The per-user inbox triage/visibility stamps, projected off a conversation
// doc. EVERY query that emits a conversation summary the client may seed into
// its sessions cache (fork children, fork parent details, palette recents,
// task-linked sessions, …) must spread this in. The client's cache is
// local-first and persists seeded rows across reloads, so a summary that omits
// these fields seeds a stashed/dismissed/killed session as an ACTIVE row — it
// then renders as a needs-input card on every boot until a full row re-delivers
// the stamps (the "forks flash in the inbox on reload" bug, ct-42666).
//
// All four are free fields already on the doc in hand — no extra reads.
export function inboxVisibilityFields(conv: {
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_killed_at?: number | null;
  inbox_pinned_at?: number | null;
}) {
  return {
    inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
    inbox_stashed_at: conv.inbox_stashed_at ?? null,
    inbox_killed_at: conv.inbox_killed_at ?? null,
    inbox_pinned_at: conv.inbox_pinned_at ?? null,
  };
}
