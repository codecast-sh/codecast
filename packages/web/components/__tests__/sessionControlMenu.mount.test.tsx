// The unified session control panel (SessionControlMenu) mounted in jsdom
// inside a forced-open Radix menu: the model rows for the session's agent,
// the switch chips honoring canSessionBecomeAgent (current agent ringed and
// inert, an agent that cannot rebuild history inert with its reason), a fork
// chip that forks and navigates, and the hand-off step showing the chosen
// agent's models, taking a direction, and calling handoff.start.
//
// Run: bun test --timeout 120000 components/__tests__/sessionControlMenu.mount.test.tsx
import { test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "./mockInboxStore";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("../SessionControlMenu");
let menu: typeof import("../ui/dropdown-menu");

const calls = {
  switches: [] as Array<[string, string]>,
  forks: [] as Array<[string, string]>,
  actions: [] as Array<[unknown, Record<string, unknown>]>,
  navigates: [] as string[],
  toasts: [] as Array<[string, string]>,
  reset() { this.switches = []; this.forks = []; this.actions = []; this.navigates = []; this.toasts = []; },
};

const storeState = {
  sessions: { conv1: { _id: "conv1", title: "Fix the auth race", agent_type: "claude_code", project_path: "/p", git_root: "/p" } } as Record<string, any>,
  conversations: {} as Record<string, any>,
  currentUser: { _id: "u1", default_models: {} },
  machineRoster: [],
  getConvexId: (id: string) => id,
  requestNavigate: (id: string) => { calls.navigates.push(id); },
  syncTable() {},
  setConversationModel() {},
  addOptimisticMessage: () => "c1",
  sendMessage() {},
};

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLAnchorElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "DOMRect", "MutationObserver"]) {
    const v = (dom.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true });
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
  mock.module("convex/react", () => ({
    useMutation: () => () => Promise.resolve(),
    useConvex: () => ({ action: (ref: unknown, args: Record<string, unknown>) => { calls.actions.push([ref, args]); return Promise.resolve({ session: { conversation_id: "newconv", short_id: "jx7new1", agent_type: args.agent_type } }); } }),
  }));
  mock.module("../../hooks/useDynamicModels", () => ({ useDynamicModels: () => ({ dynamic: false, featured: [], all: [] }) }));
  mock.module("../../hooks/useLiveSessionMeta", () => ({ useLiveSessionMeta: () => undefined }));
  mock.module("../../hooks/useSyncAgentDefinitions", () => ({ useAgentDefinitions: () => [] }));
  mock.module("../../lib/conversationProcessor", () => ({ formatModel: (m: string) => m }));
  mock.module("../../lib/sessionAgentActions", () => ({
    switchSessionAgent: (row: { _id: string }, t: string) => { calls.switches.push([row._id, t]); return Promise.resolve(); },
    forkSessionAsAgent: (row: { _id: string }, t: string) => { calls.forks.push([row._id, t]); return { sessionId: "fork-stub", ready: Promise.resolve("fork-real") }; },
  }));
  mock.module("sonner", () => ({ toast: { success: (m: string) => calls.toasts.push(["success", m]), error: (m: string) => calls.toasts.push(["error", m]) } }));
  // The chip tooltip is Radix plumbing the assertions never hover; render the chip bare.
  mock.module("../KeyboardShortcutsHelp", () => ({ ShortcutTooltip: ({ children }: { children: React.ReactNode }) => h(React.Fragment, null, children), KeyCap: ({ children }: any) => h("kbd", null, children) }));

  ({ createRoot } = await import("react-dom/client"));
  menu = await import("../ui/dropdown-menu");
  mod = await import("../SessionControlMenu");
}, 120_000);

beforeEach(() => { calls.reset(); if (root) { React.act(() => root!.unmount()); root = null; } });

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element) => React.act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); });
const flush = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: ReturnType<typeof createRoot> | null = null;
function mount(props: Partial<import("../SessionControlMenu").SessionControlPanelProps> = {}) {
  const h = React.createElement;
  const closes: number[] = [];
  const modelPicks: Array<{ model?: string; effort?: string }> = [];
  // A fresh root each time: the panel's step state must not leak between mounts.
  if (root) React.act(() => root!.unmount());
  root = createRoot(document.getElementById("root")!);
  React.act(() => root!.render(
    h(menu.DropdownMenu, { open: true, modal: false },
      h(menu.DropdownMenuTrigger, { asChild: true }, h("button", null, "badge")),
      h(menu.DropdownMenuContent, null,
        h(mod.SessionControlPanel, {
          conversationId: "conv1",
          agentType: "claude_code",
          model: "claude-opus-4-8",
          effort: "high",
          messageCount: 12,
          onModelSelect: (sel) => modelPicks.push(sel),
          onClose: () => closes.push(1),
          ...props,
        }),
      ),
    ),
  ));
  // Radix positions and focuses the content in passive effects; let them settle.
  React.act(() => {});
  return { closes, modelPicks };
}

test("a live claude session: identity line, model rows, effort chips", () => {
  mount();
  const panel = q("[data-session-control-panel]")!;
  expect(panel).toBeTruthy();
  expect(q("[data-session-state]")!.textContent).toContain("Live session");
  const text = panel.textContent ?? "";
  for (const label of ["Model", "Fable", "Opus", "Sonnet", "Haiku", "Effort", "Move this session", "Switch agent", "Fork as", "Hand off to"]) {
    expect(text).toContain(label);
  }
});

test("switch chips honor canSessionBecomeAgent: current ringed and inert, cursor inert with its reason, codex switches", () => {
  mount();
  const chip = (row: string, agent: string) => q(`[data-chip-row="${row}"] [data-agent-chip="${agent}"]`)!;
  const current = chip("Switch agent", "claude_code");
  expect(current.getAttribute("data-current")).toBe("true");
  expect(current.getAttribute("aria-disabled")).toBe("true");
  expect(current.getAttribute("aria-label")).toContain("current agent");
  const cursor = chip("Switch agent", "cursor");
  expect(cursor.getAttribute("aria-disabled")).toBe("true");
  expect(cursor.getAttribute("aria-label")).toContain("can't rebuild this session's 12 messages");
  const codex = chip("Switch agent", "codex");
  expect(codex.getAttribute("aria-disabled")).toBeNull();

  click(cursor);
  expect(calls.switches).toEqual([]);
  click(codex);
  expect(calls.switches).toEqual([["conv1", "codex"]]);
  // The fork row omits the current agent and forks + navigates to the stub.
  expect(q('[data-chip-row="Fork as"] [data-agent-chip="claude_code"]')).toBeNull();
  click(chip("Fork as", "codex"));
  expect(calls.forks).toEqual([["conv1", "codex"]]);
  expect(calls.navigates).toEqual(["fork-stub"]);
});

test("the hand-off step shows the chosen agent's models, takes a direction, and calls handoff.start", async () => {
  const { closes } = mount();
  // Every agent is a hand-off destination, the current one included.
  expect(q('[data-chip-row="Hand off to"] [data-agent-chip="claude_code"]')!.getAttribute("aria-disabled")).toBeNull();
  click(q('[data-chip-row="Hand off to"] [data-agent-chip="codex"]')!);
  const step = q("[data-handoff-step]")!;
  expect(step.getAttribute("data-handoff-step")).toBe("codex");
  const text = step.textContent ?? "";
  expect(text).toContain("Hand off to");
  expect(text).toContain("Codex");
  expect(text).toContain("GPT-6 Astra");
  expect(text).not.toContain("Sonnet");
  expect(text).toContain("Haiku brief");

  // Pick a model: the menu stays open (keepOpen) and the submit names it.
  const row = qa("[data-handoff-step] [role=menuitem]").find((el) => el.textContent?.includes("GPT-5.5") && !el.textContent?.includes("Sol"))!;
  click(row);
  expect(q("[data-handoff-step]")).toBeTruthy();
  expect(q("[data-handoff-submit]")!.textContent).toContain("GPT-5.5");

  const ta = q<HTMLTextAreaElement>("[data-handoff-step] textarea")!;
  expect(ta.placeholder).toContain("do first");
  React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, "Finish the migration test");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  click(q("[data-handoff-submit]")!);
  await flush();
  expect(calls.actions.length).toBe(1);
  expect(calls.actions[0][1]).toEqual({ conversation_id: "conv1", agent_type: "codex", model: "gpt-5.5", effort: undefined, direction: "Finish the migration test" });
  expect(calls.toasts).toEqual([["success", "Handed off to jx7new1 on Codex"]]);
  expect(calls.navigates).toEqual(["newconv"]);
  expect(closes.length).toBe(1);

  // Back returns to the main panel.
  mount();
  click(q('[data-chip-row="Hand off to"] [data-agent-chip="gemini"]')!);
  expect(q("[data-handoff-step]")!.textContent).toContain("launches with its own configured model");
  click(qa("[data-handoff-step] button").find((b) => b.textContent?.trim() === "Back")!);
  expect(q("[data-handoff-step]")).toBeNull();
  expect(q("[data-session-control-panel]")).toBeTruthy();
});

test("a blank session and an agent with no model rail read their state on the identity line", () => {
  mount({ messageCount: 0, model: undefined, effort: undefined });
  expect(q("[data-session-state]")!.textContent).toContain("Blank session");
  // Blank: every switch target is open (nothing to rebuild), the launch rail shows "default" effort.
  expect(q('[data-chip-row="Switch agent"] [data-agent-chip="cursor"]')!.getAttribute("aria-disabled")).toBeNull();
  expect(q("[data-session-control-panel]")!.textContent).toContain("default");

  mount({ agentType: "cursor", model: undefined, effort: undefined });
  expect(q("[data-session-state]")!.textContent).toContain("keeps the model it launched with");
  expect(q("[data-session-control-panel]")!.textContent).not.toContain("Effort");
});
