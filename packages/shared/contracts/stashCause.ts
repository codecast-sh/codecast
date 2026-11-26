// ── Who or what set a stash aside ───────────────────────────────────────────
//
// A stash used to be only a stamp (inbox_stashed_at) and a hidden flag, so a
// row the system put aside read "Stashed" exactly like one the person put
// aside, and nobody could tell which (ct-101902). Every server write that sets
// the stamp now writes inbox_stash_cause beside it, and every write that clears
// the stamp clears the cause. A row stamped before the cause existed has none
// and is drawn as before: no attribution is guessed.
//
// The object a system cause points at is already on the row (forked_from for a
// fork, agent_task_id or workflow_run_id for a run), so the cause names only
// the kind; the card reads the pointer from the row, with no second copy.

export const STASH_CAUSES = {
  /** The person: a stash gesture on web or phone, or `cast stash`. */
  person: { word: "By you", title: "You stashed it" },
  /** A close the server turned into a stash because the session was still in flight. */
  close_aside: { word: "Set aside on close", title: "You closed it while it was still working, so it was stashed instead of stopped" },
  /** A closed role, anchor or standing-trigger session a trigger woke: it runs out of sight. */
  close_wake: { word: "Woke after close", title: "A trigger woke this closed session; it keeps working stashed and hidden until it asks for you" },
  /** A fork the daemon made of a session (a cloud agent's branch) the person never opened. */
  fork: { word: "Forked", title: "A branch of another session, stashed when it was made; open the session it came from" },
  /** The log session of a workflow run made for a task. */
  run_log: { word: "Run log", title: "The log of a workflow run for a task; you meet the run on its task and in your decisions" },
  /** A trigger run that finished and reported: folded out of the way. */
  run_folded: { word: "Folded run", title: "A trigger run that finished and reported, folded out of the way" },
  /** An earlier run of a trigger, set aside when the next run started. */
  run_superseded: { word: "Earlier run", title: "An earlier run of this trigger, set aside when the next run started" },
  /** A repeating trigger's run with no session to nest under. */
  run_repeating: { word: "Repeating run", title: "A repeating trigger's run, stashed so it surfaces only when it needs you" },
} as const;

export type StashCause = keyof typeof STASH_CAUSES;

/** The words for a row's stash cause, or null when the row is not stashed or
 *  its stash predates causes (or names one this build does not know). */
export function stashCauseOf(
  row: { inbox_stashed_at?: number | null; inbox_stash_cause?: string | null },
): (typeof STASH_CAUSES)[StashCause] & { cause: StashCause } | null {
  if (!row.inbox_stashed_at || !row.inbox_stash_cause) return null;
  const known = (STASH_CAUSES as Record<string, { word: string; title: string }>)[row.inbox_stash_cause];
  return known ? { ...known, cause: row.inbox_stash_cause as StashCause } as any : null;
}
