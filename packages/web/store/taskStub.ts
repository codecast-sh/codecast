// The optimistic stub a task create paints (CLAUDE.md "Store": creates write
// a stub keyed by a non-Convex id). It is keyed `temp_task_<client key>` and
// carries the key, so the tasks collection's altKey supersede rekeys it onto
// the server row when that row syncs back with the same client_key. Every
// create that paints a task (createTask, lineSlice.fileLineCause) builds it
// here, and removeTaskStub takes it back by the same id.

export const taskStubId = (clientKey: string) => `temp_task_${clientKey}`;
export const isTaskStubId = (id: string) => id.startsWith("temp_task_");

/** A stub with the defaults a fresh task has; `fields` adds or overrides. */
export function taskCreateStub(clientKey: string, fields: Record<string, unknown>) {
  const now = Date.now();
  return {
    _id: taskStubId(clientKey),
    client_key: clientKey,
    short_id: "ct-…",
    status: "open",
    priority: "medium",
    created_at: now,
    updated_at: now,
    ...fields,
  };
}
