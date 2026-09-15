import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("convex/react", () => ({ useAction: () => () => {} }));
mock.module("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
mock.module("../../repo/RepoWindowControl", () => ({ RepoWindowControl: () => null }));
mock.module("../../comments/CommentAvatar", () => ({ CommentAvatar: () => null }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PRHeader } = await import("../../pr/PRHeader");
const container = document.getElementById("root")!;
const root = createRoot(container);
const changes: Array<[string | undefined, boolean]> = [];
const render = (enabled?: boolean) => act(() => root.render(<PRHeader
  pr={{ title: "Fix test", state: "open", shepherd_conversation_id: "conv_1", shepherd_enabled: enabled }}
  repository="codecast-sh/codecast" number={12} openComments={0}
  sessionChoices={[{ id: "conv_1", title: "Linked session" }]}
  onSetShepherd={(id, on) => changes.push([id, on])}
/>));
const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

try {
  await render();
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  assert.equal(container.querySelector('a[href="/conversation/conv_1"]')?.textContent, "Linked session");
  await act(() => toggle().click());
  assert.deepEqual(changes, [["conv_1", true]]);
  await render(true);
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  await act(() => toggle().click());
  assert.deepEqual(changes, [["conv_1", true], ["conv_1", false]]);
  await render(false);
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  console.log("PR shepherd default, explicit toggle and session link verified");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
