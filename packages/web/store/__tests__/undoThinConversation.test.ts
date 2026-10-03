import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetUndoStacks } from "@platform/engine";
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

  test("patchConversation then undo, with no session row either", () => {
    seed(false);
    state().patchConversation(ID, { inbox_pinned_at: 123 });
    expect(conv().inbox_pinned_at).toBe(123);

    expect(performUndo()).toBe(true);
    expect(conv()?.inbox_pinned_at ?? null).toBe(null);
    expectMetaLoads();
  });

  test("the undo's server half clears the field", () => {
    const sent: Array<Record<string, any>> = [];
    const owner = {};
    state()._setDispatch(async (action: string, _args: unknown, patches: any) => {
      if (action === "applyUndoPatches") sent.push(patches ?? {});
      return null;
    }, { owner });
    try {
      state().toggleFavorite(ID);
      performUndo();
      const fields = sent.map((p) => p.conversations?.[ID]).find(Boolean);
      expect(fields).toBeDefined();
      expect("is_favorite" in fields!).toBe(true);
      expect(fields!.is_favorite ?? null).toBe(null);
    } finally {
      state()._clearDispatch(owner);
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
