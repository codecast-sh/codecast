// The git feature as the editor core registers it: a tracked file opened in a
// real EditorHost gets its gutter from the daemon's status and HEAD text, an
// untracked one gets none, a moved HEAD rereads the base, the commands act on
// the editor, and the status bar shows the branch.
import { expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const HEAD_TEXT = "one\ntwo\nthree\n";
let head = "aaa";
let baseText = HEAD_TEXT;
const calls = { status: 0, base: 0 };

const { VaultRequestError } = await import("../../../vault/client");
const realClient = { ...(await import("../../daemonClient")) };
mock.module("../../daemonClient", () => ({
  ...realClient,
  fetchGitStatus: async () => {
    calls.status++;
    return { repo: true, branch: "main", head, ahead: 2, behind: 1, files: { "src/a.ts": "modified", "src/new.ts": "untracked" } };
  },
  fetchGitBase: async (_ep: unknown, _v: string, path: string, ref?: string) => {
    calls.base++;
    // The daemon's two answers for "nothing to compare": an unknown ref is a
    // 404, a file missing at a real ref is 200 with exists:false.
    if (ref === "nope") throw new VaultRequestError("git base: 404 unknown ref", 404);
    if (ref === "gone") return { path, ref, exists: false };
    return { path, ref: ref ?? "HEAD", exists: true, content: baseText };
  },
}));

const { useVaultStore } = await import("../../../../store/vaultStore");
const { EditorHost, openCodeBuffer } = await import("../../editorHost");
const { runCodeCommand } = await import("../../commands");
const { refreshGitStatus } = await import("../status");
const git = await import("../gutter");
const kit = await import("@codemirror/merge");

useVaultStore.setState({ activeVaultId: "v1", isRemote: false, endpoint: { url: "http://127.0.0.1:1", token: "t" } as any });

const parent = document.createElement("div");
document.body.append(parent);
const host = new EditorHost(parent, []);

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}: base calls ${calls.base}, marks ${JSON.stringify(git.gitLineMarks(host.view.state))}, doc ${JSON.stringify(host.view.state.doc.toString())}`);
};

test("a tracked file gets its gutter and the branch shows in the status bar", async () => {
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/a.ts", content: "one\nTWO\nthree\nfour\n", etag: "e1", readOnly: false });
  host.show(buffer);
  await until(() => git.hasGitGutter(host.view.state), "the git feature");
  expect(git.gitLineMarks(host.view.state)).toEqual([
    { line: 2, kind: "modified" },
    { line: 4, kind: "added" },
  ]);
  await until(() => host.view.dom.querySelector(".cm-git-branch")?.textContent === "main ↑2 ↓1", "the branch chip");
});

test("a command named without an editor (the palette) acts on the one the person was in", () => {
  const view = host.view;
  view.dispatch({ selection: { anchor: 0 } });
  expect(runCodeCommand("git.nextHunk", undefined, { source: "palette" })).toBe(true);
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
});

test("the commands act on the editor", () => {
  const view = host.view;
  view.dispatch({ selection: { anchor: 0 } });
  expect(runCodeCommand("git.nextHunk", undefined, { view, source: "vim" })).toBe(true);
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
  expect(runCodeCommand("git.peekHunk", undefined, { view, source: "vim" })).toBe(true);
  expect(view.dom.querySelector(".cm-git-peek-old")?.textContent).toBe("two");
  expect(runCodeCommand("git.revertHunk", undefined, { view, source: "vim" })).toBe(true);
  expect(view.state.doc.toString()).toBe("one\ntwo\nthree\nfour\n");
  expect(runCodeCommand("git.diffHead", undefined, { view, source: "vim" })).toBe(true);
  expect(git.gitDiffState(view.state)?.ref).toBe("HEAD");
  expect(runCodeCommand("git.diffHead", undefined, { view, source: "vim" })).toBe(true);
  expect(git.gitDiffState(view.state)).toBeNull();
});

test("typing writes no store and fetches nothing", async () => {
  const { useCodeStore } = await import("../../../../store/codeStore");
  const { useGitStatusStore } = await import("../status");
  const view = host.view;
  view.dispatch({ changes: { from: 0, insert: "x" } }); // the clean-to-dirty transition is chrome's
  await settle();
  let writes = 0;
  const offs = [useVaultStore, useCodeStore, useGitStatusStore].map((st) => (st as any).subscribe(() => writes++));
  const before = { ...calls };
  for (let i = 0; i < 20; i++) view.dispatch({ changes: { from: view.state.doc.length, insert: "y" }, userEvent: "input.type" });
  offs.forEach((off: () => void) => off());
  expect(writes).toBe(0);
  expect(calls).toEqual(before);
  view.dispatch({ changes: { from: 0, to: 1 } });
  view.dispatch({ changes: { from: view.state.doc.length - 20, to: view.state.doc.length } });
});

test("an untracked file gets no gutter", async () => {
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/new.ts", content: "x\n", etag: "e2", readOnly: false });
  host.show(buffer);
  await settle();
  await settle();
  expect(git.hasGitGutter(host.view.state)).toBe(false);
  expect(runCodeCommand("git.nextHunk", undefined, { view: host.view, source: "vim" })).toBe(false);
});

test("a moved HEAD rereads the base", async () => {
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/a.ts", content: "", etag: "e1", readOnly: false });
  host.show(buffer);
  await until(() => git.hasGitGutter(host.view.state), "the gutter again");
  // Against the first HEAD the buffer has an added fourth line.
  expect(git.gitLineMarks(host.view.state)).toEqual([{ line: 4, kind: "added" }]);
  let before = calls.base;
  // The buffer, committed: HEAD now holds its text, so the gutter clears.
  baseText = host.view.state.doc.toString();
  head = "bbb";
  await refreshGitStatus("v1");
  await until(() => calls.base > before && git.gitLineMarks(host.view.state).length === 0, "the gutter against the new base");

  // An open diff reopens against the next base, not the one it was opened on.
  git.openGitDiff(host.view, { ref: "HEAD" }, "unified");
  expect(kit.getChunks(host.view.state)?.chunks.length).toBe(0);
  before = calls.base;
  baseText = HEAD_TEXT;
  head = "ccc";
  await refreshGitStatus("v1");
  await until(() => calls.base > before && kit.getChunks(host.view.state)?.chunks.length === 1, "the diff to reopen against the new base");
  expect(git.gitDiffState(host.view.state)?.ref).toBe("HEAD");
  git.closeGitDiff(host.view);
  expect(kit.getChunks(host.view.state)).toBeNull();
  expect(git.gitLineMarks(host.view.state)).toEqual([{ line: 4, kind: "added" }]);
});

test("an unknown ref shows as not found, a file missing at a real ref as all new", async () => {
  const buffer = openCodeBuffer({ vaultId: "v1", path: "src/a.ts", content: "one\nTWO\n", etag: "e1", readOnly: false });
  host.show(buffer);
  await until(() => git.hasGitGutter(host.view.state), "the gutter");
  const count = () => host.view.dom.querySelector(".cm-git-count");

  git.openGitDiff(host.view, { ref: "nope" }, "unified");
  await until(() => count()?.textContent === "Ref not found", "the not-found state");
  expect(count()?.classList.contains("cm-git-error")).toBe(true);
  expect(kit.getChunks(host.view.state)).toBeNull();

  git.openGitDiff(host.view, { ref: "gone" }, "unified");
  await until(() => kit.getChunks(host.view.state)?.chunks.length === 1, "the diff against nothing");
  expect(count()?.textContent).toBe("1 change");
  git.closeGitDiff(host.view);
});
