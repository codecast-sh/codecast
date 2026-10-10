import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { _resetUndoStacks, getUndoHistory, setUndoNotifier } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { CODECAST_UNDO_NOTIFIER, gestureToast, UNDO_QUIET_ACTION_CLASS, UNDO_RECEIPT_CLASS, performRedo, performUndo, pushUndo, showUndoToast, undoEntryToastId, undoStepMessage, undoTo, UNDO_STATUS_TOAST_ID } from "../undoStack";
import * as undoTimeline from "../../lib/undoTimelineOpen";
import { undoAsOne } from "../undoActions";

// B4: a toast's Undo takes back the change it announced, even after newer
// changes were recorded on top of it. The toasts are read from sonner's own
// history, so this exercises the notifier codecast installs.
const A = "a".repeat(32);
const B = "b".repeat(32);

type Shown = { title?: unknown; action?: { label?: unknown; onClick?: (e: any) => void } };
const undoToastFor = (title: string) =>
  (toast.getHistory() as Shown[]).filter((t) => t.title === title && (t.action as any)?.label === "Undo").at(-1);

describe("an undo toast targets its own entry", () => {
  beforeEach(() => {
    // Another file in the same run may have installed its own notifier.
    setUndoNotifier(CODECAST_UNDO_NOTIFIER);
    _resetUndoStacks();
    useInboxStore.setState({
      pending: {},
      currentSessionId: null,
      clientState: {},
      sessions: { [A]: { _id: A, title: "First", updated_at: 1 }, [B]: { _id: B, title: "Second", updated_at: 1 } },
      conversations: { [A]: { _id: A, title: "First" }, [B]: { _id: B, title: "Second" } },
    } as any);
  });

  test("the stash toast undoes the stash, not the newer rename", () => {
    useInboxStore.getState().stashSession(A);
    const stashToast = undoToastFor("Stashed “First”");
    expect(stashToast).toBeDefined();

    useInboxStore.getState().renameSession(B, "Renamed");
    expect(getUndoHistory().items).toHaveLength(2);

    stashToast!.action!.onClick!({ preventDefault() {} });
    const sessions = useInboxStore.getState().sessions as any;
    expect(sessions[A].inbox_stashed_at ?? null).toBe(null);
    // The newer change is untouched.
    expect(sessions[B].title).toBe("Renamed");
    const byLabel = Object.fromEntries(getUndoHistory().items.map((i) => [i.label, i.status]));
    expect(byLabel["Stashed “First”"]).toBe("undone");
    expect(byLabel["Renamed “Second” to “Renamed”"]).toBe("done");
  });
});

// The announcement toasts: one id updated in place, the History doorway only
// after an undo with more history to show, silence while the card is open,
// and the partial and conflict copy. sonner's history only accumulates (the
// mounted Toaster merges a same-id toast into the one on screen), so these
// read the newest record per id since the test began.
describe("undo announcements", () => {
  type Shown = { id: unknown; title?: unknown; action?: { label?: unknown } };
  let mark = 0;
  const since = () => (toast.getHistory() as Shown[]).slice(mark);
  const latest = (id: string) => since().filter((t) => t.id === id).at(-1);
  const status = () => latest(UNDO_STATUS_TOAST_ID);
  // sonner dismisses on a frame; run it at once.
  const hadRaf = "requestAnimationFrame" in globalThis;
  let dismissed: ReturnType<typeof spyOn>;
  beforeAll(() => {
    if (!hadRaf) (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => { cb(0); return 0; };
    dismissed = spyOn(toast, "dismiss");
  });
  afterAll(() => {
    if (!hadRaf) delete (globalThis as any).requestAnimationFrame;
    dismissed.mockRestore();
  });

  beforeEach(() => {
    // Another file in the same run may have installed its own notifier.
    setUndoNotifier(CODECAST_UNDO_NOTIFIER);
    _resetUndoStacks();
    undoTimeline.close();
    dismissed.mockClear();
    mark = toast.getHistory().length;
    useInboxStore.setState({
      pending: {},
      currentSessionId: null,
      clientState: {},
      sessions: { [A]: { _id: A, title: "First", updated_at: 1 }, [B]: { _id: B, title: "Second", updated_at: 1 } },
      conversations: { [A]: { _id: A, title: "First" }, [B]: { _id: B, title: "Second" } },
    } as any);
  });

  test("undo and redo update one toast in place and retire the entry's own Undo toast", () => {
    useInboxStore.getState().stashSession(A);
    const entryId = getUndoHistory().items[0]!.id;
    expect(latest(undoEntryToastId(entryId))?.action?.label).toBe("Undo");

    performUndo();
    expect(dismissed).toHaveBeenCalledWith(undoEntryToastId(entryId));
    expect(status()?.title).toBe("Undid: Stashed “First”");

    performRedo();
    expect(status()?.title).toBe("Redid: Stashed “First”");
    // Named explicitly, so the merge on screen drops any earlier action.
    expect(status()).toHaveProperty("action", undefined);
    // Every announcement used the one id.
    expect(new Set(since().filter((t) => String(t.title).match(/^(Undid|Redid)/)).map((t) => t.id))).toEqual(new Set([UNDO_STATUS_TOAST_ID]));
  });

  test("a multi-step undo takes down every stepped entry's Undo toast", () => {
    useInboxStore.getState().stashSession(A);
    useInboxStore.getState().stashSession(B);
    const [newer, older] = getUndoHistory().items.map((i) => i.id);
    expect(latest(undoEntryToastId(newer!))?.action?.label).toBe("Undo");
    expect(latest(undoEntryToastId(older!))?.action?.label).toBe("Undo");
    dismissed.mockClear();
    // "Back to here" on the older row walks both entries back in one call.
    expect(undoTo(older!)).toBe(2);
    expect(dismissed).toHaveBeenCalledWith(undoEntryToastId(newer!));
    expect(dismissed).toHaveBeenCalledWith(undoEntryToastId(older!));
    expect(status()?.title).toBe("Undid 2 changes");
  });

  test("an entry lost to a conflict takes its Undo toast down too", () => {
    // The change was taken back elsewhere, so its undo finds nothing to do.
    const id = pushUndo({ label: "Moved it", undo: () => ({ ok: false, reason: "conflict" }), redo: () => {} });
    showUndoToast("Moved it");
    expect(latest(undoEntryToastId(id))?.action?.label).toBe("Undo");
    dismissed.mockClear();
    performUndo();
    expect(status()?.title).toMatch(/^Can't undo/);
    expect(dismissed).toHaveBeenCalledWith(undoEntryToastId(id));
  });

  test("History appears only after an undo, when more history exists", () => {
    useInboxStore.getState().stashSession(A);
    performUndo();
    // The only history is the step just announced.
    expect(status()).toHaveProperty("action", undefined);

    performRedo();
    useInboxStore.getState().renameSession(B, "Renamed");
    performUndo();
    expect(status()?.action?.label).toBe("History");
    // A side door, worn quietly, not a second primary button.
    expect((status() as any)?.className).toBe(`${UNDO_RECEIPT_CLASS} ${UNDO_QUIET_ACTION_CLASS}`);

    // A redo never offers it, and its update clears the earlier one.
    performRedo();
    expect(status()).toHaveProperty("action", undefined);
    expect(status()).toHaveProperty("className", UNDO_RECEIPT_CLASS);
  });

  test("the notifier is silent while the timeline is open", () => {
    useInboxStore.getState().stashSession(A);
    undoTimeline.open("peek");
    mark = toast.getHistory().length;
    performUndo();
    useInboxStore.getState().renameSession(B, "Renamed");
    expect(since()).toHaveLength(0);
    undoTimeline.close();
  });

  test("a gesture made while the held peek shows keeps its own Undo toast", () => {
    // The peek narrates the steps it takes, not a new gesture: that card is
    // on its way out (the gesture's key or click ends the walk), so the
    // entry's Undo toast is the only place the new change can be taken back.
    useInboxStore.getState().stashSession(A);
    undoTimeline.open("peek");
    mark = toast.getHistory().length;
    gestureToast("Stashed", () => useInboxStore.getState().stashSession(B));
    const head = getUndoHistory().head!;
    expect(latest(undoEntryToastId(head))?.action?.label).toBe("Undo");
    undoTimeline.close();
  });

  test("a gesture made while the interactive card is open shows no toast over it", () => {
    undoTimeline.open("interactive");
    mark = toast.getHistory().length;
    gestureToast("Stashed", () => useInboxStore.getState().stashSession(B));
    expect(since()).toHaveLength(0);
    undoTimeline.close();
  });

  test("a ⌘Z that stops at a confirm entry toasts when the card is closed and marks the row when it is open", () => {
    let undone = 0;
    pushUndo({ label: "Made “First” private", confirm: true, undo: () => { undone += 1; }, redo: () => {} });
    performUndo();
    expect(status()?.title).toBe("Undo Made “First” private from its toast or the history");
    // The stop is a doorway, not a dead end: the entry's own Undo rides on
    // the toast that names it, so the change it points at is one click away
    // long after the entry's own 5 s toast has gone.
    expect(status()?.action?.label).toBe("Undo");
    status()!.action!.onClick({} as any);
    expect(undone).toBe(1);
    const id = pushUndo({ label: "Made “First” private", confirm: true, undo: () => { undone += 1; }, redo: () => {} });

    undoTimeline.open("interactive");
    mark = toast.getHistory().length;
    const before = undoTimeline.getFlash()?.n ?? 0;
    performUndo();
    expect(since()).toHaveLength(0);
    expect(undoTimeline.getFlash()).toEqual({ id, n: before + 1 });
    expect(undone).toBe(1);
    undoTimeline.close();
  });

  test("opening the timeline takes down the status toast under it", () => {
    useInboxStore.getState().stashSession(A);
    performUndo();
    expect(status()?.title).toBe("Undid: Stashed “First”");
    dismissed.mockClear();
    undoTimeline.open("peek");
    expect(dismissed).toHaveBeenCalledWith(UNDO_STATUS_TOAST_ID);
    undoTimeline.close();
  });

  test("opening the timeline takes down the recorded entries' Undo toasts too", () => {
    // The card lists the same entries, each with its own way back, and the
    // toast would cover its lower rows.
    useInboxStore.getState().stashSession(A);
    const entryId = getUndoHistory().items[0]!.id;
    expect(latest(undoEntryToastId(entryId))?.action?.label).toBe("Undo");
    dismissed.mockClear();
    undoTimeline.open("interactive");
    expect(dismissed).toHaveBeenCalledWith(undoEntryToastId(entryId));
    undoTimeline.close();
  });

  test("a conflict says the change came since", () => {
    useInboxStore.getState().renameSession(A, "Mine");
    // Someone else renamed it after.
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [A]: { ...s.sessions[A], title: "Theirs" } } }));
    performUndo();
    expect(status()?.title).toBe("Can't undo Renamed “First” to “Mine”: changed since");
    expect((useInboxStore.getState().sessions as any)[A].title).toBe("Theirs");
  });

  test("a partial step counts the rows it reached", () => {
    const entry = { label: "Filed 3 sessions as Done", objects: [1, 2, 3].map((i) => ({ store: "sessions", id: `s${i}` })), skipped: [{ store: "sessions", id: "s2" }] };
    expect(undoStepMessage("undo", 1, entry)).toBe("Undid: Filed 3 sessions as Done (2 of 3; 1 changed since)");
    expect(undoStepMessage("redo", 1, entry)).toBe("Redid: Filed 3 sessions as Done (2 of 3; 1 changed since)");
    expect(undoStepMessage("undo", 1, { ...entry, skipped: [] })).toBe("Undid: Filed 3 sessions as Done");
    expect(undoStepMessage("undo", 3, entry)).toBe("Undid 3 changes");
  });

  test("a partial step counts an opened session once, not once per store copy", () => {
    // An opened session lives in sessions AND conversations; the engine lists
    // both copies in objects but skips the server row once.
    const C = "c".repeat(32);
    useInboxStore.setState((s: any) => ({
      sessions: { ...s.sessions, [C]: { _id: C, title: "Third", updated_at: 1 } },
      conversations: { ...s.conversations, [C]: { _id: C, title: "Third" } },
    }));
    undoAsOne("Stashed 3 sessions", () => {
      for (const id of [A, B, C]) useInboxStore.getState().stashSession(id);
    });
    // A teammate changed one of them after.
    useInboxStore.setState((s: any) => ({
      sessions: { ...s.sessions, [B]: { ...s.sessions[B], inbox_stashed_at: 99 } },
      conversations: { ...s.conversations, [B]: { ...s.conversations[B], inbox_stashed_at: 99 } },
    }));
    performUndo();
    expect(status()?.title).toBe("Undid: Stashed 3 sessions");
    expect((status() as any)?.description).toBe("2 of 3; 1 changed since");
  });
});
