import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { performUndo, performRedo } from "../undoStack";
import { withClearedInboxStamps } from "../syncProtocol";

// An inbox row that was never opened in this window has no conversations
// meta. toggleFavorite and patchConversation create a thin `{_id}` row there
// to carry the write. That row stands for a server row, so taking the gesture
// back must clear the fields it wrote and keep the row: deleting it plants a
// `conversations:<id>` exclude nothing retires, and the meta can never load.
const ID = "jx7thinconv000000000000000000000";
const META = { _id: ID, title: "Loaded meta", message_count: 4 };

const state = () => useInboxStore.getState() as any;
const conv = () => state().conversations[ID];
const convLocks = () => Object.entries(state().pending as Record<string, any>).filter(([k]) => k.startsWith(`conversations:${ID}`));

const seed = (session = true) => {
  useInboxStore.setState({
    pending: {},
    favorites: [],
    sessions: (session ? { [ID]: { _id: ID, title: "Twinless", updated_at: 1 } } : {}) as any,
    conversations: {} as any,
  });
};

/** The server half of every undo, as dispatched. */
const captureUndoPatches = () => {
  const patches: Array<Record<string, any>> = [];
  const owner = {};
  state()._setDispatch(async (action: string, _args: unknown, sent: any) => {
    if (action === "applyUndoPatches") patches.push(sent ?? {});
    return null;
  }, { owner });
  return { patches, stop: () => state()._clearDispatch(owner) };
};

const expectMetaLoads = () => {
  expect(state().pending[`conversations:${ID}`]).toBeUndefined();
  state().syncRecord("conversations", ID, META);
  expect(conv()?.title).toBe("Loaded meta");
  expect(conv()?.message_count).toBe(4);
};

describe("undo of a gesture on a row whose conversation meta is not loaded", () => {
  beforeEach(() => { _resetUndoStacks(); seed(); });

  test("favorite then undo: the meta still loads and no row exclude remains", () => {
    state().toggleFavorite(ID);
    expect(conv().is_favorite).toBe(true);

    expect(performUndo()).toBe(true);
    expect(state().sessions[ID].is_favorite ?? null).toBe(null);
    expect(conv()?.is_favorite ?? null).toBe(null);
    expect(state().favorites.some((f: any) => f._id === ID)).toBe(false);
    expectMetaLoads();
    // What holds the undone value is a field lock, never a row lock.
    for (const [key] of convLocks()) expect(key.split(":").length).toBe(3);
    state().syncTable("conversations", [{ ...META, title: "Second push" }]);
    expect(conv().title).toBe("Second push");
  });

  // With neither an inbox row nor loaded meta, nothing here knows what the
  // fields held before, so the undo could only write a clear: unpin then undo
  // would send the unpin again. Such a gesture is not recorded.
  test("a gesture on a row with no inbox row either records nothing", () => {
    seed(false);
    const sent = captureUndoPatches();
    try {
      for (const fields of [{ inbox_pinned_at: null }, { inbox_dismissed_at: null, inbox_stashed_at: null }, { inbox_pinned_at: 123 }]) {
        seed(false);
        state().patchConversation(ID, fields);
        expect(getUndoHistory().items).toEqual([]);
      }
      // The stub the last gesture left is still not the server's row.
      state().patchConversation(ID, { inbox_stashed_at: 9 });
      state().toggleFavorite(ID);
      expect(getUndoHistory().items).toEqual([]);
      expect(performUndo()).toBe(false);
      expect(sent.patches).toEqual([]);
      expect(conv().inbox_pinned_at).toBe(123);
      expect(conv().inbox_stashed_at).toBe(9);
    } finally {
      sent.stop();
    }
  });

  test("a loaded conversation with no inbox row stays undoable: the field was absent", () => {
    seed(false);
    state().syncRecord("conversations", ID, { ...META, _creationTime: 5 });
    const sent = captureUndoPatches();
    try {
      state().toggleFavorite(ID);
      expect(performUndo()).toBe(true);
      expect(sent.patches.map((p) => p.conversations?.[ID])).toEqual([{ is_favorite: null }]);
    } finally {
      sent.stop();
    }
  });

  // The thin row says nothing about what the field held; the inbox row's cell
  // does. Both reach one server row, so the undo must send the prior value.
  test("unfavorite then undo sends the prior value, and loaded meta keeps it", () => {
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, title: "Twinless", updated_at: 1, is_favorite: true } } as any,
      favorites: [{ _id: ID }] as any,
    });
    const sent = captureUndoPatches();
    try {
      state().toggleFavorite(ID);
      expect(conv().is_favorite).toBe(false);
      expect(performUndo()).toBe(true);
      expect(sent.patches.map((p) => p.conversations?.[ID])).toEqual([{ is_favorite: true }]);
    } finally {
      sent.stop();
    }
    expect(state().sessions[ID].is_favorite).toBe(true);
    expect(conv().is_favorite).toBe(true);
    state().syncRecord("conversations", ID, { ...META, is_favorite: true });
    expect(conv().is_favorite).toBe(true);
    expect(conv().title).toBe("Loaded meta");
    state().syncRecord("conversations", ID, { ...META, is_favorite: true });
    expect(convLocks()).toEqual([]);
  });

  test("a favorite known only from the favorites list comes back as a favorite", () => {
    useInboxStore.setState({ favorites: [{ _id: ID }] as any });
    const sent = captureUndoPatches();
    try {
      state().toggleFavorite(ID);
      expect(state().sessions[ID].is_favorite).toBe(false);
      expect(performUndo()).toBe(true);
      expect(sent.patches.map((p) => p.conversations?.[ID])).toEqual([{ is_favorite: true }]);
    } finally {
      sent.stop();
    }
    expect(state().sessions[ID].is_favorite).toBe(true);
    expect(state().favorites.some((f: any) => f._id === ID)).toBe(true);
    state().syncRecord("conversations", ID, { ...META, is_favorite: true });
    expect(conv().is_favorite).toBe(true);
  });

  test("unpin and restore through patchConversation undo to the prior stamps", () => {
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, title: "Twinless", updated_at: 1, inbox_pinned_at: 77, inbox_stashed_at: 55 } } as any,
    });
    const sent = captureUndoPatches();
    try {
      state().patchConversation(ID, { inbox_pinned_at: null });
      expect(performUndo()).toBe(true);
      state().patchConversation(ID, { inbox_dismissed_at: null, inbox_stashed_at: null });
      expect(performUndo()).toBe(true);
      const [unpin, restore] = sent.patches.map((p) => p.conversations?.[ID]);
      expect(unpin).toEqual({ inbox_pinned_at: 77 });
      expect(restore.inbox_stashed_at).toBe(55);
      expect(restore.inbox_dismissed_at ?? null).toBe(null);
      expect(sent.patches.length).toBe(2);
    } finally {
      sent.stop();
    }
    expect(state().sessions[ID].inbox_pinned_at).toBe(77);
    expect(conv().inbox_stashed_at).toBe(55);
    expectMetaLoads();
  });

  // The /sessions restore writes all three hide stamps, usually changing only
  // one. A stash made elsewhere after the undo must survive the redo: the
  // re-invoke would write inbox_stashed_at: null again, locally and on the wire.
  test("redo of a restore keeps a stash made elsewhere since the undo", async () => {
    const HIDES = { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null };
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, title: "Twinless", updated_at: 1, ...HIDES, inbox_dismissed_at: 10 } } as any,
    });
    state().syncRecord("conversations", ID, { ...META, ...HIDES, inbox_dismissed_at: 10 });
    const sent: Array<{ action: string; args: any; patches: any }> = [];
    const owner = {};
    state()._setDispatch(async (action: string, args: any, patches: any) => {
      sent.push({ action, args, patches });
      return null;
    }, { owner });
    try {
      state().patchConversation(ID, { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null });
      expect(performUndo()).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(conv().inbox_dismissed_at).toBe(10);
      state().syncRecord("conversations", ID, { ...META, ...HIDES, inbox_dismissed_at: 10, inbox_stashed_at: 99 });
      expect(conv().inbox_stashed_at).toBe(99);
      const from = sent.length;
      expect(performRedo()).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(conv().inbox_dismissed_at ?? null).toBe(null);
      expect(conv().inbox_stashed_at).toBe(99);
      const wire = JSON.stringify(sent.slice(from));
      expect(wire).not.toContain("inbox_stashed_at");
    } finally {
      state()._clearDispatch(owner);
    }
  });

  test("the undo's server half clears the field", () => {
    const sent = captureUndoPatches();
    try {
      state().toggleFavorite(ID);
      performUndo();
      const fields = sent.patches.map((p) => p.conversations?.[ID]).find(Boolean);
      expect(fields).toBeDefined();
      expect("is_favorite" in fields!).toBe(true);
      expect(fields!.is_favorite ?? null).toBe(null);
    } finally {
      sent.stop();
    }
  });

  test("meta that loaded after the gesture survives the undo", () => {
    state().toggleFavorite(ID);
    state().syncRecord("conversations", ID, { ...META, is_favorite: true });
    expect(conv().title).toBe("Loaded meta");

    expect(performUndo()).toBe(true);
    expect(conv().title).toBe("Loaded meta");
    expect(conv().is_favorite ?? null).toBe(null);
  });

  test("the echo of the cleared field retires its lock", () => {
    state().toggleFavorite(ID);
    performUndo();
    state().syncRecord("conversations", ID, META);
    state().syncRecord("conversations", ID, META);
    expect(convLocks()).toEqual([]);
  });

  // The rule is the policy's, not one spec's: every undoable action that
  // writes a twinless row keeps the row on undo.
  test("project switch and privacy keep the row too", () => {
    useInboxStore.setState({ sessions: { [ID]: { _id: ID, title: "Twinless", project_path: "/a", git_root: "/a", is_private: true } } as any });
    state().switchProject(ID, "/b");
    expect(performUndo()).toBe(true);
    expect(state().sessions[ID].project_path).toBe("/a");
    expect(state().pending[`conversations:${ID}`]).toBeUndefined();

    state().setPrivacy(ID, false);
    expect(performUndo()).toBe(true);
    expect(state().sessions[ID].is_private).toBe(true);
    expectMetaLoads();
  });

  test("redo favorites the row again", () => {
    state().toggleFavorite(ID);
    performUndo();
    expect(performRedo()).toBe(true);
    expect(conv().is_favorite).toBe(true);
    expect(state().sessions[ID].is_favorite).toBe(true);
  });
});

// Each session lives twice in the store, and the conversations copy can hold a
// hide stamp the server already cleared (a restore elsewhere merges field by
// field, and the server leaves a cleared stamp out). A snooze writes the clear
// on both copies; only the stale copy changes. The undo must not send that
// stale stamp back: on the server it re-kills the session.
describe("undo of a gesture whose conversations copy held a stale stamp", () => {
  const SID = "jx7stalecopy00000000000000000000";
  const STALE = 1791071693350;
  beforeEach(() => {
    _resetUndoStacks();
    useInboxStore.setState({
      pending: {},
      sessions: { [SID]: { _id: SID, title: "Live", updated_at: 1, inbox_dismissed_at: null } } as any,
      conversations: { [SID]: { _id: SID, _creationTime: 1, title: "Live", inbox_dismissed_at: STALE } } as any,
    });
  });

  test("snooze then undo sends no inbox_dismissed_at and keeps the copies clear", () => {
    const sent = captureUndoPatches();
    try {
      state().snoozeSession(SID, Date.now() + 3_600_000);
      expect(performUndo()).toBe(true);
      expect(sent.patches.length).toBeGreaterThan(0);
      expect(JSON.stringify(sent.patches)).not.toContain("inbox_dismissed_at");
      expect(state().sessions[SID].inbox_dismissed_at ?? null).toBe(null);
      expect(state().conversations[SID].inbox_dismissed_at ?? null).toBe(null);
      expect(state().sessions[SID].inbox_snoozed_until ?? null).toBe(null);
    } finally {
      sent.stop();
    }
  });

  // The undo left the dropped stale cell at its cleared value on purpose, so
  // the redo must judge it by that value, not by the stale stamp.
  test("snooze, undo, redo snoozes the row again", () => {
    const until = Date.now() + 3_600_000;
    state().snoozeSession(SID, until);
    expect(performUndo()).toBe(true);
    expect(performRedo()).toBe(true);
    expect(getUndoHistory().items[0]?.status).toBe("done");
    expect(state().sessions[SID].inbox_snoozed_until).toBe(until);
    expect(state().conversations[SID].inbox_dismissed_at ?? null).toBe(null);
  });

  test("the meta feeder reads a stamp the server left out as cleared", () => {
    state().syncRecord("conversations", SID, withClearedInboxStamps({ _id: SID, _creationTime: 1, title: "Live" }));
    expect(state().conversations[SID].inbox_dismissed_at).toBe(null);
    expect(state().conversations[SID].title).toBe("Live");
  });
});
