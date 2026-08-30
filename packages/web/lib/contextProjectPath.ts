// Where a session started from a context object (task / doc / plan page chat)
// should run. The linked object's OWN project wins over the viewer's
// currentConversation, which may belong to an unrelated repo (~/src etc).
// Chain: the row's explicit project_path → its project's path → (docs) the
// source conversation's repo — the same chain the docs list uses to group by
// project. Returns undefined when the object pins nothing; the caller then
// falls back to the viewer's conversation and the server's team directory
// mappings.

type Row = Record<string, any> | undefined;

export interface ContextPathStoreSlice {
  tasks: Record<string, any>;
  docs: Record<string, any>;
  docDetails: Record<string, any>;
  plans: Record<string, any>;
  projects: Record<string, any>;
  conversations: Record<string, any>;
}

export function resolveContextRow(
  store: ContextPathStoreSlice,
  contextType: string,
  linkedObjectId: string
): Row {
  switch (contextType) {
    case "task":
      return store.tasks[linkedObjectId];
    case "doc":
      // docDetails carries the full row (and its joined conversation) on the
      // doc page; the thin list row is the fallback elsewhere.
      return store.docDetails[linkedObjectId] ?? store.docs[linkedObjectId];
    case "plan":
      return store.plans[linkedObjectId];
    default:
      return undefined;
  }
}

export function resolveContextProjectPath(
  store: ContextPathStoreSlice,
  row: Row
): string | undefined {
  if (!row) return undefined;
  return (
    row.project_path ||
    (row.project_id ? store.projects[row.project_id]?.project_path : undefined) ||
    row.conversation?.project_path ||
    (row.conversation_id
      ? store.conversations[row.conversation_id]?.project_path
      : undefined) ||
    undefined
  );
}
