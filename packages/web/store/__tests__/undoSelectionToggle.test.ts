import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { toast } from "sonner";
import { _resetUndoStacks, getUndoHistory, setUndoNotifier } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { CODECAST_UNDO_NOTIFIER } from "../undoStack";
import { toggleSessionsLikeFirst } from "../undoActions";

// Pin and favorite over a ticked selection follow the first row, so rows
// already in the end state are left alone. The timeline entry and the toast
// count the rows that changed, not the whole selection.
const [A, B, C] = ["a", "b", "c"].map((ch) => ch.repeat(32));
const s = () => useInboxStore.getState() as any;
const owner = {};
const titlesSince = (n: number) => (toast.getHistory() as Array<{ title?: unknown }>).slice(n).map((t) => String(t.title ?? ""));
const row = (id: string, over: Record<string, unknown> = {}) => ({ _id: id, session_id: id, title: id.slice(0, 1), updated_at: 1, ...over });

beforeAll(() => s()._setDispatch(async () => null, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  setUndoNotifier(CODECAST_UNDO_NOTIFIER);
  _resetUndoStacks();
  useInboxStore.setState({
    pending: {}, favorites: [], clientState: {}, currentSessionId: null,
    sessions: { [A]: row(A), [B]: row(B, { is_pinned: true, inbox_pinned_at: 5 }), [C]: row(C) },
    conversations: { [A]: row(A), [B]: row(B, { inbox_pinned_at: 5 }), [C]: row(C, { is_favorite: true }) },
  } as any);
});

describe("toggleSessionsLikeFirst", () => {
  it("pin over a mixed selection names the rows it pinned", () => {
    const n = toast.getHistory().length;
    toggleSessionsLikeFirst([A, B, C], "pin");
    expect([A, B, C].map((id) => !!s().sessions[id].is_pinned)).toEqual([true, true, true]);
    expect(getUndoHistory().items[0]!.label).toBe("Pinned 2 sessions");
    expect(titlesSince(n).join("|")).toContain("Pinned 2 sessions");
  });

  it("favorite over a mixed selection names the rows it favorited", () => {
    const n = toast.getHistory().length;
    toggleSessionsLikeFirst([A, B, C], "favorite");
    expect(getUndoHistory().items[0]!.label).toBe("Favorited 2 sessions");
    expect(titlesSince(n).join("|")).toContain("Added 2 sessions to favorites");
  });

  it("one changed row keeps its own label", () => {
    toggleSessionsLikeFirst([B, A], "pin");
    expect(s().sessions[A].is_pinned ?? false).toBe(false);
    expect(s().sessions[B].is_pinned).toBe(false);
    expect(getUndoHistory().items[0]!.label).not.toContain("2 sessions");
  });
});
