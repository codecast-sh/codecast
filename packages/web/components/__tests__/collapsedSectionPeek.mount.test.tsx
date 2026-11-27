// Opening a session that sits in a collapsed section leaves the section
// collapsed: its card peeks out under the header, alone, and goes back into
// the closed section once another session opens.
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  FocusEvent: dom.window.FocusEvent,
  MouseEvent: dom.window.MouseEvent,
  PointerEvent: dom.window.MouseEvent,
  DocumentFragment: dom.window.DocumentFragment,
  NodeFilter: dom.window.NodeFilter,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
  useConvex: () => ({ query: async () => null, mutation: async () => null }),
}));
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
const { useInboxStore, __resetInboxPlacementCacheForTests } = await import("../../store/inboxStore");
const { SessionListPanel } = await import("../GlobalSessionPanel");

const NOW = Date.now();
const id = (tag: string) => tag.padEnd(32, "0");
const A = id("alpha");
const B = id("bravo");

const row = (_id: string, title: string) => ({
  _id, title, session_id: `s-${_id.slice(0, 6)}`, user_id: "me", owned_by_me: true, status: "active",
  started_at: NOW - 3_600_000, updated_at: NOW - 60_000, last_heartbeat: NOW - 1_000, message_count: 12,
  is_idle: true, agent_status: "idle", project_path: "/src/project",
});

// Every status section collapsed, so whichever one files the two sessions is closed.
const ALL_COLLAPSED = { questions: true, pinned: true, new: true, needs_input: true, done: true, working: true, dormant: true, stopped: true };

beforeEach(() => {
  document.body.innerHTML = "";
  __resetInboxPlacementCacheForTests();
  useInboxStore.setState({
    sessions: { [A]: row(A, "Alpha"), [B]: row(B, "Bravo") },
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    agentTasks: {},
    collapsedSections: { ...ALL_COLLAPSED },
    currentUser: { _id: "me", name: "Ashot" },
    clientState: { ui: { inbox_scope: "mine", show_old: true } },
  } as any);
});

const cardOf = (host: HTMLElement, sessionId: string) => host.querySelector(`[data-session-id="${sessionId}"]`);
const peekRowOf = (host: HTMLElement, sessionId: string) => cardOf(host, sessionId)?.closest(".inbox-peek") ?? null;

test("the open session peeks out of its collapsed section, which stays collapsed", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (active: string | null) => act(async () => root.render(
    <MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={active} /></MemoryRouter>,
  ));

  await render(null);
  expect(cardOf(host, A)).toBeNull();
  expect(cardOf(host, B)).toBeNull();

  await render(A);
  expect(peekRowOf(host, A)).not.toBeNull();
  expect(cardOf(host, B)).toBeNull();
  expect(useInboxStore.getState().collapsedSections).toEqual(ALL_COLLAPSED);

  await render(B);
  expect(cardOf(host, A)).toBeNull();
  expect(peekRowOf(host, B)).not.toBeNull();

  await render(null);
  expect(cardOf(host, A)).toBeNull();
  expect(cardOf(host, B)).toBeNull();
  expect(useInboxStore.getState().collapsedSections).toEqual(ALL_COLLAPSED);

  await act(async () => root.unmount());
  host.remove();
});

test("an open section draws its cards without the peek mark", async () => {
  useInboxStore.setState({ collapsedSections: {} } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={A} /></MemoryRouter>));
  expect(cardOf(host, A)).not.toBeNull();
  expect(cardOf(host, B)).not.toBeNull();
  expect(host.querySelector(".inbox-peek")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
