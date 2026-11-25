// Contract 1 and 2 of docs/architecture/code-editor.md, held by the workspace
// shell: a workspace with two tabs in one group and the same file split into a
// second group. Typing in either group commits React zero times and writes no
// store after the first clean-to-dirty transition; the two groups show one
// document with one undo history; a tab switch keeps the group's editor view
// (setState, never a new view), and the split's other copy takes over the
// buffer when the first group moves on.
import { expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();
// The split layout measures itself, which jsdom cannot: plain boxes stand in.
const realPanels = { ...(await import("react-resizable-panels")) };
mock.module("react-resizable-panels", () => ({
  ...realPanels,
  Group: ({ children }: { children: unknown }) => children,
  Panel: ({ children }: { children: unknown }) => children,
  Separator: () => null,
}));

const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...realConvex, useConvex: () => ({}) }));

const React = await import("react");
const { act, Profiler } = React;
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { useVaultStore } = await import("../../../store/vaultStore");
const { useCodeStore, bufferKey } = await import("../../../store/codeStore");
const { codeBuffers } = await import("../../../lib/code/buffers");
const { runHistory, _mirrorCount } = await import("../../../lib/code/workspace/splitSync");
const { workspaceActions } = await import("../../../lib/code/workspace/controller");
const { emptyWorkspace, openTab, splitTo, focusGroupId } = await import("../../../lib/code/workspace/model");
const { _reconcileForTests, _settleRenamesForTests } = await import("../../../lib/code/workspace/followFiles");
const { CodeWorkspace } = await import("../workspace/CodeWorkspace");
// The lazy editor chunk, loaded up front so it never resolves outside act().
await import("../CodeFileView");

// Its own vault id, and no buffers or chrome left by another file run in the
// same process (typingContract.mount.test.tsx opens buffers of its own).
const VAULT = "vault-ws-typing";
for (const old of codeBuffers.all()) codeBuffers.close(old.key);
useCodeStore.setState({ dirty: {}, conflicts: {}, workspaces: {} });

const a = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
const b = "export const b = 2;\n";
useVaultStore.setState({
  activeVaultId: VAULT,
  isRemote: false,
  files: {
    "src/add.ts": { path: "src/add.ts", mtime: 1, size: a.length },
    "src/b.ts": { path: "src/b.ts", mtime: 1, size: b.length },
  } as any,
  bodies: { "src/add.ts": { content: a, mtime: 1, etag: "e1" }, "src/b.ts": { content: b, mtime: 1, etag: "e2" } },
});

// g1: add.ts and b.ts (add.ts shown); g2: add.ts again, split right. g1 focused.
let ws = openTab(emptyWorkspace(), "src/b.ts");
ws = openTab(ws, "src/add.ts");
ws = splitTo(ws, "g1", "src/add.ts", "right");
ws = focusGroupId(ws, "g1");
useCodeStore.setState({ workspaces: { [VAULT]: ws } });

const host = document.createElement("div");
host.style.width = "1200px";
host.style.height = "800px";
document.body.append(host);
let commits = 0;
let root = createRoot(host);
const workspace = (
  <Profiler id="ws" onRender={() => commits++}>
    <CodeWorkspace
      vaultId={VAULT}
      vaultRoot="/tmp/repo"
      urlPath="src/add.ts"
      urlLine={null}
      treeOpen
      onNavigate={() => {}}
      onToggleTree={() => {}}
      renderNote={() => null}
    />
  </Profiler>
);

const viewIn = (groupId: string) => {
  const el = host.querySelector(`[data-code-group="${groupId}"] .cm-editor`) as HTMLElement | null;
  return el ? EditorView.findFromDOM(el)! : null;
};
const typeChar = (view: InstanceType<typeof EditorView>, ch: string) => {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: ch }, selection: { anchor: pos + 1 }, userEvent: "input.type" });
};

test("two groups show one document; typing in either costs React nothing", async () => {
  await act(async () => {
    root.render(workspace);
  });
  await act(async () => {
    await settle();
  });

  const left = viewIn("g1")!;
  const right = viewIn("g2")!;
  expect(left).toBeTruthy();
  expect(right).toBeTruthy();
  expect(left).not.toBe(right);
  expect(_mirrorCount()).toBe(1);
  const buffer = codeBuffers.get(bufferKey(VAULT, "src/add.ts"))!;

  let vaultWrites = 0;
  let codeWrites = 0;
  const offVault = useVaultStore.subscribe(() => vaultWrites++);
  const offCode = useCodeStore.subscribe(() => codeWrites++);

  await act(async () => typeChar(left, "/"));
  expect(codeWrites).toBe(1); // clean -> dirty
  const commitsAfterFirst = commits;
  const codeAfterFirst = codeWrites;

  await act(async () => {
    for (let i = 0; i < 25; i++) typeChar(left, String.fromCharCode(97 + (i % 26)));
    for (let i = 0; i < 24; i++) typeChar(right, String.fromCharCode(65 + (i % 26)));
  });

  expect(commits - commitsAfterFirst).toBe(0);
  expect(codeWrites - codeAfterFirst).toBe(0);
  expect(vaultWrites).toBe(0);
  // One document, both views.
  expect(right.state.doc.toString()).toBe(left.state.doc.toString());
  expect(buffer.view).toBe(left);
  expect(left.state.doc.length).toBe(a.length + 50);

  // One history: undo from the split undoes in both, everything typed in either.
  await act(async () => {
    while (runHistory(right, "undo")) {}
  });
  expect(left.state.doc.toString()).toBe(a);
  expect(right.state.doc.toString()).toBe(a);
  offVault();
  offCode();
});

test("a tab switch keeps the view; the split takes over the buffer", async () => {
  const left = viewIn("g1")!;
  const right = viewIn("g2")!;
  await act(async () => {
    workspaceActions.activate(VAULT, "g1", "src/b.ts");
    await settle();
  });
  expect(viewIn("g1")).toBe(left);
  expect(left.state.doc.toString()).toBe(b);
  const buffer = codeBuffers.get(bufferKey(VAULT, "src/add.ts"))!;
  expect(buffer.view).toBe(right);
  expect(_mirrorCount()).toBe(0);

  // The promoted view keeps the undo history it now owns.
  const commitsBefore = commits;
  await act(async () => typeChar(right, "x"));
  await act(async () => {
    for (let i = 0; i < 10; i++) typeChar(right, "y");
  });
  const dirtyCommits = commits - commitsBefore;
  await act(async () => {
    for (let i = 0; i < 10; i++) typeChar(right, "z");
  });
  expect(commits - commitsBefore).toBe(dirtyCommits);
  await act(async () => {
    while (runHistory(right, "undo")) {}
  });
  expect(right.state.doc.toString()).toBe(a);
  await act(async () => root.unmount());
  expect(_mirrorCount()).toBe(0);
});

test("a rename moves the tab and its unsaved edits to the new path", async () => {
  useCodeStore.setState({ workspaces: { [VAULT]: openTab(emptyWorkspace(), "src/add.ts") } });
  root = createRoot(host);
  await act(async () => {
    root.render(workspace);
    await settle();
  });
  const view = viewIn("g1")!;
  await act(async () => typeChar(view, "!"));
  const edited = view.state.doc.toString();
  expect(useCodeStore.getState().dirty[bufferKey(VAULT, "src/add.ts")]).toBe(true);

  const before = useVaultStore.getState().files;
  const { "src/add.ts": moved, ...rest } = before as Record<string, any>;
  const files = { ...rest, "src/sum.ts": { ...moved, path: "src/sum.ts" } };
  await act(async () => {
    useVaultStore.setState({ files, bodies: { ...useVaultStore.getState().bodies, "src/sum.ts": { content: a, mtime: 2, etag: "e3" } } });
    _reconcileForTests(VAULT, files, before, false, (p) => (p === "src/add.ts" ? "src/sum.ts" : null));
    await settle();
  });

  const w = useCodeStore.getState().workspaces[VAULT];
  expect(w.groups[0].tabs.map((t) => t.path)).toEqual(["src/sum.ts"]);
  expect(viewIn("g1")).toBe(view);
  expect(view.state.doc.toString()).toBe(edited);
  expect(useCodeStore.getState().dirty[bufferKey(VAULT, "src/sum.ts")]).toBe(true);
  // The old path goes once the daemon's answer is final.
  await act(async () => _settleRenamesForTests());
  expect(useCodeStore.getState().dirty[bufferKey(VAULT, "src/add.ts")]).toBeFalsy();
  expect(codeBuffers.get(bufferKey(VAULT, "src/add.ts"))).toBeUndefined();
  await act(async () => root.unmount());
});

test("disk news for the file a switch left goes to that file, never the one now shown", async () => {
  // Frames run only when the test paints, so no earlier switch's frame can
  // commit the one under test.
  const realRaf = globalThis.requestAnimationFrame;
  const frames: Array<() => void> = [];
  const paint = async () => {
    for (const cb of frames.splice(0)) cb();
    await settle();
  };
  globalThis.requestAnimationFrame = ((cb: () => void) => frames.push(cb)) as unknown as typeof requestAnimationFrame;
  // The rename test moved add.ts away: start from both files on disk again.
  for (const old of codeBuffers.all()) codeBuffers.close(old.key);
  useVaultStore.setState({
    files: {
      "src/add.ts": { path: "src/add.ts", mtime: 1, size: a.length },
      "src/b.ts": { path: "src/b.ts", mtime: 1, size: b.length },
    } as any,
    bodies: { "src/add.ts": { content: a, mtime: 1, etag: "e1" }, "src/b.ts": { content: b, mtime: 1, etag: "e2" } },
  });
  let ws = openTab(emptyWorkspace(), "src/b.ts");
  ws = openTab(ws, "src/add.ts");
  useCodeStore.setState({ workspaces: { [VAULT]: ws }, conflicts: {} });
  root = createRoot(host);
  await act(async () => {
    root.render(workspace);
    await settle();
  });
  // Both buffers open, so the switch is the synchronous kind.
  await act(async () => {
    workspaceActions.activate(VAULT, "g1", "src/b.ts");
    await paint();
  });
  await act(async () => {
    workspaceActions.activate(VAULT, "g1", "src/add.ts");
    await paint();
  });
  const view = viewIn("g1")!;
  const bBuffer = codeBuffers.get(bufferKey(VAULT, "src/b.ts"))!;
  const bText = bBuffer.view ? bBuffer.view.state.doc.toString() : bBuffer.state.doc.toString();
  const bEtag = bBuffer.baseEtag;

  try {
    await act(async () => workspaceActions.activate(VAULT, "g1", "src/b.ts"));
    // Shown at once; the store (and CodeFileView's path) still says add.ts.
    expect(view.state.doc.toString()).toBe(bText);
    expect(useCodeStore.getState().workspaces[VAULT].groups[0].active).toBe("src/add.ts");

    const changed = "export const changed = true;\n";
    await act(async () => {
      useVaultStore.setState((s) => ({ bodies: { ...s.bodies, "src/add.ts": { content: changed, mtime: 9, etag: "e-changed" } } }));
      await settle();
    });
    expect(view.state.doc.toString()).toBe(bText);
    expect(bBuffer.baseEtag).toBe(bEtag);
    expect(bBuffer.stale).toBeFalsy();
    expect(useCodeStore.getState().conflicts[bufferKey(VAULT, "src/b.ts")]).toBeFalsy();
    // add.ts, clean, took its own new version (after the merge code loads).
    const addBuffer = codeBuffers.get(bufferKey(VAULT, "src/add.ts"))!;
    for (let i = 0; i < 100 && addBuffer.baseEtag !== "e-changed"; i++) await act(settle);
    expect(addBuffer.baseEtag).toBe("e-changed");
    expect(addBuffer.state.doc.toString()).toBe(changed);
  } finally {
    await act(paint);
    globalThis.requestAnimationFrame = realRaf;
  }
  expect(useCodeStore.getState().workspaces[VAULT].groups[0].active).toBe("src/b.ts");
  expect(view.state.doc.toString()).toBe(bText);
  await act(async () => root.unmount());
});

test("file.open places an absolute path under the root and refuses one outside it", async () => {
  const { runCodeCommand } = await import("../../../lib/code/commands");
  useCodeStore.setState({ workspaces: { [VAULT]: openTab(emptyWorkspace(), "src/add.ts") } });
  root = createRoot(host);
  await act(async () => {
    root.render(workspace);
    await settle();
  });
  const view = viewIn("g1")!;
  const ctx = { view, source: "vim" as const };
  const tabs = () => useCodeStore.getState().workspaces[VAULT].groups.flatMap((g) => g.tabs.map((t) => t.path));
  await act(async () => {
    expect(runCodeCommand("file.open", { path: "/tmp/repo/src/b.ts" }, ctx)).toBe(true);
    await settle();
  });
  expect(tabs()).toContain("src/b.ts");
  for (const path of ["/tmp/other/x.ts", "/tmp/repository/x.ts", "~/x.ts", "../x.ts"]) {
    expect(runCodeCommand("file.open", { path }, ctx)).toBe(false);
  }
  expect(tabs().some((p) => p.includes("tmp") || p.includes("~") || p.includes(".."))).toBe(false);
  await act(async () => root.unmount());
});
