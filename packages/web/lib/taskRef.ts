// The one task a ref names, by its _id or its short id (ct-…). A LOOKUP of a row the caller already
// names, never a list: the workspace enumeration guard allows this file for that shape only.
type RefRow = { _id: string; short_id?: string };

export function taskByRef<T extends RefRow>(tasks: Record<string, T> | null | undefined, ref: string | null | undefined): T | null {
  if (!tasks || !ref) return null;
  const byId = tasks[ref];
  if (byId) return byId;
  for (const id in tasks) if (tasks[id]?.short_id === ref) return tasks[id];
  return null;
}
