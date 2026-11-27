import { afterAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// A pull request review thread's Edit opens its lines in this machine's
// worktree on the head branch. Only there: a checkout on another branch has
// different lines at those numbers, so the thread carries no Edit.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let worktrees: Array<{ path: string; branch?: string; main?: boolean }> = [];
mock.module("../../../hooks/useRepoBrowse", () => ({
  useRepoWorktrees: () => ({ data: { checkouts: [{ root: "/src/app", device_id: "dev-1", worktrees }] } }),
}));
mock.module("../../OpenInEditorButton", () => ({
  OpenInEditorButton: ({ target }: { target: { path: string; line?: number } }) => <span data-target={`${target.path}:${target.line}`} />,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useLocalEditAt } = await import("../../../hooks/useLocalEdit");
const { useInboxStore } = await import("../../../store/inboxStore");
useInboxStore.setState({ localDevice: { viewer: "u1", deviceId: "dev-1" }, currentUser: { _id: "u1" } } as never);

function Thread() {
  const editAt = useLocalEditAt("ada/app", "feature");
  return <div>{editAt ? editAt("lib/x.ts", 12) : "none"}</div>;
}

async function render() {
  const host = dom.window.document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Thread />));
  const out = host.querySelector("[data-target]")?.getAttribute("data-target") ?? host.textContent;
  await act(async () => root.unmount());
  return out;
}

describe("review thread Edit", () => {
  test("opens the line in the worktree on the head branch", async () => {
    worktrees = [{ path: "/src/app", branch: "main", main: true }, { path: "/src/app-feature", branch: "feature" }];
    expect(await render()).toBe("/src/app-feature/lib/x.ts:12");
  });

  test("no worktree on the head branch, no Edit", async () => {
    worktrees = [{ path: "/src/app", branch: "main", main: true }];
    expect(await render()).toBe("none");
  });
});
