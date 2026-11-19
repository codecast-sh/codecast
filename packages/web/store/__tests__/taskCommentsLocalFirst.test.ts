import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { expireExcludeTombstones } from "../cacheRetention";
import { ingestTaskDetail } from "../../hooks/useSyncTasks";

// A task's comments live in `taskComments`, keyed by the task's id, never on
// the `tasks` row (lib/detailRows). addTaskComment paints its optimistic
// comment there at once, and the server's full set replaces the thread, with
// no lock at all.
//
// The no-lock rule is a regression fix for the Threads-page crash "a is not
// iterable": the auto-pending middleware once recorded the deep patch's LEAF
// (the single pushed comment object) as the field lock for `comments`. Every
// later server push then re-asserted the lone object as the whole field, the
// mismatched shape never echoed, and the corrupted row persisted to IDB.

const TASK_ID = "a".repeat(32);

function taskRow(comments: any[], extra: Record<string, unknown> = {}) {
  return { _id: TASK_ID, short_id: "ct-1", title: "T", status: "open", comments, ...extra };
}

const FIRST = { _id: "c1", author: "X", text: "first", created_at: 1 };
const state = () => useInboxStore.getState() as any;
const thread = () => state().taskComments[TASK_ID];
const pendingKeys = () => Object.keys(state().pending).filter((k) => k.includes(TASK_ID));

describe("task comment stream local-first", () => {
  beforeEach(() => {
    useInboxStore.setState({ tasks: {}, taskComments: {}, pending: {} } as any);
  });

  it("a task opened by its detail query holds its thread, and the row carries only the count", () => {
    ingestTaskDetail(taskRow([FIRST], { last_comment_at: 1 }));
    expect(state().tasks[TASK_ID].comments).toBeUndefined();
    expect(state().tasks[TASK_ID].comment_count).toBe(1);
    expect(thread().comments).toEqual([FIRST]);
    expect(thread().as_of).toBe(1);
  });

  it("appends optimistically, at once, without planting a lock", () => {
    ingestTaskDetail(taskRow([FIRST]));
    state().addTaskComment("ct-1", "hello");
    expect(thread().comments.map((c: any) => c.text)).toEqual(["first", "hello"]);
    expect(thread().comments[1]._id.startsWith("temp_")).toBe(true);
    expect(state().tasks[TASK_ID].comments).toBeUndefined();
    expect(pendingKeys()).toEqual([]);
  });

  it("the server's full set replaces the optimistic comment", () => {
    ingestTaskDetail(taskRow([FIRST]));
    state().addTaskComment("ct-1", "hello");

    // A stale list row (the comment set from before the insert) transiently wins…
    state().syncTable("tasks", [taskRow([FIRST])], { isDelta: true });
    expect(thread().comments).toEqual([FIRST]);

    // …and the echo carrying the real comment lands wholesale, from any
    // channel that carries the thread (here a list row, as the sync log's
    // refetch sends it).
    const echoed = [FIRST, { _id: "c2", author: "You", text: "hello", created_at: 2 }];
    state().syncTable("tasks", [taskRow(echoed, { last_comment_at: 2 })], { isDelta: true });
    expect(thread().comments.map((c: any) => c._id)).toEqual(["c1", "c2"]);
    expect(thread().as_of).toBe(2);
    expect(state().tasks[TASK_ID].comments).toBeUndefined();
    expect(state().tasks[TASK_ID].comment_count).toBe(2);
  });

  it("a comment on a task nothing has opened paints at once, and the next read of the thread completes it", () => {
    // The list row arrives with its thread; nothing has opened the task, so
    // the store holds no thread for it.
    state().syncTable("tasks", [taskRow([FIRST], { last_comment_at: 1 })], { isDelta: true });
    expect(thread()).toBeUndefined();

    state().addTaskComment("ct-1", "hello");
    expect(thread().comments.map((c: any) => c.text)).toEqual(["hello"]);
    // Behind the task row, so every reader of threads knows to read it again.
    expect(thread().as_of).toBe(0);
    expect(pendingKeys()).toEqual([]);

    const echoed = [FIRST, { _id: "c2", author: "You", text: "hello", created_at: 2 }];
    state().syncTable("tasks", [taskRow(echoed, { last_comment_at: 2 })], { isDelta: true });
    expect(thread().comments.map((c: any) => c._id)).toEqual(["c1", "c2"]);
  });

  it("a partial set (the Threads inbox's newest 50) never shrinks a fuller thread", () => {
    const second = { _id: "c2", author: "Y", text: "second", created_at: 2 };
    ingestTaskDetail(taskRow([FIRST, second], { last_comment_at: 2 }));
    const third = { _id: "c3", author: "Z", text: "third", created_at: 3 };
    ingestTaskDetail(taskRow([second, third], { last_comment_at: 3 }), { partialComments: true });
    expect(thread().comments.map((c: any) => c._id)).toEqual(["c1", "c2", "c3"]);
    // Not the whole thread as of the newest comment: the stamp stays behind.
    expect(thread().as_of).toBe(2);
    // The count stays the last complete set's.
    expect(state().tasks[TASK_ID].comment_count).toBe(2);
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
