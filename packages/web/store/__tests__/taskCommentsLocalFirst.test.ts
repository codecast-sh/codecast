import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { expireExcludeTombstones } from "../cacheRetention";

// Regression for the Threads-page crash "a is not iterable": addTaskComment
// pushes onto task.comments, and the auto-pending middleware once recorded
// that deep patch's LEAF (the single pushed comment object) as the field lock
// for `comments`. Every later server push then re-asserted the lone object as
// the whole field, the mismatched shape never echoed, and the corrupted row
// persisted to IDB — [...comments] in TaskCommentStream threw on every load.
// The comment stream is now an unprotected field (tasks.unprotectedFields):
// the optimistic write renders instantly and the server's full set
// reconciles it, with no lock at all.

const TASK_ID = "a".repeat(32);

function taskRow(comments: any[]) {
  return { _id: TASK_ID, short_id: "ct-1", title: "T", status: "open", comments };
}

const FIRST = { _id: "c1", author: "X", text: "first", created_at: 1 };

describe("task comment stream local-first", () => {
  beforeEach(() => {
    useInboxStore.setState({ tasks: {}, pending: {} });
  });

  it("appends optimistically without planting a field lock", () => {
    useInboxStore.setState({ tasks: { [TASK_ID]: taskRow([FIRST]) } });
    useInboxStore.getState().addTaskComment("ct-1", "hello");
    const task = useInboxStore.getState().tasks[TASK_ID] as any;
    expect(Array.isArray(task.comments)).toBe(true);
    expect(task.comments).toHaveLength(2);
    expect(useInboxStore.getState().pending[`tasks:${TASK_ID}:comments`]).toBeUndefined();
  });

  it("keeps the stream an array through server re-pushes", () => {
    useInboxStore.setState({ tasks: { [TASK_ID]: taskRow([FIRST]) } });
    useInboxStore.getState().addTaskComment("ct-1", "hello");

    // A stale delta row (pre-insert comment set) transiently wins…
    useInboxStore.getState().syncTable("tasks", [taskRow([FIRST])], { isDelta: true });
    let task = useInboxStore.getState().tasks[TASK_ID] as any;
    expect(Array.isArray(task.comments)).toBe(true);

    // …and the echo carrying the real comment lands wholesale.
    const echoed = [FIRST, { _id: "c2", author: "You", text: "hello", created_at: 2 }];
    useInboxStore.getState().syncTable("tasks", [taskRow(echoed)], { isDelta: true });
    task = useInboxStore.getState().tasks[TASK_ID] as any;
    expect(task.comments.map((c: any) => c._id)).toEqual(["c1", "c2"]);
  });

  it("drops a poisoned comments lock persisted by an older build at hydration", () => {
    const cleaned = expireExcludeTombstones(
      {
        [`tasks:${TASK_ID}:comments`]: { type: "field", value: { _id: "temp_1" }, ts: 1 },
        [`tasks:${TASK_ID}:status`]: { type: "field", value: "done", ts: 1 },
      },
      Date.now(),
    );
    expect(cleaned[`tasks:${TASK_ID}:comments`]).toBeUndefined();
    expect(cleaned[`tasks:${TASK_ID}:status`]).toBeDefined();
  });
});
