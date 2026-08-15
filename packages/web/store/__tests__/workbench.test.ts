import { describe, expect, it } from "bun:test";
import {
  createWorkspace,
  showPane,
  hidePane,
  setPresentation,
  setSize,
  SESSION_LIST_PANE,
  TERMINAL_PANE,
  type Pane,
  type WorkspaceState,
} from "../workspace";
import {
  captureWorkbench,
  applyWorkbench,
  matchesWorkbench,
} from "../workbench";

const convo = (ref: string): Pane => ({ kind: "conversation", ref });
const comments = (ref: string): Pane => ({ kind: "comments", ref });

/** A lived-in arrangement: rail open, companion pinned, terminal up. */
function workedIn(): WorkspaceState {
  let ws = createWorkspace();
  ws = setPresentation(ws, "nav", "collapsed");
  ws = showPane(ws, "context", SESSION_LIST_PANE);
  ws = setSize(ws, "context", 31);
  ws = showPane(ws, "secondary", convo("a"), { presentation: "split" });
  ws = setSize(ws, "secondary", 44);
  ws = showPane(ws, "dock", TERMINAL_PANE);
  ws = setSize(ws, "dock", 260);
  return ws;
}

describe("capture", () => {
  it("records every slot's occupant, presentation and size", () => {
    const snap = captureWorkbench(workedIn(), { zen: false, path: "/tasks" });
    expect(snap.slots.nav).toEqual({ pane: "empty", presentation: "collapsed", size: undefined });
    expect(snap.slots.context).toEqual({ pane: "sessionList", presentation: "split", size: 31 });
    // A conversation is a subject: the snapshot records THAT something subject-
    // shaped sat there, never which one.
    expect(snap.slots.secondary!.pane).toBe("subject");
    expect(snap.slots.secondary!.size).toBe(44);
    expect(snap.slots.dock).toEqual({ pane: "terminal", presentation: "split", size: 260 });
    expect(snap.path).toBe("/tasks");
  });

  it("records comments as restorable, not as a subject", () => {
    let ws = createWorkspace();
    ws = showPane(ws, "context", comments("c1"));
    const snap = captureWorkbench(ws);
    expect(snap.slots.context!.pane).toBe("comments");
  });
});

describe("apply", () => {
  it("restores the whole chrome atomically", () => {
    // Wreck the layout relative to the snapshot, then switch back.
    const snap = captureWorkbench(workedIn());
    let ws = createWorkspace();
    ws = showPane(ws, "context", comments("zzz"));
    ws = setPresentation(ws, "nav", "split");
    ws = applyWorkbench(ws, snap, { conversationId: "zzz" });
    expect(ws.nav.presentation).toBe("collapsed");
    expect(ws.context.pane).toEqual(SESSION_LIST_PANE);
    expect(ws.context.size).toBe(31);
    expect(ws.dock.pane).toEqual(TERMINAL_PANE);
    expect(ws.dock.size).toBe(260);
  });

  it("clears sticky dismissals — applying a workbench outranks any earlier ✕", () => {
    const snap = captureWorkbench(workedIn());
    let ws = createWorkspace();
    ws = showPane(ws, "context", SESSION_LIST_PANE);
    ws = hidePane(ws, "context", { remember: true });
    ws = applyWorkbench(ws, snap);
    expect(ws.context.pane).toEqual(SESSION_LIST_PANE);
    expect(ws.context.userClosed).toBeNull();
  });

  it("keeps the current subject in a subject slot instead of conjuring one", () => {
    const snap = captureWorkbench(workedIn()); // secondary: subject, split, 44
    let ws = createWorkspace();
    ws = showPane(ws, "secondary", convo("live"), { presentation: "overlay" });
    ws = applyWorkbench(ws, snap);
    expect(ws.secondary.pane).toEqual(convo("live"));
    expect(ws.secondary.presentation).toBe("split");
    expect(ws.secondary.size).toBe(44);
    // …and with no subject on hand, the slot arranges empty.
    const bare = applyWorkbench(createWorkspace(), snap);
    expect(bare.secondary.pane).toBeNull();
    expect(bare.secondary.presentation).toBe("split");
  });

  it("re-derives comments from the conversation you are on", () => {
    let ws = createWorkspace();
    ws = showPane(ws, "context", comments("old"));
    const snap = captureWorkbench(ws);
    const applied = applyWorkbench(createWorkspace(), snap, { conversationId: "new" });
    expect(applied.context.pane).toEqual(comments("new"));
    // No conversation on screen → nothing to show, slot stays empty.
    const nowhere = applyWorkbench(createWorkspace(), snap, {});
    expect(nowhere.context.pane).toBeNull();
  });

  it("never opens a terminal on a device that cannot host one", () => {
    const snap = captureWorkbench(workedIn());
    const ws = applyWorkbench(createWorkspace(), snap, { allowTerminal: false });
    expect(ws.dock.pane).toBeNull();
  });

  it("keeps the current size when the snapshot has none for a slot", () => {
    let ws = createWorkspace();
    ws = setSize(ws, "dock", 300);
    const snap = captureWorkbench(createWorkspace()); // no dock size recorded
    ws = applyWorkbench(ws, snap);
    expect(ws.dock.size).toBe(300);
  });

  it("primary always keeps the page — the route owns the stage", () => {
    const snap = captureWorkbench(workedIn());
    const ws = applyWorkbench(createWorkspace(), snap);
    expect(ws.primary.pane).toEqual({ kind: "page" });
  });
});

describe("matching (the active highlight)", () => {
  it("a freshly applied workbench matches — save then switch back is stable", () => {
    const snap = captureWorkbench(workedIn());
    const ws = applyWorkbench(createWorkspace(), snap, { conversationId: "c" });
    expect(matchesWorkbench(ws, snap)).toBe(true);
  });

  it("hand-closing a rail the workbench opened deselects it", () => {
    const snap = captureWorkbench(workedIn());
    let ws = applyWorkbench(createWorkspace(), snap);
    ws = hidePane(ws, "context", { remember: true });
    expect(matchesWorkbench(ws, snap)).toBe(false);
  });

  it("a drag-resize or a different subject does not deselect", () => {
    const snap = captureWorkbench(workedIn()); // secondary: subject
    let ws = applyWorkbench(createWorkspace(), snap);
    ws = setSize(ws, "secondary", 55);
    ws = showPane(ws, "secondary", convo("other"), { presentation: "split" });
    expect(matchesWorkbench(ws, snap)).toBe(true);
  });

  it("zen is part of the arrangement", () => {
    const snap = captureWorkbench(workedIn(), { zen: false });
    const ws = applyWorkbench(createWorkspace(), snap);
    expect(matchesWorkbench(ws, snap, { zen: true })).toBe(false);
  });

  it("a workbench that could not materialize its subject still matches", () => {
    let base = createWorkspace();
    base = showPane(base, "context", comments("c1"));
    const snap = captureWorkbench(base);
    const ws = applyWorkbench(createWorkspace(), snap, {}); // no conversation
    expect(ws.context.pane).toBeNull();
    expect(matchesWorkbench(ws, snap)).toBe(true);
  });

  it("hand-closing an excusable pane IS drift — that's what update surfaces", () => {
    const snap = captureWorkbench(workedIn()); // dock: terminal
    let ws = applyWorkbench(createWorkspace(), snap, { conversationId: "c" });
    expect(matchesWorkbench(ws, snap)).toBe(true);
    ws = hidePane(ws, "dock", { remember: true });
    expect(matchesWorkbench(ws, snap)).toBe(false);
  });

  it("capture names every slot — switching must be total", () => {
    const snap = captureWorkbench(createWorkspace());
    for (const id of ["nav", "list", "primary", "secondary", "context", "dock"] as const) {
      expect(snap.slots[id]).toBeDefined();
    }
  });
});
