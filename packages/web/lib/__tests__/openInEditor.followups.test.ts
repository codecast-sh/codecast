import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { toast } from "sonner";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { useVaultStore } from "../../store/vaultStore";
import { leavesOf } from "../../store/stageSplit";
import { codeBuffers } from "../code/buffers";
import { registerCodeCommand } from "../code/commands";
import { openInEditor } from "../filesPane";

// The follow-ups openInEditor runs once the workspace is up, which the address
// cannot carry: a diff against a git ref on the view showing the file, and a
// new editor split in the Files pane already on stage. The workspace is
// stubbed at its seams: the buffer cache (which view shows which file) and the
// command registry (which handler takes a command).

const state = () => useInboxStore.getState();
const activeTab = () => state().tabs.find((t) => t.id === state().activeTabId)!;
const filesLeaves = () => leavesOf(activeTab().layout).filter((l) => l.path.startsWith("/files"));
const tab: AppTab = { id: "t1", title: "A", path: `/conversation/${"a".repeat(32)}`, createdAt: 0 };
const ROOT = "/Users/ada/app";
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

let restore: () => void;
let offs: Array<() => void> = [];
let errors: string[] = [];
const realAll = codeBuffers.all.bind(codeBuffers);
const realError = toast.error;
let shown: Array<{ vaultId: string; path: string; view: { dom: { isConnected: boolean } } }> = [];

beforeAll(() => {
  const noop = () => {};
  restore = replaceGlobals({
    window: { innerWidth: 1400, location: { pathname: "/", search: "" }, history: { pushState: noop, replaceState: noop } },
  });
  (codeBuffers as { all: () => unknown[] }).all = () => shown;
  (toast as { error: unknown }).error = (msg: string) => {
    errors.push(msg);
    return 0;
  };
});
afterAll(() => {
  restore();
  (codeBuffers as { all: unknown }).all = realAll;
  (toast as { error: unknown }).error = realError;
});

beforeEach(() => {
  useInboxStore.setState({ tabs: [tab], activeTabId: "t1" } as never);
  useVaultStore.setState({ vaults: [{ id: "v1", root: ROOT }] } as never);
  shown = [];
  errors = [];
});
afterEach(() => {
  offs.forEach((off) => off());
  offs = [];
});

describe("diffAgainst", () => {
  it("runs git.diffAgainst on the view showing the file, once it shows", async () => {
    const calls: Array<{ args: unknown; view: unknown }> = [];
    offs.push(registerCodeCommand("git.diffAgainst", (args, ctx) => void calls.push({ args, view: ctx.view })));
    const view = { dom: { isConnected: true } };
    openInEditor({ path: `${ROOT}/src/a.ts`, line: 4 }, { diffAgainst: { ref: "HEAD", label: "HEAD" } });
    // Another file's view is up first; the diff waits for this file's.
    shown = [{ vaultId: "v1", path: "src/b.ts", view: { dom: { isConnected: true } } }];
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
    shown.push({ vaultId: "v1", path: "src/a.ts", view });
    expect(await until(() => calls.length > 0)).toBe(true);
    expect(calls[0]).toEqual({ args: { ref: "HEAD", label: "HEAD" }, view });
    expect(errors).toEqual([]);
  });

  it("says so when the path never resolved to an absolute one", () => {
    openInEditor({ path: "src/a.ts" }, { diffAgainst: { ref: "@merge-base", label: "Merge base" } });
    expect(errors).toEqual(["Couldn't open the diff against Merge base"]);
  });

  it("says so when no view ever shows the file", async () => {
    openInEditor({ path: `${ROOT}/src/a.ts` }, { diffAgainst: { ref: "HEAD" } });
    expect(await until(() => errors.length > 0, 10_000)).toBe(true);
    expect(errors).toEqual(["Couldn't open the diff against HEAD"]);
  }, 12_000);
});

describe("split", () => {
  it("asks the Files pane already there for a split to the right", async () => {
    openInEditor({ path: `${ROOT}/src/a.ts` });
    const before = filesLeaves()[0].path;
    const calls: unknown[] = [];
    offs.push(registerCodeCommand("file.open", (args) => void calls.push(args)));
    openInEditor({ path: `${ROOT}/src/b.ts`, line: 7, column: 2 }, { split: true });
    expect(await until(() => calls.length > 0)).toBe(true);
    expect(calls[0]).toEqual({ path: `${ROOT}/src/b.ts`, line: 7, column: 2, split: "right" });
    // The pane keeps its file: the split holds the new one.
    expect(filesLeaves()).toHaveLength(1);
    expect(filesLeaves()[0].path).toBe(before);
  });

  it("opens the address in the pane when no handler takes the split", async () => {
    openInEditor({ path: `${ROOT}/src/a.ts` });
    openInEditor({ path: `${ROOT}/src/b.ts`, line: 7 }, { split: true });
    const want = `/files?path=${encodeURIComponent(`${ROOT}/src/b.ts`)}&l=7`;
    expect(await until(() => filesLeaves()[0].path === want, 6000)).toBe(true);
    expect(filesLeaves()).toHaveLength(1);
  }, 8000);

  it("with no Files pane on stage, opens one beside instead of a split", () => {
    openInEditor({ path: `${ROOT}/src/b.ts`, line: 7 }, { split: true });
    expect(filesLeaves()).toHaveLength(1);
    expect(filesLeaves()[0].path).toContain("b.ts");
  });
});
