import { beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory, setUndoNotifier } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performRedo, performUndo } from "../undoStack";

// Validation round 8, against the real store: a favorite whose favorites row
// the server's push replaced, and a pin whose redo re-mints its stamp.
const ID = "f".repeat(32);
let notices: string[] = [];

function seed() {
  const base = { _id: ID, session_id: "sess-f", title: "Fav", updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false };
  useInboxStore.setState({
    sessions: { [ID]: { ...base } },
    conversations: { [ID]: { ...base, project_path: "/p", git_branch: "main" } },
    favorites: [],
    pending: {},
    currentSessionId: null,
    clientState: {},
  } as any);
}

const s = () => useInboxStore.getState() as any;
const statuses = () => getUndoHistory().items.map((i) => `${i.label}:${i.status}`);

describe("undo of a favorite after the favorites push replaced its row", () => {
  beforeEach(() => {
    _resetUndoStacks();
    notices = [];
    setUndoNotifier({ notify: (m) => notices.push(m) });
    seed();
  });

  test("the row leaves the shelf on undo and the redo lands", () => {
    s().toggleFavorite(ID);
    expect(Object.keys(s().favorites[0]).length).toBeGreaterThan(7);
    // The server confirms the flag, then listFavorites pushes its own thin row.
    const echoed = { _id: ID, session_id: "sess-f", title: "Fav", updated_at: 1, is_favorite: true };
    s().syncTable("sessions", [echoed]);
    s().syncTable("conversations", [echoed]);
    s().syncTable("favorites", [{ _id: ID, title: "Fav", is_favorite: true, updated_at: 2, agent_type: "claude_code", project_path: "/p", git_branch: "main" }]);
    expect(Object.keys(s().favorites[0]).length).toBe(7);

    performUndo();
    expect({ fav: !!s().conversations[ID].is_favorite, shelf: s().favorites.map((f: any) => f._id) }).toEqual({ fav: false, shelf: [] });

    performRedo();
    expect({
      fav: s().conversations[ID].is_favorite,
      shelf: s().favorites.map((f: any) => f._id),
      last: notices.at(-1),
    }).toEqual({ fav: true, shelf: [ID], last: expect.stringMatching(/^Redid/) });
  });
});

describe("redo of two pin toggles on one row", () => {
  beforeEach(() => {
    _resetUndoStacks();
    notices = [];
    setUndoNotifier({ notify: (m) => notices.push(m) });
    seed();
  });

  test("pin, unpin, undo twice, redo twice ends unpinned with both entries done", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 3));
    s().pinSession(ID);
    await tick();
    s().pinSession(ID);
    await tick();
    performUndo();
    performUndo();
    expect(!!s().sessions[ID].is_pinned).toBe(false);
    await tick();
    performRedo();
    expect(s().sessions[ID].is_pinned).toBe(true);
    await tick();
    performRedo();
    expect({ pinned: !!s().sessions[ID].is_pinned, at: s().sessions[ID].inbox_pinned_at ?? null, history: statuses().map((x) => x.split(":").at(-1)), last: notices.at(-1) }).toEqual({
      pinned: false,
      at: null,
      history: ["done", "done"],
      last: expect.stringMatching(/^Redid/),
    });
  });
});
