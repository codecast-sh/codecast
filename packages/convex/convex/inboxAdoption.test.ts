import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeInboxSessions } from "./conversations";
import { enqueuePendingMessage } from "./pendingMessages";
import { inboxEpoch } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";

// A flow station is a subagent of its run's log, and the log is never listed,
// so a station has no place in the inbox. Once the person talks to it (a send,
// or "Talk to the session" on its decision) it is adopted: it stands alone in
// their inbox as its own row, named by its flow.
const ME = "users_me";
const MIN = 60 * 1000;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);

const runLog = {
  _id: "conversations_log", user_id: ME, status: "active", updated_at: EPOCH - 5 * MIN, message_count: 3,
  session_id: "wf-workflow_runs_1", workflow_run_id: "workflow_runs_1", is_workflow_primary: true,
  inbox_stashed_at: EPOCH - 60 * MIN, inbox_stash_hidden: true, title: "line",
};
const station = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: `conversations_${id}`, user_id: ME, status: "active", updated_at: EPOCH - 2 * MIN, message_count: 20,
  last_message_role: "assistant", title: `Station ${id}`, is_subagent: true, parent_conversation_id: runLog._id,
  owner_device_id: "device", ...extra,
});

function world(conversations: any[]) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    session_decisions: [],
    pending_messages: [],
    workflow_runs: [{ _id: "workflow_runs_1", workflow_name: "Union fix flow", status: "running", node_statuses: [] }],
    conversations,
  });
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); });

describe("an adopted flow station stands alone in the inbox", () => {
  test("the scan lists an adopted station as its own row, named by its flow, and not an unadopted one", async () => {
    const db = world([runLog, station("adopted", { inbox_adopted_at: EPOCH - 10 * MIN }), station("plain")]);
    const { sessions } = await computeInboxSessions({ db }, ME as any, {});
    const ids = sessions.map((s: any) => s._id);
    expect(ids).toContain("conversations_adopted");
    expect(ids).not.toContain("conversations_plain");
    expect(ids).not.toContain(runLog._id);
    expect(ids.filter((id: string) => id === "conversations_adopted")).toHaveLength(1);
    const row = sessions.find((s: any) => s._id === "conversations_adopted");
    expect(row.flow_name).toBe("Union fix flow");
    expect(row.flow_run_id).toBe("workflow_runs_1");
    expect(row.inbox_adopted_at).toBe(EPOCH - 10 * MIN);
  });

  test("a person's send into a station adopts it and leaves the run log stashed", async () => {
    const s = station("talked");
    const db = world([runLog, s]);
    await enqueuePendingMessage({ db } as any, s, ME as any, { content: "why this option?", human: true });
    expect((await db.get(s._id)).inbox_adopted_at).toBe(NOW);
    expect((await db.get(runLog._id)).inbox_stashed_at).toBe(runLog.inbox_stashed_at);
  });

  test("a machine's send into a station adopts nothing", async () => {
    const s = station("woken");
    const db = world([runLog, s]);
    await enqueuePendingMessage({ db } as any, s, ME as any, { content: "<session-message from=\"jx79d5w\">brief</session-message>" });
    expect((await db.get(s._id)).inbox_adopted_at).toBeUndefined();
  });

  test("a send into a subagent under an ordinary parent brings the parent back instead", async () => {
    const parent = { _id: "conversations_parent", user_id: ME, status: "active", updated_at: EPOCH - 5 * MIN, message_count: 9, inbox_stashed_at: EPOCH - 30 * MIN };
    const child = station("child", { parent_conversation_id: parent._id });
    const db = world([parent, child]);
    await enqueuePendingMessage({ db } as any, child, ME as any, { content: "keep going", human: true });
    expect((await db.get(parent._id)).inbox_stashed_at).toBeUndefined();
    expect((await db.get(child._id)).inbox_adopted_at).toBeUndefined();
  });
});
