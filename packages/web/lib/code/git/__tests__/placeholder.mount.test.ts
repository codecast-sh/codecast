// The git gutter's stand-in column before and after the first status: a file
// with nothing at HEAD (untracked, added, ignored) never reserves it, so the
// text does not shift back a moment later. The last status's list of such
// files is kept across reloads for the boot before any status lands.
import { expect, mock, test } from "bun:test";
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

localStorage.setItem("codecast.code.gitNoHead.v1", JSON.stringify(["src/was-new.ts"]));

const realClient = { ...(await import("../../daemonClient")) };
mock.module("../../daemonClient", () => ({
  ...realClient,
  fetchGitStatus: async () => ({ repo: true, branch: "main", head: "aaa", files: { "src/a.ts": "modified", "src/new.ts": "untracked", "src/staged.ts": "added" } }),
}));

const { useVaultStore } = await import("../../../../store/vaultStore");
const { gitPlaceholder } = await import("../index");
const { lastNoHeadPaths, refreshGitStatus } = await import("../status");
const { gitGutterStandIn } = await import("../../gutterSlots");

const ctx = (path: string) => ({ vaultId: "v1", path, languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false });

useVaultStore.setState({
  activeVaultId: "v1",
  isRemote: false,
  isRepo: true,
  endpoint: { url: "http://127.0.0.1:1", token: "t" } as never,
  files: { "dist/out.js": { path: "dist/out.js", mtime: 1, size: 1, ignored: true } },
});

test("before the first status: held for a tracked file, not for one last seen untracked or one ignored", () => {
  expect(gitPlaceholder(ctx("src/a.ts"))).toBe(gitGutterStandIn);
  expect(gitPlaceholder(ctx("src/was-new.ts"))).toBeNull();
  expect(gitPlaceholder(ctx("dist/out.js"))).toBeNull();
});

test("a status replaces the remembered list, and decides the stand-in from then on", async () => {
  await refreshGitStatus("v1");
  expect([...(lastNoHeadPaths("v1") ?? [])]).toEqual(["src/new.ts", "src/staged.ts"]);
  expect(JSON.parse(localStorage.getItem("codecast.code.gitNoHead.v1")!)).toEqual(["src/new.ts", "src/staged.ts"]);
  expect(gitPlaceholder(ctx("src/a.ts"))).toBe(gitGutterStandIn);
  expect(gitPlaceholder(ctx("src/was-new.ts"))).toBe(gitGutterStandIn);
  expect(gitPlaceholder(ctx("src/new.ts"))).toBeNull();
  expect(gitPlaceholder(ctx("dist/out.js"))).toBeNull();
});
