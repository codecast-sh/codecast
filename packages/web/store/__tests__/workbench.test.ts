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
  WORKBENCH_PRESETS,
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
  it("a freshly applied workbench matches", () => {
    const snap = WORKBENCH_PRESETS.find((p) => p.id === "wb-triage")!.snapshot;
    const ws = applyWorkbench(createWorkspace(), snap);
    expect(matchesWorkbench(ws, snap)).toBe(true);
  });

  it("hand-closing a rail the workbench opened deselects it", () => {
    const snap = WORKBENCH_PRESETS.find((p) => p.id === "wb-triage")!.snapshot;
    let ws = applyWorkbench(createWorkspace(), snap);
    ws = hidePane(ws, "context", { remember: true });
    expect(matchesWorkbench(ws, snap)).toBe(false);
  });

  it("a drag-resize or a different subject does not deselect", () => {
    const build = WORKBENCH_PRESETS.find((p) => p.id === "wb-build")!.snapshot;
    let ws = applyWorkbench(createWorkspace(), build);
    ws = setSize(ws, "secondary", 55);
    ws = showPane(ws, "secondary", convo("other"), { presentation: "split" });
    expect(matchesWorkbench(ws, build)).toBe(true);
  });

  it("zen is part of the arrangement", () => {
    const snap = WORKBENCH_PRESETS.find((p) => p.id === "wb-plan")!.snapshot;
    const ws = applyWorkbench(createWorkspace(), snap);
    expect(matchesWorkbench(ws, snap, { zen: true })).toBe(false);
  });

  it("a workbench that could not materialize its subject still matches", () => {
    const review = WORKBENCH_PRESETS.find((p) => p.id === "wb-review")!.snapshot;
    const ws = applyWorkbench(createWorkspace(), review, {}); // no conversation
    expect(ws.context.pane).toBeNull();
    expect(matchesWorkbench(ws, review)).toBe(true);
  });
});

describe("presets", () => {
  it("each preset names every slot — switching must be total", () => {
    for (const p of WORKBENCH_PRESETS) {
      for (const id of ["nav", "list", "primary", "secondary", "context", "dock"] as const) {
        expect(p.snapshot.slots[id]).toBeDefined();
      }
      expect(p.snapshot.path).toBeTruthy();
    }
  });

  it("presets are distinct arrangements", () => {
    const shapes = WORKBENCH_PRESETS.map((p) => JSON.stringify({ path: p.snapshot.path, slots: p.snapshot.slots }));
    expect(new Set(shapes).size).toBe(WORKBENCH_PRESETS.length);
  });

  it("fully materialized presets do not match each other", () => {
    const ctx = { conversationId: "c", allowTerminal: true };
    for (const a of WORKBENCH_PRESETS) {
      const ws = applyWorkbench(createWorkspace(), a.snapshot, ctx);
      for (const b of WORKBENCH_PRESETS) {
        if (a.id === b.id) continue;
        // The one excused asymmetry: an arrangement whose comments/terminal
        // slot happens to be empty may match a preset that wants one there.
        // With a full context nothing is empty, so all pairs must differ.
        expect(matchesWorkbench(ws, b.snapshot)).toBe(false);
      }
    }
  });
});
