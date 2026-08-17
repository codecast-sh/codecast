import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The collection sync's "no-op push" short-circuit used to compare rows by
// `updated_at` alone. A table whose rows carry no updated_at (agent_tasks)
// made every push after the first look identical — undefined === undefined —
// and silently dropped real changes; and an echo that only CLEARED a
// local-first field protection never wrote the pending map back. Both are
// decided by row identity now.
describe("collection sync on rows without updated_at", () => {
  beforeEach(() => {
    useInboxStore.setState({
      agentTasks: { a: { _id: "a", status: "scheduled", schedule_type: "recurring" } },
      pending: {},
    } as any);
  });

  it("lands a server-side change on a later push", () => {
    useInboxStore.getState().syncTable("agentTasks", [{ _id: "a", status: "running", schedule_type: "recurring" }]);
    expect(useInboxStore.getState().agentTasks.a.status).toBe("running");
  });

  it("clears the local-first protection when the server echoes the value", () => {
    useInboxStore.getState().triggerAction("a", "pause");
    expect(useInboxStore.getState().agentTasks.a.status).toBe("paused");
    expect(useInboxStore.getState().pending["agentTasks:a:status"]).toBeDefined();
    // Stale push (server hasn't seen the pause yet): the flip holds.
    useInboxStore.getState().syncTable("agentTasks", [{ _id: "a", status: "scheduled", schedule_type: "recurring" }]);
    expect(useInboxStore.getState().agentTasks.a.status).toBe("paused");
    // Echo: protection retires.
    useInboxStore.getState().syncTable("agentTasks", [{ _id: "a", status: "paused", schedule_type: "recurring" }]);
    expect(useInboxStore.getState().pending["agentTasks:a:status"]).toBeUndefined();
  });

  it("still treats an identical push as a no-op (no new collection identity)", () => {
    const before = useInboxStore.getState().agentTasks;
    useInboxStore.getState().syncTable("agentTasks", [{ _id: "a", status: "scheduled", schedule_type: "recurring" }]);
    expect(useInboxStore.getState().agentTasks).toBe(before);
  });
});
