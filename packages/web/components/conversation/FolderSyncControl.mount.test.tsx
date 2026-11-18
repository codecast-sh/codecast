// Mounts FolderSyncControl against a real zustand store whose user has never
// set sync_projects / sync_excluded (most accounts): the selector must hand
// back a snapshot that compares equal to itself, or React re-renders until it
// throws "Maximum update depth exceeded" (#185) and takes the new-session
// ProjectSwitcher down with it.
// Run: bun test packages/web/components/conversation/FolderSyncControl.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
restoreInboxStoreAfterAll();

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const { create } = await import("zustand");
const store = create(() => ({ currentUser: { _id: "user-me", sync_mode: "selected" } as Record<string, unknown> }));
mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore: store }));
const { createRoot } = await import("react-dom/client");
const { FolderSyncControl } = await import("./FolderSyncControl");

test("a user with no sync lists renders the notice without an update loop", async () => {
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args[0]); };
  try {
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => root.render(React.createElement(FolderSyncControl, { folder: "/Users/me/src/app" })));
    expect(document.body.textContent).toContain("app isn't synced");
    // A store write that leaves the sync fields alone must not loop either.
    await React.act(async () => store.setState({ currentUser: { ...store.getState().currentUser, name: "Me" } }));
    expect(document.body.textContent).toContain("app isn't synced");
    await React.act(async () => root.unmount());
  } finally {
    console.error = origError;
  }
  expect(errors.map(String).filter((e) => /Maximum update depth|getSnapshot should be cached/.test(e))).toEqual([]);
});
