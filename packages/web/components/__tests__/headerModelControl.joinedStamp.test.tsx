// ct-101396: agents that record model and effort joined into one id
// (antigravity: `--model gemini-4-carbon --effort medium` lands as
// `gemini-4-carbon-medium`) must have their session model control named by the
// catalog's model name, and an effort-only pick must not leave the old effort
// in the label.
//
// Run: bun test --timeout 120000 components/__tests__/headerModelControl.joinedStamp.test.tsx
import { test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "./mockInboxStore";

restoreInboxStoreAfterAll();

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("../SessionControlMenu");

const SESSION = "11111111-2222-4333-8444-555555555555";
let liveMeta: Record<string, unknown> | undefined;
const commits: unknown[] = [];

const storeState = {
  sessions: { conv1: { _id: "conv1", title: "Agy session", agent_type: "antigravity", project_path: "/p", git_root: "/p" } } as Record<string, any>,
  conversations: {} as Record<string, any>,
  currentUser: { _id: "u1", default_models: {} },
  clientState: { ui: {} } as Record<string, any>,
  machineRoster: [],
  getConvexId: (id: string) => id,
  requestNavigate() {},
  syncTable() {},
  setConversationModel() {},
  addOptimisticMessage: () => "c1",
  sendMessage() {},
  sessionCommands: {} as Record<string, any>,
  resolveLiveSessionId: () => SESSION,
};

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "DOMRect", "MutationObserver"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!(globalThis as any).PointerEvent) (globalThis as any).PointerEvent = (globalThis as any).MouseEvent;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  const h = React.createElement;

  const useInboxStore = Object.assign((selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState), {
    getState: () => storeState,
    setState() {},
    subscribe: () => () => {},
  });
  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, isConvexId: (id: string) => /^[a-z0-9]{32}$/.test(id) }));
  mock.module("../../store/mutativeMiddleware", () => ({ DispatchNotWiredError: class extends Error { parked = false; }, isParkedDispatchError: () => false }));
  mock.module("convex/react", () => ({ useMutation: () => () => Promise.resolve(), useConvex: () => ({ action: () => Promise.resolve({}) }) }));
  mock.module("../../hooks/useDynamicModels", () => ({ useDynamicModels: () => ({ dynamic: false, featured: [], all: [] }) }));
  mock.module("../../hooks/useLiveSessionMeta", () => ({ useLiveSessionMeta: () => liveMeta, liveSessionMetaOf: () => liveMeta }));
  mock.module("../../hooks/useSyncAgentDefinitions", () => ({ useAgentDefinitions: () => [] }));
  const realSwitchWeb = await import("../../lib/modelSwitchWeb");
  mock.module("../../lib/modelSwitchWeb", () => ({ ...realSwitchWeb, commitModelChange: (args: unknown) => { commits.push(args); return Promise.resolve(); } }));
  mock.module("sonner", () => ({ toast: { success() {}, error() {} } }));
  const realShortcutsHelp = await import("../KeyboardShortcutsHelp");
  mock.module("../KeyboardShortcutsHelp", () => ({ ...realShortcutsHelp, ShortcutTooltip: ({ children }: { children: React.ReactNode }) => h(React.Fragment, null, children), KeyCap: ({ children }: any) => h("kbd", null, children) }));

  ({ createRoot } = await import("react-dom/client"));
  mod = await import("../SessionControlMenu");
}, 120_000);

let root: ReturnType<typeof createRoot> | null = null;
beforeEach(() => { commits.length = 0; liveMeta = undefined; if (root) { React.act(() => root!.unmount()); root = null; } });


function mount(variant: "header" | "composer", props: Record<string, unknown> = {}) {
  const h = React.createElement;
  root = createRoot(document.getElementById("root")!);
  React.act(() => root!.render(h(mod.HeaderModelControl, {
    variant,
    conversationId: "conv1",
    agentType: "antigravity",
    model: "gemini-4-carbon-medium",
    effort: "medium",
    messageCount: 12,
    canEdit: true,
    open: true,
    onOpenChange: () => {},
    ...props,
  } as any)));
  React.act(() => {});
}

const trigger = () => document.querySelector<HTMLElement>("[data-session-control-trigger]")!;
const triggerText = () => (trigger().textContent ?? "").trim();

for (const variant of ["header", "composer"] as const) {
  test(`${variant}: a joined gemini-4-carbon-medium stamp is named "Gemini 4 Carbon"`, () => {
    liveMeta = { sessionId: SESSION, agentType: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" };
    mount(variant);
    expect(trigger()).toBeTruthy();
    expect(triggerText()).toContain("Gemini 4 Carbon");
    expect(triggerText()).not.toContain("gemini-4-carbon-medium");
  });
}

test("passive readout (not the owner) names the model too", () => {
  liveMeta = { sessionId: SESSION, agentType: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" };
  mount("header", { canEdit: false });
  const text = document.getElementById("root")!.textContent ?? "";
  expect(text).toContain("Gemini 4 Carbon");
  expect(text).not.toContain("gemini-4-carbon-medium");
});

test("an effort-only pick of high leaves no 'medium' on the control", () => {
  liveMeta = { sessionId: SESSION, agentType: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" };
  mount("header");
  const high = [...document.querySelectorAll<HTMLElement>("button")].find((b) => (b.textContent ?? "").trim() === "high");
  expect(high).toBeTruthy();
  React.act(() => { high!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); });
  expect(commits.length).toBe(1);
  expect(triggerText()).not.toContain("medium");
  expect(trigger().getAttribute("title") ?? "").not.toContain("medium");
  expect(triggerText()).toContain("Gemini 4 Carbon");
});
