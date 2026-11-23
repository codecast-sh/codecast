// The Closed group, mounted over a seeded store: a closed session keeps its
// armed triggers, and they show under its card the way triggers show under
// every card in the sidebar (CardBars). A killed session had them canceled,
// so nothing shows under it.
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
const CLOSED = id("closed");
const KILLED = id("killed");

const row = (_id: string, title: string) => ({
  _id, title, session_id: `s-${_id.slice(0, 6)}`, user_id: "me", owned_by_me: true, status: "active",
  started_at: NOW - 3_600_000, updated_at: NOW - 60_000, last_heartbeat: NOW - 1_000, message_count: 12,
  is_idle: true, agent_status: "idle", project_path: "/src/project",
  inbox_dismissed_at: NOW - 30_000,
});
const task = (_id: string, conv: string, status: string) => ({
  _id, title: `Check CI for ${conv.slice(0, 6)}`, prompt: "check CI", status, schedule_type: "recurring", mode: "apply",
  run_at: NOW + 3_600_000, created_at: NOW - 3_600_000, originating_conversation_id: conv,
});

function seed() {
  __resetInboxPlacementCacheForTests();
  useInboxStore.setState({
    // A close stamps only inbox_dismissed_at; a kill also stamps the retirement marker and completes it.
    sessions: { [CLOSED]: row(CLOSED, "Closed with a trigger"), [KILLED]: { ...row(KILLED, "Killed, trigger canceled"), inbox_killed_at: NOW - 30_000, status: "completed" } },
    conversations: {},
    pending: {},
    pendingMessages: {},
    sessionDecisions: {},
    // A kill cancels the trigger (completed, stamped); a close keeps it armed.
    agentTasks: { t1: task("t1", CLOSED, "scheduled"), t2: { ...task("t2", KILLED, "completed"), canceled_on_kill_at: NOW - 30_000 } },
    currentUser: { _id: "me", name: "Ashot" },
    clientState: { ui: { inbox_scope: "mine", show_old: true, card_bars: "full" } },
  } as any);
}

async function mountInbox() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter initialEntries={["/inbox"]}><SessionListPanel activeSessionId={null} /></MemoryRouter>));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

// The block a hidden bucket draws per card: the card and the bars under it.
const blockOf = (host: HTMLElement, sessionId: string) => host.querySelector(`[data-session-id="${sessionId}"]`)?.closest(".border-b") as HTMLElement | null;

beforeEach(() => { document.body.innerHTML = ""; seed(); });

test("in the Closed group a closed card shows its armed trigger under it, and a killed card shows none", async () => {
  const m = await mountInbox();
  const head = [...m.host.querySelectorAll("[data-sv-hidden-label]")].find((el) => el.textContent?.startsWith("Closed"));
  expect(head?.textContent).toBe("Closed (2)");
  await act(async () => { (head!.closest("button") as HTMLButtonElement).click(); });

  const closed = blockOf(m.host, CLOSED)!;
  const killed = blockOf(m.host, KILLED)!;
  expect(closed).not.toBeNull();
  expect(killed).not.toBeNull();
  expect(closed).not.toBe(killed);
  expect(closed.querySelector('[data-schedrow="t1"]')).not.toBeNull();
  expect(killed.querySelector("[data-schedrow]")).toBeNull();
  await m.unmount();
});
