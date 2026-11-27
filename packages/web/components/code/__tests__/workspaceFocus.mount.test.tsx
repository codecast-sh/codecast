// Focus never falls to <body> when what held it in the workspace goes away:
// closing the only tab, or Escape on a dialog over an empty group. On <body>
// the next Cmd-W would close the app tab instead of an editor tab.
import { expect, mock, test } from "bun:test";
import { installEditorDom, settle } from "./editorDom";

installEditorDom();
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
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../../store/vaultStore");
const { useCodeStore } = await import("../../../store/codeStore");
const { codeBuffers } = await import("../../../lib/code/buffers");
const { workspaceActions } = await import("../../../lib/code/workspace/controller");
const { emptyWorkspace, openTab } = await import("../../../lib/code/workspace/model");
const { runCodeCommand } = await import("../../../lib/code/commands");
const { CodeWorkspace } = await import("../workspace/CodeWorkspace");
await import("../CodeFileView");

const VAULT = "vault-ws-focus";
for (const old of codeBuffers.all()) codeBuffers.close(old.key);
const a = "export const a = 1;\n";
useVaultStore.setState({
  activeVaultId: VAULT,
  isRemote: false,
  files: { "src/a.ts": { path: "src/a.ts", mtime: 1, size: a.length } } as any,
  bodies: { "src/a.ts": { content: a, mtime: 1, etag: "e1" } },
});
useCodeStore.setState({ dirty: {}, conflicts: {}, workspaces: { [VAULT]: openTab(emptyWorkspace(), "src/a.ts") } });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const inWorkspace = () => !!document.activeElement?.closest("[data-code-workspace]");

test("closing the only tab keeps focus in the workspace", async () => {
  await act(async () => {
    root.render(
      <CodeWorkspace vaultId={VAULT} vaultRoot="/tmp/repo" urlPath="src/a.ts" urlLine={null} treeOpen onNavigate={() => {}} onToggleTree={() => {}} renderNote={() => null} />,
    );
    await settle();
  });
  const content = host.querySelector<HTMLElement>(".cm-content")!;
  content.focus();
  expect(inWorkspace()).toBe(true);
  await act(async () => {
    workspaceActions.close(VAULT, "g1", "src/a.ts");
    await settle();
    await frame();
  });
  expect(host.querySelector(".cm-editor")).toBeNull();
  expect(document.activeElement?.hasAttribute("data-group-body")).toBe(true);
});

test("Escape on quick open over an empty group returns focus to the group", async () => {
  await act(async () => {
    runCodeCommand("quickOpen");
    await settle();
    await frame();
  });
  const input = host.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  input.focus();
  expect(document.activeElement).toBe(input);
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    await frame();
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(inWorkspace()).toBe(true);
});

test("focus moved out by the person stays out", async () => {
  await act(async () => {
    workspaceActions.open(VAULT, "src/a.ts");
    await settle();
  });
  host.querySelector<HTMLElement>(".cm-content")!.focus();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  outside.blur(); // then a click on nothing: <body>, by choice
  await act(async () => {
    await settle();
    workspaceActions.close(VAULT, "g1", "src/a.ts");
    await settle();
    await frame();
  });
  expect(document.activeElement).toBe(document.body);
  await act(async () => root.unmount());
});

test("tabs are named with their state, walk by arrows, close by Delete, and the menu's verbs are commands", async () => {
  const b = "export const b = 2;\n";
  useVaultStore.setState({
    files: { ...useVaultStore.getState().files, "src/b.ts": { path: "src/b.ts", mtime: 1, size: b.length } } as any,
    bodies: { ...useVaultStore.getState().bodies, "src/b.ts": { content: b, mtime: 1, etag: "e2" } },
  });
  useCodeStore.setState({ workspaces: { [VAULT]: openTab(openTab(emptyWorkspace(), "src/a.ts"), "src/b.ts", { preview: true }) } });
  const again = createRoot(host);
  await act(async () => {
    again.render(
      <CodeWorkspace vaultId={VAULT} vaultRoot="/tmp/repo" urlPath="src/b.ts" urlLine={null} treeOpen onNavigate={() => {}} onToggleTree={() => {}} renderNote={() => null} />,
    );
    await settle();
  });
  const tabs = () => [...host.querySelectorAll<HTMLElement>("[role=tab]")];
  expect(host.querySelector("[role=tablist]")!.getAttribute("aria-label")).toBe("Editor tabs");
  expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["a.ts", "b.ts, preview"]);
  // One Tab stop, on the active tab, which controls the group's panel.
  expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
  expect(document.getElementById(tabs()[1].getAttribute("aria-controls")!)?.getAttribute("role")).toBe("tabpanel");

  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  tabs()[1].focus();
  await act(async () => void key(tabs()[1], "ArrowLeft"));
  expect(document.activeElement).toBe(tabs()[0]);

  // The menu's Pin runs tabs.pin; with no tab named, the active tab.
  await act(async () => {
    runCodeCommand("tabs.pin");
    await settle();
  });
  expect(useCodeStore.getState().workspaces[VAULT].groups[0].tabs.find((t) => t.path === "src/b.ts")?.pinned).toBe(true);

  const a = tabs().find((t) => t.dataset.tabPath === "src/a.ts")!;
  a.focus();
  await act(async () => {
    key(a, "Delete");
    await settle();
    await frame();
  });
  expect(useCodeStore.getState().workspaces[VAULT].groups[0].tabs.map((t) => t.path)).toEqual(["src/b.ts"]);
  expect(inWorkspace()).toBe(true);
  await act(async () => again.unmount());
});
