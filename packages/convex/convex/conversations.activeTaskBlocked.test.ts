import { describe, expect, test } from "bun:test";
import { computeInboxSessions } from "./conversations";
import { makeFakeDb } from "./testDb";

// ct-59116: the inbox row carries whether its bound task is held by an open
// blocker, so placement can count the blocker as the dormant session's wake.
describe("inbox row active_task.blocked", () => {
  const ME = "users_me";
  const NOW = Date.now();

  test("a waiting task ships blocked; an unblocked or finished one does not", async () => {
    const db = makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@example.com" }],
      tasks: [
        { _id: "tasks_wait", short_id: "ct-1", title: "Waits", status: "in_progress", waiting_since: NOW - 1000 },
        { _id: "tasks_free", short_id: "ct-2", title: "Free", status: "in_progress" },
        { _id: "tasks_done", short_id: "ct-3", title: "Done", status: "done", waiting_since: NOW - 1000 },
      ],
      conversations: ["wait", "free", "done"].map((k) => ({
        _id: `conversations_${k}`, user_id: ME, status: "active", updated_at: NOW, message_count: 0, active_task_id: `tasks_${k}`,
      })),
      session_owners: [],
      managed_sessions: [],
      messages: [],
    });
    const { sessions } = await computeInboxSessions({ db }, ME as any, { show_all: true, includeLiveness: false });
    const task = (id: string) => sessions.find((s: any) => s._id === `conversations_${id}`)?.active_task;
    expect(task("wait")).toMatchObject({ short_id: "ct-1", blocked: true });
    expect(task("free")?.short_id).toBe("ct-2");
    expect(task("free")?.blocked).toBeUndefined();
    expect(task("done")?.blocked).toBeUndefined();
  });
});
