import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab, type InboxSession } from "../inboxStore";

// Regression for the "desktop swaps to one session every ~4s" loop.
//
// The active inbox tab's `path` (`/inbox?s=<id>`) is the source of the inbox's
// `paramSessionId`. In-pane session selection used to move `currentSessionId`
// (and the browser URL) but never the tab path, so the two drifted. The inbox's
// re-assert effect, which re-runs on every sessions heartbeat, then snapped the
// view back to the stale param forever. Keeping the active inbox tab's `?s=` in
// lockstep with the selected session is what closes the loop.

const session = (id: string): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 0,
  is_idle: true,
  has_pending: false,
});

const tab = (id: string, path: string): AppTab => ({ id, title: "", path, createdAt: 0 });

describe("active inbox tab path tracks the current session", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      currentSessionId: null,
      viewingDismissedId: null,
      pending: {},
      clientState: {},
      tabs: [],
      activeTabId: null,
    } as any);
  });

  it("rewrites the active inbox tab's ?s= so it can't drift from the selection", () => {
    useInboxStore.setState({
      sessions: { convX: session("convX") },
      tabs: [tab("t1", "/inbox?s=convStale")],
      activeTabId: "t1",
    } as any);

    useInboxStore.getState().navigateToSession("convX");

    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe("convX");
    // The param the inbox would read now matches the selection — the heartbeat
    // re-assert becomes a no-op instead of yanking back to convStale.
    expect(s.tabs.find((t) => t.id === "t1")!.path).toBe("/inbox?s=convX");
  });

  it("syncs through setCurrentSession too (shared commit path)", () => {
    useInboxStore.setState({
      sessions: { convX: session("convX") },
      tabs: [tab("t1", "/inbox?s=convStale")],
      activeTabId: "t1",
    } as any);

    useInboxStore.getState().setCurrentSession("convX");

    expect(useInboxStore.getState().tabs.find((t) => t.id === "t1")!.path).toBe("/inbox?s=convX");
  });

  it("leaves a non-inbox tab path (e.g. /tasks) untouched", () => {
    useInboxStore.setState({
      sessions: { convX: session("convX") },
      tabs: [tab("t1", "/tasks")],
      activeTabId: "t1",
    } as any);

    useInboxStore.getState().navigateToSession("convX");

    expect(useInboxStore.getState().tabs.find((t) => t.id === "t1")!.path).toBe("/tasks");
  });

  it("rekeys a tab's ?s= from optimistic stub id to the real server id", () => {
    useInboxStore.setState({
      sessions: { stub123: session("stub123") },
      tabs: [tab("t1", "/inbox?s=stub123")],
      activeTabId: "t1",
    } as any);

    (useInboxStore.getState() as any)._rekeySession("stub123", "realServerId");

    expect(useInboxStore.getState().tabs.find((t) => t.id === "t1")!.path).toBe("/inbox?s=realServerId");
  });

  // Dismiss/kill/stash advance the selection past the hidden session. That path
  // (hideSessionInDraft) moved currentSessionId but used to leave the tab's `?s=`
  // pointed at the just-hidden session, so the inbox re-assert effect snapped the
  // view back onto it (navigateToSession of a hidden id surfaces it as a peek) the
  // next time it ran — e.g. on tab re-activation. The advance must rewrite `?s=`.
  const convId = (suffix: string) => "jx7" + "0".repeat(29 - suffix.length) + suffix;
  const live = (id: string): InboxSession => ({ ...session(id), message_count: 2, is_idle: true });

  it("stash moves the active inbox tab's ?s= onto the advanced selection, off the hidden one", () => {
    const idA = convId("aaaa");
    const idB = convId("bbbb");
    useInboxStore.setState({
      sessions: { [idA]: live(idA), [idB]: live(idB) },
      tabs: [tab("t1", "/inbox?s=stale")],
      activeTabId: "t1",
    } as any);
    // Establish the current session through the declared nav path (raw setState of
    // currentSessionId is rejected by the view-motion guard).
    useInboxStore.getState().navigateToSession(idA);

    useInboxStore.getState().stashSession(idA);

    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe(idB); // advanced off the hidden session
    const path = s.tabs.find((t) => t.id === "t1")!.path;
    // The param the re-assert effect reads now tracks the advanced session, so it
    // can never yank the view back onto the just-stashed one.
    expect(path).toBe(`/inbox?s=${idB}`);
    expect(path).not.toContain(idA);
  });

  it("kill clears the tab ?s= to a bare /inbox when the hidden session was the last", () => {
    const idA = convId("aaaa");
    useInboxStore.setState({
      sessions: { [idA]: live(idA) },
      tabs: [tab("t1", "/inbox?s=stale")],
      activeTabId: "t1",
    } as any);
    useInboxStore.getState().navigateToSession(idA);

    useInboxStore.getState().killSession(idA);

    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBeNull();
    expect(s.tabs.find((t) => t.id === "t1")!.path).toBe("/inbox");
  });

  it("markKilling (local row removal) also moves the tab ?s= onto the advanced selection", () => {
    const idA = convId("aaaa");
    const idB = convId("bbbb");
    useInboxStore.setState({
      sessions: { [idA]: live(idA), [idB]: live(idB) },
      tabs: [tab("t1", "/inbox?s=stale")],
      activeTabId: "t1",
    } as any);
    useInboxStore.getState().navigateToSession(idA);

    useInboxStore.getState().markKilling(idA);

    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe(idB);
    expect(s.tabs.find((t) => t.id === "t1")!.path).toBe(`/inbox?s=${idB}`);
  });

  it("does not touch tabs when none are active (web, no tab shell)", () => {
    useInboxStore.setState({
      sessions: { convX: session("convX") },
      tabs: [],
      activeTabId: null,
    } as any);

    useInboxStore.getState().navigateToSession("convX");

    expect(useInboxStore.getState().currentSessionId).toBe("convX");
    expect(useInboxStore.getState().tabs).toEqual([]);
  });
});
