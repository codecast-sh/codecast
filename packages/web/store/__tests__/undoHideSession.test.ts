import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { performUndo } from "../undoStack";
import { shouldShowInInbox } from "@codecast/shared/contracts";

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
  beforeEach(() => { _resetUndoStacks(); seed(); });

  test("a push that still carries the stash does not re-hide the row", () => {
    useInboxStore.getState().stashSession(ID);
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
    useInboxStore.getState().stashSession(ID);
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
    useInboxStore.getState().stashSession(ID);
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

// B6: a kill or stash reaches the server two ways (the row's own stamps for the
// runner and owners, inbox_hides for anyone else), so its undo names
// restoreSession per row: the patches it carries restore an owner's stamps
// exactly, and its side effect drops a viewer's inbox_hides record.
describe("undoing a kill lands each row where it was, on the server too", () => {
  const CHILD = "d".repeat(32);
  const STASHED_AT = 1700000000000;
  type Sent = { action: string; args: any[]; patches: any };
  let sent: Sent[] = [];
  const owner = {};

  beforeEach(() => {
    _resetUndoStacks();
    sent = [];
    useInboxStore.setState({
      sessions: { [ID]: row({ inbox_stashed_at: STASHED_AT }), [CHILD]: { ...row(), _id: CHILD, session_id: "sess-d", parent_conversation_id: ID } },
      conversations: { [ID]: { _id: ID, inbox_stashed_at: STASHED_AT }, [CHILD]: { _id: CHILD } },
      pending: {},
      currentSessionId: null,
      clientState: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action, args, patches) => {
      sent.push({ action, args, patches });
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("a stashed row that was killed is Stashed again after the undo", () => {
    useInboxStore.getState().killSession(ID);
    expect(typeof session().inbox_dismissed_at).toBe("number");
    expect(session().inbox_stashed_at ?? null).toBe(null);
    const killedAt = session().inbox_dismissed_at;

    expect(performUndo()).toBe(true);
    expect(session().inbox_dismissed_at ?? null).toBe(null);
    expect(session().inbox_stashed_at).toBe(STASHED_AT);
    expect(conversation().inbox_stashed_at).toBe(STASHED_AT);

    // The kill reached the server first: its push does not re-hide the row.
    useInboxStore.getState().syncTable("sessions", [row({ inbox_dismissed_at: killedAt, inbox_stashed_at: null })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, inbox_dismissed_at: killedAt, inbox_stashed_at: null }]);
    expect(session().inbox_dismissed_at ?? null).toBe(null);
    expect(session().inbox_stashed_at).toBe(STASHED_AT);
  });

  test("the undo dispatches restoreSession per row, carrying the restored stamps", () => {
    useInboxStore.getState().killSession(ID);
    sent = [];
    performUndo();

    const restores = sent.filter((s) => s.action === "restoreSession");
    expect(restores.map((s) => s.args[0]).sort()).toEqual([ID, CHILD].sort());
    expect(sent.some((s) => s.action === "applyUndoPatches")).toBe(false);
    const patched = Object.assign({}, ...restores.map((s) => s.patches?.conversations ?? {}));
    expect(patched[ID]).toMatchObject({ inbox_dismissed_at: null, inbox_stashed_at: STASHED_AT });
    expect(patched[CHILD]).toMatchObject({ inbox_dismissed_at: null });
  });

  test("a teammate's row the kill forgot comes back, and the server hears restoreSession", () => {
    useInboxStore.setState({
      sessions: { [ID]: row() },
      conversations: { [ID]: { _id: ID, is_own: false } },
    } as any);
    useInboxStore.getState().killSession(ID);
    expect(useInboxStore.getState().sessions[ID]).toBeUndefined();
    sent = [];

    expect(performUndo()).toBe(true);
    expect(session()?._id).toBe(ID);
    expect(Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(ID) && (useInboxStore.getState().pending as any)[k].type === "exclude")).toEqual([]);
    expect(sent.filter((s) => s.action === "restoreSession").map((s) => s.args[0])).toEqual([ID]);
  });
});

// The server's kill stamps inbox_killed_at, which the kill's own draft never
// wrote. An undo after that echo has to clear it too, or shouldShowInInbox keeps
// the restored row hidden until the server's un-kill comes back.
describe("undoing a confirmed kill shows the row at once", () => {
  const KILLED_AT = 1700000005000;
  beforeEach(() => { _resetUndoStacks(); seed(); });

  test("a kill echoed with inbox_killed_at is visible right after the undo", () => {
    useInboxStore.getState().killSession(ID);
    const dismissedAt = session().inbox_dismissed_at;
    const echo = { inbox_dismissed_at: dismissedAt, inbox_killed_at: KILLED_AT };
    useInboxStore.getState().syncTable("sessions", [row(echo)]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, ...echo }]);
    expect(session().inbox_killed_at).toBe(KILLED_AT);

    expect(performUndo()).toBe(true);
    expect(session().inbox_dismissed_at ?? null).toBe(null);
    expect(session().inbox_killed_at ?? null).toBe(null);
    expect(shouldShowInInbox(session())).toBe(true);

    // The server has not seen the undo yet: its next push still says killed.
    useInboxStore.getState().syncTable("sessions", [row({ ...echo, updated_at: 2 })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, ...echo }]);
    expect(shouldShowInInbox(session())).toBe(true);
    expect(conversation().inbox_killed_at ?? null).toBe(null);

    // The undo lands: the server's un-kill clears both stamps and the locks retire.
    useInboxStore.getState().syncTable("sessions", [row({ updated_at: 3 })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID }]);
    const locks = Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(ID));
    expect(locks).toEqual([]);
  });

  test("a row with no conversations twin is visible right after the undo", () => {
    useInboxStore.setState({ sessions: { [ID]: row() }, conversations: {} } as any);
    useInboxStore.getState().killSession(ID);
    const echo = { inbox_dismissed_at: session().inbox_dismissed_at, inbox_killed_at: KILLED_AT };
    useInboxStore.getState().syncTable("sessions", [row(echo)]);

    expect(performUndo()).toBe(true);
    expect(session().inbox_killed_at ?? null).toBe(null);
    expect(shouldShowInInbox(session())).toBe(true);
  });

  test("a parent's kill cascaded over a twinless child: the child is un-killed by the undo", () => {
    const CHILD = "e".repeat(32);
    const child = (extra: Record<string, unknown> = {}) => ({ ...row(), _id: CHILD, session_id: "sess-e", parent_conversation_id: ID, ...extra });
    useInboxStore.setState({ sessions: { [ID]: row(), [CHILD]: child() }, conversations: { [ID]: { _id: ID } } } as any);
    useInboxStore.getState().killSession(ID);
    const kid = () => useInboxStore.getState().sessions[CHILD] as any;
    expect(typeof kid().inbox_dismissed_at).toBe("number");
    const echo = { inbox_dismissed_at: session().inbox_dismissed_at, inbox_killed_at: KILLED_AT };
    useInboxStore.getState().syncTable("sessions", [row(echo), child({ inbox_dismissed_at: kid().inbox_dismissed_at, inbox_killed_at: KILLED_AT })]);
    useInboxStore.getState().syncTable("conversations", [{ _id: ID, ...echo }]);

    expect(performUndo()).toBe(true);
    // A child never lists at the top (it nests under its parent), so its
    // stamps are what decide whether it comes back.
    expect(kid().inbox_killed_at ?? null).toBe(null);
    expect(kid().inbox_dismissed_at ?? null).toBe(null);
    expect(shouldShowInInbox(session())).toBe(true);
  });

  test("a row that was already killed keeps its marker through a re-kill's undo", () => {
    seed({ inbox_killed_at: KILLED_AT, is_pinned: true, inbox_pinned_at: PIN_AT });
    useInboxStore.getState().killSession(ID);
    performUndo();
    expect(session().inbox_killed_at).toBe(KILLED_AT);
    expect(session().is_pinned).toBe(true);
  });
});
