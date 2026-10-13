// A trial card under a host that already names its problem (For you's reader, a problem's band) opens on its question:
// no second ref and title above it. Standalone it names the problem itself.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../../test-helpers/domGlobals";

setDefaultTimeout(60_000);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh/line", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true, CSS: { escape: (s: string) => s }, MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, DocumentFragment: dom.window.DocumentFragment, NodeFilter: dom.window.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const convexReact = await import("convex/react");
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/line" }));
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}), useMutation: () => async () => undefined, useAction: () => async () => ({ ok: false }), useConvex: () => ({ query: async () => null, mutation: async () => null }) }));
const { createRoot } = await import("react-dom/client");
const { TrialCardPanel } = await import("../TrialCardPanel");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const now = Date.UTC(2026, 9, 13, 12);
const card = {
  _id: "c1", workspace: "user:u1", short_id: "tc-34", project_id: "p1", project_title: "AgentWatch Trial", task_id: "t1", task_short_id: "ct-59539",
  task_title: "Owning a specific mistake is marked wrong", task_status: "open", run_id: "r1", run_status: "running", node_id: "reviewer", kind: "card",
  question: "Publish this change to the judges' prompts?", options: [{ key: "publish", label: "Publish" }], status: "answered", created_at: now - 86_400_000,
} as any;

const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);
const render = async (head?: boolean) => { await act(async () => { root.render(React.createElement(TrialCardPanel, { card, now, head, onProblem() {}, onRun() {} })); }); };

test("under a host that names the problem the card opens on its question, with no second ref or title", async () => {
  await render(false);
  expect(host.querySelector(".ld-head")).toBeNull();
  expect(host.textContent).not.toContain("ct-59539");
  expect(host.querySelector(".ld-question")?.textContent).toBe("Publish this change to the judges' prompts?");
});

test("standalone it names its problem", async () => {
  await render();
  expect(host.querySelector(".ld-head [data-line-trial-problem]")?.textContent).toBe("ct-59539");
});
