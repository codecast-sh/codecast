import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A wait added on the web must follow the server's copy afterwards. The
// server's wait never equals the painted one (its own created_at, a resolved
// repository, possibly met at once), so a field lock on `waits` would never
// retire and the row would show "waiting" forever after the PR merged. `waits`
// is an unprotected field (tasks.unprotectedFields) for that reason.

const TASK_ID = "b".repeat(32);
const row = (waits?: any[]) => ({ _id: TASK_ID, short_id: "ct-1", title: "T", status: "open", updated_at: 1, ...(waits ? { waits } : {}) });

describe("task waits local-first", () => {
  beforeEach(() => {
    useInboxStore.setState({ tasks: { [TASK_ID]: row() }, pending: {} });
  });

  it("paints the wait at once and follows the server's set after", () => {
    useInboxStore.getState().addWait("ct-1", { id: "wx", target: { kind: "pr_merged", repository: "", pr_number: 42 } });
    let task = useInboxStore.getState().tasks[TASK_ID] as any;
    expect(task.waits.map((w: any) => [w.id, w.state])).toEqual([["wx", "waiting"]]);
    expect(useInboxStore.getState().pending[`tasks:${TASK_ID}:waits`]).toBeUndefined();

    const echoed = { id: "wx", kind: "pr_merged", repository: "acme/app", pr_number: 42, state: "waiting", created_at: 999 };
    useInboxStore.getState().syncTable("tasks", [{ ...row([echoed]), updated_at: 2 }], { isDelta: true });
    const met = { ...echoed, state: "met", note: "merged" };
    useInboxStore.getState().syncTable("tasks", [{ ...row([met]), updated_at: 3 }], { isDelta: true });
    task = useInboxStore.getState().tasks[TASK_ID] as any;
    expect(task.waits).toEqual([met]);
  });
});
