import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { useVaultStore } from "../../store/vaultStore";
import { leavesOf } from "../../store/stageSplit";
import { editorReachable, openFiles, openInEditor } from "../filesPane";

// openInEditor against the real stage: where the Files pane goes, what the
// address carries, and the opener the editor's agent link reads off the tab.

const state = () => useInboxStore.getState();
const activeTab = () => state().tabs.find((t) => t.id === state().activeTabId)!;
const S1 = "a".repeat(32);
const S2 = "b".repeat(32);
const tab = (over?: Partial<AppTab>): AppTab => ({ id: "t1", title: "A", path: `/conversation/${S1}`, createdAt: 0, ...over });
const filesLeaves = () => leavesOf(activeTab().layout).filter((l) => l.path.startsWith("/files"));
const leafOf = (path: string) => leavesOf(activeTab().layout).find((l) => l.path === path)!;

let restore: () => void;
beforeAll(() => {
  const noop = () => {};
  restore = replaceGlobals({
    window: { innerWidth: 1400, location: { pathname: "/", search: "" }, history: { pushState: noop, replaceState: noop } },
  });
});
afterAll(() => restore());

beforeEach(() => {
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as never);
});

describe("openInEditor on the stage", () => {
  it("opens beside the conversation and records it as the opener", () => {
    openInEditor({ path: "/Users/ada/app/a.ts", line: 3 });
    expect(filesLeaves()).toHaveLength(1);
    expect(filesLeaves()[0].path).toContain("a.ts");
    expect(activeTab().editorOpenedFrom).toBe(S1);
  });

  it("re-points the Files pane already there instead of stacking another", () => {
    openInEditor({ path: "/Users/ada/app/a.ts" });
    state().stageInsertLeaf("root", "left", `/conversation/${S2}`);
    const s2 = leafOf(`/conversation/${S2}`);
    openInEditor({ path: "/Users/ada/app/b.ts", line: 9 }, { fromLeaf: s2.id });
    expect(filesLeaves()).toHaveLength(1);
    const files = filesLeaves()[0];
    // The workspace opens the URL's file as a tab in that pane (CodeWorkspace),
    // so the pane's address is the new file and the pane is focused.
    expect(files.path).toBe("/files?path=%2FUsers%2Fada%2Fapp%2Fb.ts&l=9");
    expect(activeTab().focusedLeafId).toBe(files.id);
    expect(leafOf(`/conversation/${S1}`)).toBeDefined();
    // The editor now works with the conversation it was opened from.
    expect(activeTab().editorOpenedFrom).toBe(S2);
  });

  it("a cloud host conversation's path opens on that host", () => {
    openInEditor({ path: "x.ts", line: 4, ctx: { base: "/home/ada/app", home: "/home/ada", deviceId: "host-1" } });
    expect(filesLeaves()[0].path).toBe("/files?path=%2Fhome%2Fada%2Fapp%2Fx.ts&d=host-1&l=4");
  });

  it("openFiles reuses the Files pane too", () => {
    openFiles("/files?f=a.md");
    openFiles("/files?f=b.md");
    expect(filesLeaves().map((l) => l.path)).toEqual(["/files?f=b.md"]);
  });
});

describe("editorReachable", () => {
  it("is false for another person's conversation and without a daemon", () => {
    expect(editorReachable({ foreign: true }, "connected")).toBe(false);
    expect(editorReachable({}, "no-daemon")).toBe(false);
    expect(editorReachable({ deviceId: "host-1" }, "connected")).toBe(true);
    expect(editorReachable(null, useVaultStore.getState().connection)).toBe(true);
  });
});
