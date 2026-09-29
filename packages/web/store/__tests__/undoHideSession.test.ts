import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { undoableHideSession } from "../undoActions";
import { performUndo } from "../undoStack";

// Undo of a stash restores the row at once. The server has usually already
// applied the stash by then, so its next push still carries inbox_stashed_at
// until the undo's own patch lands. The row must not flicker back into Stashed
// in that window: the undo's restored values hold until the server echoes them.
const ID = "c".repeat(32);
const PIN_AT = 1700000000000;
const SNOOZE_UNTIL = 1800000000000;

function row(extra: Record<string, unknown> = {}): InboxSession {
  return { _id: ID, session_id: "sess-c", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false, ...extra } as InboxSession;
}

function seed(extra: Record<string, unknown> = {}) {
  useInboxStore.setState({
    sessions: { [ID]: row(extra) },
    conversations: { [ID]: { _id: ID, ...extra } },
    pending: {},
    currentSessionId: null,
    clientState: {},
  } as any);
}

const session = () => useInboxStore.getState().sessions[ID] as any;
const conversation = () => useInboxStore.getState().conversations[ID] as any;

describe("undoing a stash holds the restored row until the server echoes it", () => {
  beforeEach(() => seed());

  test("a push that still carries the stash does not re-hide the row", () => {
    undoableHideSession(ID, "stash");
    const stashedAt = session().inbox_stashed_at;
    expect(typeof stashedAt).toBe("number");

    performUndo();
    expect(session().inbox_stashed_at ?? null).toBe(null);

    // The stash reached the server before the undo did.
    useInboxStore.getState().syncTable("sessions", [row({ inbox_stashed_at: stashedAt })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, inbox_stashed_at: stashedAt }]);
    expect(session().inbox_stashed_at ?? null).toBe(null);
    expect(conversation().inbox_stashed_at ?? null).toBe(null);

    // The undo lands; its echo retires the locks.
    useInboxStore.getState().syncTable("sessions", [row({ inbox_stashed_at: null })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, inbox_stashed_at: null }]);
    const locks = Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(ID));
    expect(locks).toEqual([]);
  });

  test("an undo after the stash was confirmed still holds the row", () => {
    undoableHideSession(ID, "stash");
    const stashedAt = session().inbox_stashed_at;
    // The server confirmed the stash: its locks are gone before the undo.
    useInboxStore.setState({ pending: {} } as any);

    performUndo();
    // Any push before the undo lands, e.g. a live session's next update.
    useInboxStore.getState().syncTable("sessions", [row({ inbox_stashed_at: stashedAt, updated_at: 2 })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, inbox_stashed_at: stashedAt }]);
    expect(session().inbox_stashed_at ?? null).toBe(null);
    expect(conversation().inbox_stashed_at ?? null).toBe(null);
  });

  test("the pin and snooze the stash cleared come back and stay", () => {
    seed({ is_pinned: true, inbox_pinned_at: PIN_AT, inbox_snoozed_until: SNOOZE_UNTIL });
    undoableHideSession(ID, "stash");
    expect(session().is_pinned).toBe(false);

    performUndo();
    const stashedEcho = { inbox_stashed_at: 5, is_pinned: false, inbox_pinned_at: null, inbox_snoozed_until: null };
    useInboxStore.getState().syncTable("sessions", [row(stashedEcho)]);
    expect(session().is_pinned).toBe(true);
    expect(session().inbox_pinned_at).toBe(PIN_AT);
    expect(session().inbox_snoozed_until).toBe(SNOOZE_UNTIL);
    expect(session().inbox_stashed_at ?? null).toBe(null);
  });
});
