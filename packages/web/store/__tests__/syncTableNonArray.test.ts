import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A collection push must be an array. A scalar reaching this path is a broken
// contract — a field renamed out of the registry while a stale module still
// pushes its old value (an HMR batch did exactly this with
// `syncTable("chatThreadUnread", 0)`), or a server shape change during a
// deploy window. It used to throw `incoming.map is not a function` out of the
// DashboardSyncEffects boundary, stopping every feeder. Now it drops the push.
describe("syncTable collection path on a non-array payload", () => {
  let err: ReturnType<typeof spyOn>;
  beforeEach(() => {
    err = spyOn(console, "error").mockImplementation(() => {});
    useInboxStore.setState({
      agentTasks: { a: { _id: "a", status: "scheduled", schedule_type: "recurring" } },
      pending: {},
    } as any);
  });
  afterEach(() => err.mockRestore());

  it("drops a scalar pushed at an unregistered collection field instead of throwing", () => {
    const { syncTable } = useInboxStore.getState();
    expect(() => syncTable("someRenamedCounter", 0)).not.toThrow();
    expect((useInboxStore.getState() as any).someRenamedCounter).toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("drops a non-array payload at a registered collection and keeps the cached rows", () => {
    const { syncTable } = useInboxStore.getState();
    const before = useInboxStore.getState().agentTasks;
    expect(() => syncTable("agentTasks", { a: { _id: "a", status: "running" } })).not.toThrow();
    expect(useInboxStore.getState().agentTasks).toBe(before);
    expect(useInboxStore.getState().agentTasks.a.status).toBe("scheduled");
  });

  it("still accepts a normal array push", () => {
    useInboxStore.getState().syncTable("agentTasks", [{ _id: "a", status: "running", schedule_type: "recurring" }]);
    expect(useInboxStore.getState().agentTasks.a.status).toBe("running");
    expect(err).not.toHaveBeenCalled();
  });
});
