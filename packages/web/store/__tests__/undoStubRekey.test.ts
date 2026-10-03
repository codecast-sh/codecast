import { beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { performUndo } from "../undoStack";

// An entry recorded on an optimistic row names the stub id. When the server
// row supersedes the stub, codecast's own rekey (rekeyId, behind both the
// syncTable altKey loop and resolveSessionId) must move the entry with it, or
// its undo reads the stub's row as gone and reports a conflict.
const STUB = "session-stub-abc";
const REAL = "d".repeat(32);

function row(id: string, extra: Record<string, unknown> = {}): InboxSession {
  return { _id: id, session_id: "sess-d", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false, ...extra } as InboxSession;
}

describe("undo follows a stub row to its server id", () => {
  beforeEach(() => {
    _resetUndoStacks();
    useInboxStore.setState({
      sessions: { [STUB]: row(STUB, { title: "Old" }) },
      conversations: {},
      pending: {},
      currentSessionId: null,
      clientState: {},
    } as any);
  });

  test("a rename recorded on the stub undoes after resolveSessionId", () => {
    useInboxStore.getState().renameSession(STUB, "New");
    useInboxStore.getState().resolveSessionId(STUB, REAL);
    expect(getUndoHistory().items[0]!.objects!.map((o) => o.id)).not.toContain(STUB);

    performUndo();
    const s = useInboxStore.getState().sessions[REAL] as any;
    expect(s.title).toBe("Old");
    expect(getUndoHistory().items[0]!.status).toBe("undone");
  });
});
