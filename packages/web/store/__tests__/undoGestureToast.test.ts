import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { toast } from "sonner";
import { _resetUndoStacks, getUndoHistory, setUndoNotifier } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { CODECAST_UNDO_NOTIFIER, gestureToast, undoEntryToastId } from "../undoStack";
import { undoAsOne } from "../undoActions";

// One gesture, one toast. A spec with `toast: true` (privacy) raises the
// entry's Undo toast itself, so a caller's own confirmation stacked a second
// one; a plain confirmation (Pinned, Filed under) outlived the undo that took
// the change back. gestureToast makes the confirmation the entry's toast.
const CONV = "c".repeat(32);
const TEAM = "t".repeat(32);
const s = () => useInboxStore.getState() as any;
const owner = {};
type Shown = { id: string | number; title?: unknown };
const shownSince = (n: number): Shown[] => (toast.getHistory() as Shown[]).slice(n);

beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  // Another file in the same run may have installed its own notifier.
  setUndoNotifier(CODECAST_UNDO_NOTIFIER);
  _resetUndoStacks();
  useInboxStore.setState({
    pending: {},
    sessions: { [CONV]: { _id: CONV, title: "Auth fix", is_private: false, team_visibility: "summary", team_id: TEAM } },
    conversations: { [CONV]: { _id: CONV, title: "Auth fix", is_private: false, team_visibility: "summary", team_id: TEAM } },
  } as any);
});

describe("gestureToast", () => {
  it("a toast spec's gesture shows only the entry's own toast", () => {
    const n = toast.getHistory().length;
    gestureToast("Hidden from the team", () => s().setPrivacy(CONV, true));
    const entry = getUndoHistory().items[0]!;
    expect(shownSince(n).map((t) => t.id)).toEqual([undoEntryToastId(entry.id)]);
  });

  it("a recorded gesture with no toast spec shows its message as the entry's toast", () => {
    const n = toast.getHistory().length;
    gestureToast("Pinned", () => s().pinSession(CONV));
    const entry = getUndoHistory().items[0]!;
    expect(shownSince(n)).toMatchObject([{ id: undoEntryToastId(entry.id), title: "Pinned" }]);
  });

  it("a grouped gesture (the palette's bulk pin) shows one toast, the group's own", () => {
    const n = toast.getHistory().length;
    gestureToast("Pinned", () => undoAsOne("Pinned 1 session", () => s().pinSession(CONV)));
    const entry = getUndoHistory().items[0]!;
    expect(shownSince(n)).toMatchObject([{ id: undoEntryToastId(entry.id), title: "Pinned" }]);
  });

  it("a gesture that recorded nothing shows its message plainly", () => {
    const n = toast.getHistory().length;
    gestureToast("Done", () => {});
    const shown = shownSince(n);
    expect(shown).toHaveLength(1);
    expect(String(shown[0]!.id).startsWith("undo-")).toBe(false);
  });
});
