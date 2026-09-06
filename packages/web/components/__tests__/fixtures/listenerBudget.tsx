// Listener budget: how many store subscriptions each always-mounted surface
// costs at 100 sessions (ct-49548).
//
// Zustand visits every subscriber on every committed write, and each visit runs
// that subscriber's selector. A surface that subscribes per row therefore pays
// O(rows) work on every heartbeat, forever — the failure that pegged the idle
// main thread at ~70% before the sidebar got its wake signature. The count is
// the cheap, stable proxy for that cost, so it is pinned here.
//
// THE PINS MAY ONLY GO DOWN. A change that raises one is adding per-row
// subscriptions to an always-mounted surface; fix the surface, don't raise the
// number. A change that lowers one is a win: lower the pin with it.
import { replaceGlobals } from "../../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

// Only the transports are faked; the components, hooks and store are real,
// because what is being counted is exactly their subscription behaviour.
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
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const { useInboxStore } = await import("../../../store/inboxStore");
const { readStoreListenerCount } = await import("../../../store/storeListenerCensus");
const { SessionListPanel, SessionCard } = await import("../../GlobalSessionPanel");

const SESSION_COUNT = 100;

function fixture(count: number): Record<string, any> {
  const sessions: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `${i}`.padStart(32, "s");
    sessions[id] = {
      _id: id,
      session_id: `budget-${i}`,
      user_id: "me",
      status: "active",
      updated_at: now - i * 1_000,
      message_count: i,
      is_idle: i % 3 === 0,
      agent_status: i % 3 === 0 ? "done" : "working",
      title: `Session ${i}`,
      project_path: `/src/project-${i % 5}`,
      session_error: null,
    };
  }
  return sessions;
}

function seed(count: number) {
  useInboxStore.setState({
    sessions: fixture(count),
    conversations: {},
    pending: {},
    currentUser: { _id: "me", name: "Me" },
    clientState: { ui: {} },
  } as any);
}

/** Subscriptions a surface holds while mounted, and whether it releases them. */
async function measure(element: React.ReactElement): Promise<number> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const before = readStoreListenerCount() ?? 0;
  await act(async () => root.render(element));
  const mounted = (readStoreListenerCount() ?? 0) - before;
  await act(async () => root.unmount());
  host.remove();
  // A surface that does not give its subscriptions back leaks a selector run
  // per write for the rest of the page's life.
  expect(readStoreListenerCount()).toBe(before);
  return mounted;
}

// Measured 2026-09-07 on this fixture: 1069 with the sidebar mounted at 100
// rows (229 at 20 rows — the panel's own subscriptions plus about 10.5 per
// visible card), and 13 for a card mounted on its own. The fixture size is
// fixed, so the sidebar number IS the per-row cost: it moves only when a card
// or the panel changes how much it subscribes to.
const SIDEBAR_PIN = 1069;
const CARD_PIN = 13;

test(`the sidebar's store listeners stay within budget at ${SESSION_COUNT} sessions`, async () => {
  seed(SESSION_COUNT);
  const listeners = await measure(<SessionListPanel />);
  expect(listeners).toBeGreaterThan(0);
  expect(listeners).toBeLessThanOrEqual(SIDEBAR_PIN);
}, 60_000);

test("an inbox card's store listeners stay within budget", async () => {
  seed(SESSION_COUNT);
  const session = Object.values(useInboxStore.getState().sessions)[0] as any;
  const listeners = await measure(
    <SessionCard
      session={session}
      isActive={false}
      globalIndex={0}
      onSelect={() => {}}
      sessionLabel={null}
      isFavorite={false}
    />,
  );
  expect(listeners).toBeGreaterThan(0);
  expect(listeners).toBeLessThanOrEqual(CARD_PIN);
}, 60_000);
