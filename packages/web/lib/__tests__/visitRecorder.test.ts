import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { startVisitRecorder } from "../visitRecorder";

// Recents record what comes on screen, however it got there: a navigation, a
// tab switch, a pane opened beside, a query-only replace.

const SID = "k7abcdefghijklmnopqrstuvwxyz0123";
const keys = () => useInboxStore.getState().recentVisits.map((v) => v.key);
const tab = (id: string, path: string, extra: object = {}) => ({ id, title: "", path, createdAt: 1, ...extra });
const setTabs = (tabs: any[], activeTabId: string) => useInboxStore.setState({ tabs, activeTabId } as any);

describe("visit recorder", () => {
  let stop: () => void;

  beforeEach(() => {
    useInboxStore.setState({ recentVisits: [], tabs: [tab("t1", "/tasks")], activeTabId: "t1", sessions: {}, conversations: {} } as any);
    stop = startVisitRecorder();
  });
  afterEach(() => stop());

  it("records what is already on screen, then each place the tab moves to", () => {
    setTabs([tab("t1", "/plans/pl-1")], "t1");
    setTabs([tab("t1", `/inbox?s=${SID}`)], "t1");
    setTabs([tab("t1", "/inbox")], "t1");
    expect(keys()).toEqual(["page:/inbox", SID, "page:/plans/pl-1", "page:/tasks"]);
  });

  it("records a switch to another tab", () => {
    setTabs([tab("t1", "/tasks"), tab("t2", "/docs/d1")], "t1");
    expect(keys()).toEqual(["page:/tasks"]);
    setTabs([tab("t1", "/tasks"), tab("t2", "/docs/d1")], "t2");
    expect(keys()).toEqual(["page:/docs/d1", "page:/tasks"]);
  });

  it("records a pane opened beside, focused or not, and a session pane as the session", () => {
    const layout = {
      type: "split", id: "root", dir: "row",
      children: [
        { type: "leaf", id: "a", path: "/tasks" },
        { type: "leaf", id: "b", path: `/conversation/${SID}` },
      ],
    };
    setTabs([tab("t1", "/tasks", { layout, focusedLeafId: "a" })], "t1");
    expect(keys()).toEqual([SID, "page:/tasks"]);
  });

  it("a query-only change is the same page, not a second entry", () => {
    setTabs([tab("t1", "/search?q=x")], "t1");
    setTabs([tab("t1", "/search?q=x+influence")], "t1");
    expect(keys()).toEqual(["page:/search?q=x+influence", "page:/tasks"]);
  });

  it("skips routes outside the shell", () => {
    setTabs([tab("t1", "/settings")], "t1");
    expect(keys()).toEqual(["page:/tasks"]);
  });
});
