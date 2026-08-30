import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
  chipFilterOf,
  matchesWorkbench,
  resolveWorkbenchFilter,
  type WorkbenchFilter,
} from "../workbench";
import { useInboxStore, type BucketItem, type InboxSession } from "../inboxStore";
import { _resetViewNavForTests, declareViewNav } from "../viewNav";
import { switchToWorkbench } from "../../lib/workbenchSwitch";

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

// -- The chip filter ---------------------------------------------------------
// A layout carries the session panel's one filter chip too: triaging a single
// label is a different activity from triaging everything.

const bucketMap = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([id, name]) => [id, { name }]));

describe("capturing the chip", () => {
  it("records the live bucket by id AND name — a shared layout resolves either way", () => {
    const filter = chipFilterOf({
      activeBucketFilter: "b1",
      chipFilterExclude: true,
      buckets: bucketMap({ b1: "triage" }),
    });
    expect(filter).toEqual({ bucket: { id: "b1", name: "triage" }, exclude: true });
    expect(captureWorkbench(createWorkspace(), { filter }).filter).toEqual(filter);
  });

  it("records a project chip with its path, and nothing at all when no chip is up", () => {
    expect(chipFilterOf({ activeProjectFilter: "web", activeProjectPath: "/x/web" })).toEqual({
      project: { name: "web", path: "/x/web" },
      exclude: false,
    });
    expect(chipFilterOf({})).toBeUndefined();
    expect(captureWorkbench(createWorkspace()).filter).toBeUndefined();
  });
});

describe("resolving a snapshot's chip against the applier's own labels", () => {
  const buckets = bucketMap({ mine: "triage" });

  it("uses the id when this user has that label", () => {
    const f: WorkbenchFilter = { bucket: { id: "mine", name: "triage" }, exclude: true };
    expect(resolveWorkbenchFilter(f, buckets)).toEqual({ bucket: "mine", project: null, projectPath: null, exclude: true });
  });

  it("falls back to the name when the id belongs to whoever shared the layout", () => {
    const f: WorkbenchFilter = { bucket: { id: "theirs", name: "triage" } };
    expect(resolveWorkbenchFilter(f, buckets).bucket).toBe("mine");
  });

  it("drops a label neither key resolves — filtering by one you don't have would empty the panel", () => {
    const f: WorkbenchFilter = { bucket: { id: "theirs", name: "shipping" }, exclude: true };
    expect(resolveWorkbenchFilter(f, buckets)).toEqual({ bucket: null, project: null, projectPath: null, exclude: false });
  });

  it("no filter is no filter, exclude included", () => {
    expect(resolveWorkbenchFilter(undefined, buckets)).toEqual({ bucket: null, project: null, projectPath: null, exclude: false });
  });
});

describe("matching the chip (the active highlight)", () => {
  const buckets = bucketMap({ mine: "triage" });
  const snap = captureWorkbench(createWorkspace(), { filter: { bucket: { id: "mine", name: "triage" }, exclude: false } });
  const noFilter = captureWorkbench(createWorkspace());

  it("a snapshot with no filter matches only while no chip is live", () => {
    expect(matchesWorkbench(createWorkspace(), noFilter, { buckets })).toBe(true);
    const live = chipFilterOf({ activeBucketFilter: "mine", buckets });
    expect(matchesWorkbench(createWorkspace(), noFilter, { buckets, filter: live })).toBe(false);
  });

  it("the same label through a teammate's id still matches — resolution runs on both sides", () => {
    const shared = captureWorkbench(createWorkspace(), { filter: { bucket: { id: "theirs", name: "triage" } } });
    const live = chipFilterOf({ activeBucketFilter: "mine", buckets });
    expect(matchesWorkbench(createWorkspace(), shared, { buckets, filter: live })).toBe(true);
  });

  it("a different label, a project instead, or a flip to exclude is all drift", () => {
    const live = (f: Parameters<typeof chipFilterOf>[0]) => chipFilterOf({ ...f, buckets });
    expect(matchesWorkbench(createWorkspace(), snap, { buckets, filter: live({ activeBucketFilter: "mine" }) })).toBe(true);
    expect(matchesWorkbench(createWorkspace(), snap, { buckets, filter: live({ activeBucketFilter: "other" }) })).toBe(false);
    expect(matchesWorkbench(createWorkspace(), snap, { buckets, filter: live({ activeProjectFilter: "web" }) })).toBe(false);
    expect(matchesWorkbench(createWorkspace(), snap, { buckets, filter: live({ activeBucketFilter: "mine", chipFilterExclude: true }) })).toBe(false);
  });

  it("an identical arrangement still drifts when the chip is gone", () => {
    // Panes and zen match exactly; only the chip differs, and that is enough.
    expect(matchesWorkbench(applyWorkbench(createWorkspace(), snap), snap, { buckets })).toBe(false);
  });
});

// -- Applying the chip (store action) ----------------------------------------

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

const bucket = (id: string, name: string): BucketItem => ({ _id: id, name, created_at: 1, updated_at: 1 });

const withFilter = (filter?: WorkbenchFilter) => captureWorkbench(createWorkspace(), { path: "/inbox", filter });

// The store is a singleton shared across every test FILE in the run, and the
// chip fields feed computeVisualOrder — leaving one set here made unrelated
// suites' dismiss-and-advance find an empty order. Put the view back to neutral.
function resetChipStore() {
  useInboxStore.setState({
    sessions: {},
    buckets: {},
    bucketAssignments: {},
    clientState: {},
    activeBucketFilter: null,
    activeProjectFilter: null,
    activeProjectPath: null,
    chipFilterExclude: false,
    currentSessionId: null,
    viewingDismissedId: null,
    sidePanelSessionId: null,
    tabs: [],
    activeTabId: null,
  } as any);
}

describe("applying a workbench's chip filter", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: { s1: session("s1"), s2: session("s2") },
      buckets: { mine: bucket("mine", "triage"), empty: bucket("empty", "shipping") },
      bucketAssignments: { r1: { _id: "r1", conversation_id: "s2", bucket_id: "mine", updated_at: 1 } },
      pending: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      sessionsWithQueuedMessages: new Set(),
      liveInboxIds: new Set(),
      tabs: [],
      activeBucketFilter: null,
      activeProjectFilter: null,
      activeProjectPath: null,
      chipFilterExclude: false,
      currentSessionId: null,
      viewingDismissedId: null,
      sidePanelSessionId: null,
      currentConversation: {},
      clientState: {},
    } as any);
  });

  afterEach(resetChipStore);

  it("sets the bucket chip by id", () => {
    useInboxStore.getState().applyWorkbench(withFilter({ bucket: { id: "mine", name: "triage" }, exclude: true }));
    const s = useInboxStore.getState();
    expect(s.activeBucketFilter).toBe("mine");
    expect(s.chipFilterExclude).toBe(true);
  });

  it("resolves a shared layout's label by name", () => {
    useInboxStore.getState().applyWorkbench(withFilter({ bucket: { id: "theirs", name: "triage" } }));
    expect(useInboxStore.getState().activeBucketFilter).toBe("mine");
  });

  it("drops a label this user does not have, leaving the panel unfiltered", () => {
    useInboxStore.getState().applyWorkbench(withFilter({ bucket: { id: "theirs", name: "nope" } }));
    expect(useInboxStore.getState().activeBucketFilter).toBeNull();
  });

  it("sets a project chip, clearing the bucket — the chip row is ONE filter", () => {
    useInboxStore.setState({ activeBucketFilter: "mine" } as any);
    useInboxStore.getState().applyWorkbench(withFilter({ project: { name: "web", path: "/x/web" } }));
    const s = useInboxStore.getState();
    expect(s.activeBucketFilter).toBeNull();
    expect(s.activeProjectFilter).toBe("web");
    expect(s.activeProjectPath).toBe("/x/web");
  });

  it("a layout saved with no chip clears the live one — a layout is the whole view", () => {
    useInboxStore.setState({ activeBucketFilter: "mine", chipFilterExclude: true } as any);
    useInboxStore.getState().applyWorkbench(withFilter());
    const s = useInboxStore.getState();
    expect(s.activeBucketFilter).toBeNull();
    expect(s.chipFilterExclude).toBe(false);
  });
});

describe("focus eviction after the chip changes", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: { s1: session("s1"), s2: session("s2") },
      buckets: { mine: bucket("mine", "triage"), empty: bucket("empty", "shipping") },
      bucketAssignments: { r1: { _id: "r1", conversation_id: "s2", bucket_id: "mine", updated_at: 1 } },
      pending: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      sessionsWithQueuedMessages: new Set(),
      liveInboxIds: new Set(),
      tabs: [],
      activeBucketFilter: null,
      activeProjectFilter: null,
      activeProjectPath: null,
      chipFilterExclude: false,
      currentSessionId: null,
      viewingDismissedId: null,
      sidePanelSessionId: null,
      currentConversation: {},
      clientState: {},
    } as any);
  });

  afterEach(resetChipStore);

  const triage = withFilter({ bucket: { id: "mine", name: "triage" } });

  // currentSessionId is guarded (store/viewNav): a raw seed must declare a
  // source or the middleware reverts it.
  const focus = (fields: Record<string, unknown>) => {
    declareViewNav("gesture");
    useInboxStore.setState(fields as any);
    _resetViewNavForTests();
  };

  it("moves the inbox selection to the top of the list the filter renders", () => {
    focus({ currentSessionId: "s1" });
    useInboxStore.getState().applyWorkbench(triage, undefined, "/inbox");
    expect(useInboxStore.getState().currentSessionId).toBe("s2");
  });

  it("leaves a still-visible selection alone", () => {
    focus({ currentSessionId: "s2" });
    useInboxStore.getState().applyWorkbench(triage, undefined, "/inbox");
    expect(useInboxStore.getState().currentSessionId).toBe("s2");
  });

  it("clears the selection when the filter empties the list", () => {
    focus({ currentSessionId: "s1" });
    useInboxStore.getState().applyWorkbench(withFilter({ bucket: { id: "empty", name: "shipping" } }), undefined, "/inbox");
    expect(useInboxStore.getState().currentSessionId).toBeNull();
  });

  // A working page no longer carries a conversation beside it, so its rail
  // highlights the panel's own selection like any plain surface — that is
  // the pointer the eviction moves, and the attended conversation stays put.
  it("a working page moves the panel pointer, like any plain surface", () => {
    focus({ currentSessionId: "s1", sidePanelSessionId: "s1" });
    useInboxStore.getState().applyWorkbench(triage, undefined, "/tasks");
    const s = useInboxStore.getState();
    expect(s.sidePanelSessionId).toBe("s2");
    expect(s.currentSessionId).toBe("s1");
  });

  it("a plain surface is where the side panel's selection moves instead", () => {
    focus({ currentSessionId: "s1", sidePanelSessionId: "s1" });
    useInboxStore.getState().applyWorkbench(triage, undefined, "/projects");
    const s = useInboxStore.getState();
    expect(s.sidePanelSessionId).toBe("s2");
    expect(s.currentSessionId).toBe("s1");
  });

  it("an unchanged chip evicts nobody — switching arrangements is not a filter change", () => {
    focus({ currentSessionId: "s1", activeBucketFilter: null });
    useInboxStore.getState().applyWorkbench(withFilter(), undefined, "/inbox");
    expect(useInboxStore.getState().currentSessionId).toBe("s1");
  });

  // A chip clicked by hand is the same gesture as a layout switch at a smaller
  // size, so it evicts the same way; the surface comes from the active tab (what
  // usePathname reports in the shell), so no caller threads a pathname through.
  describe("clicking a chip evicts too", () => {
    const onTab = (path: string) => useInboxStore.setState({ tabs: [{ id: "t", title: "", path, createdAt: 0 }], activeTabId: "t" } as any);

    it("an include chip on the inbox tab moves the selection to the top", () => {
      onTab("/inbox?s=s1");
      focus({ currentSessionId: "s1" });
      useInboxStore.getState().setActiveBucketFilter("mine");
      expect(useInboxStore.getState().currentSessionId).toBe("s2");
    });

    it("an exclude chip evicts the session it hides", () => {
      onTab("/inbox?s=s2");
      focus({ currentSessionId: "s2" });
      useInboxStore.getState().setActiveBucketFilter("mine", true);
      expect(useInboxStore.getState().currentSessionId).toBe("s1");
    });

    it("a project chip on a plain-surface tab moves the side panel's selection", () => {
      onTab("/projects");
      focus({ currentSessionId: "s1", sidePanelSessionId: "s1" });
      useInboxStore.getState().setActiveProjectFilter("nowhere", null);
      const s = useInboxStore.getState();
      expect(s.sidePanelSessionId).toBeNull();
      expect(s.currentSessionId).toBe("s1");
    });
  });

  // The surface a switch LANDS on decides which pointer moves. Reading the
  // pre-nav pathname evicted against the list being left behind: ⌥3 from
  // /projects to an /inbox layout moved the panel pointer and left
  // currentSessionId on a session the destination's filter hides.
  describe("switchToWorkbench resolves the destination first", () => {
    const fakeNav = () => {
      const pushed: string[] = [];
      return { pushed, push: (p: string) => pushed.push(p) };
    };

    it("a layout that changes surface evicts against the surface it lands on", () => {
      focus({ currentSessionId: "s1", sidePanelSessionId: "s1" });
      const nav = fakeNav();
      switchToWorkbench(triage, nav, "/projects");
      expect(nav.pushed).toEqual(["/inbox"]);
      const s = useInboxStore.getState();
      expect(s.currentSessionId).toBe("s2");
      expect(s.sidePanelSessionId).toBe("s1");
    });

    it("staying on the same surface keeps the current pathname and does not navigate", () => {
      focus({ currentSessionId: "s1" });
      const nav = fakeNav();
      switchToWorkbench(triage, nav, "/inbox");
      expect(nav.pushed).toEqual([]);
      expect(useInboxStore.getState().currentSessionId).toBe("s2");
    });
  });
});
