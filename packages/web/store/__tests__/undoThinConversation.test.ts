import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { performUndo, performRedo } from "../undoStack";

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
