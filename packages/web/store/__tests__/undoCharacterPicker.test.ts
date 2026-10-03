import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";

// The character picker writes on every face it lands on (arrow keys, clicks,
// shuffles). Browsing faces is one entry, and one undo returns the first face.
const ID = "c".repeat(32);
const IDS = [ID, "d".repeat(32)];
const s = () => useInboxStore.getState() as any;
const labels = () => getUndoHistory().items.map((i) => i.label);

const owner = {};
beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  const row = (id: string) => ({ _id: id, session_id: `s-${id}`, title: "Faces", updated_at: 1, character_avatar: "cat" });
  useInboxStore.setState({
    sessions: Object.fromEntries(IDS.map((id) => [id, row(id)])),
    conversations: Object.fromEntries(IDS.map((id) => [id, row(id)])),
    pending: {},
  } as any);
});

describe("browsing faces in the character picker", () => {
  test("one session: rapid face steps are one entry", () => {
    for (const avatar of ["fox", "owl", "otter", "crane"]) s().setSessionCharacter(ID, { avatar });
    expect(labels()).toHaveLength(1);
    expect(s().sessions[ID].character_avatar).toBe("crane");
    performUndo();
    expect(s().sessions[ID].character_avatar).toBe("cat");
  });

  test("a selection: rapid face steps are one entry", () => {
    for (const avatar of ["fox", "owl", "otter"]) s().setSessionCharacters(IDS.map((id) => ({ id, avatar })));
    expect(labels()).toHaveLength(1);
  });
});
