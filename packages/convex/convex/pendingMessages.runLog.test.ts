import { describe, expect, test } from "bun:test";
import { enqueuePendingMessage } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

// A session message into a run's log resumed a stray agent there, which had
// woken on an account switch's continue (jx73gnf, 2026-10-23). The log has no
// agent, so nothing sent there becomes a turn.
function world(conv: Record<string, unknown>) {
  const conversation = { _id: "conv", user_id: "owner", owner_device_id: "device", status: "active", ...conv };
  const db = makeFakeDb({ conversations: [conversation], pending_messages: [] });
  return { ctx: { db }, conversation, db };
}

describe("a run's own log takes no turns", () => {
  test("a message into a run log is held on its record, never pending for a daemon", async () => {
    const { ctx, conversation, db } = world({ session_id: "wf-workflow_runs_1", workflow_run_id: "workflow_runs_1", is_workflow_primary: true });
    for (const content of ["continue", "<session-message from=\"jx73kh0\">answer</session-message>"]) {
      const id = await enqueuePendingMessage(ctx, conversation, "owner" as any, { content, human: true });
      expect((await db.get(id)).status).toBe("held");
    }
    expect(db._tables.pending_messages.filter((m: any) => m.status === "pending")).toEqual([]);
  });

  test("a real session that hosted a run still gets its messages", async () => {
    const { ctx, conversation, db } = world({ session_id: "native-session", workflow_run_id: "workflow_runs_1", is_workflow_primary: true });
    const id = await enqueuePendingMessage(ctx, conversation, "owner" as any, { content: "continue" });
    expect((await db.get(id)).status).toBe("pending");
  });
});
