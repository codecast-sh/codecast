/**
 * Which of a session's docs belong to a task it filed.
 *
 * A task and a doc share a session, but the session may be a long-lived loop
 * that filed the task at the end of months of notes. Joining on the session
 * alone attaches the whole journal to every task it ever filed (ct-49328
 * inherited 89 docs). A doc belongs to the task when the session named the
 * task in it, or wrote it in the same sitting as the filing.
 */

/** How far from the task's filing a doc still counts as "the same sitting". */
export const RELATED_DOC_WINDOW_MS = 4 * 60 * 60 * 1000;

export type RelatedDocInput = {
  content?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
};

export type RelatedDocTaskInput = {
  short_id?: string | null;
  created_at?: number | null;
};

/**
 * The caller has already matched the doc to the task's session; this decides
 * whether that session wrote the doc FOR the task. `content` may be absent on
 * the client, where doc bodies are cached separately; then only timing counts.
 */
export function docRelatesToTask(
  doc: RelatedDocInput,
  task: RelatedDocTaskInput,
  windowMs: number = RELATED_DOC_WINDOW_MS,
): boolean {
  if (task.short_id && doc.content && doc.content.includes(task.short_id)) return true;
  const filedAt = task.created_at;
  if (typeof filedAt !== "number") return true;
  const near = (ts: number | null | undefined) => typeof ts === "number" && Math.abs(ts - filedAt) <= windowMs;
  return near(doc.created_at) || near(doc.updated_at);
}
