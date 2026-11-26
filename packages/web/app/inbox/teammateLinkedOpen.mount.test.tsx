// ct-101797, the inbox half: /conversation/<id> hands a session to the inbox as
// `?s=<id>`. A teammate's session arriving that way is SHOWN (the view-only
// peek) but never made current, so clicking Inbox afterwards (a bare /inbox)
// shows the person's own session again, and the remembered pointer a reload
// restores never names the teammate's. The person's own session arriving the
// same way still becomes current. The WHOLE inbox page is mounted over the real
// store; only transports and heavy leaves are faked.
// Run: cd packages/web && bun test --isolate app/inbox/teammateLinkedOpen.mount.test.tsx
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
dom.window.document.hasFocus = () => true;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const React = await import("react");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const ME = "user_me";
const OWN = "jx7own00000000000000000000000000";
const MINE_TOO = "jx7mine0000000000000000000000000";
const MATE = "jx7mate0000000000000000000000000";
const env = { qs: "" };

const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useMutation: () => async () => "token", useQuery: () => undefined, useQueries: () => ({}) }));
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNav,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(env.qs),
  usePathname: () => "/inbox",
}));
const realLayout = { ...(await import("../../components/DashboardLayout")) };
mock.module("../../components/DashboardLayout", () => ({ ...realLayout, DashboardLayout: ({ children }: any) => <div data-shell>{children}</div> }));
const realMessages = { ...(await import("../../hooks/useConversationMessages")) };
mock.module("../../hooks/useConversationMessages", () => ({
  ...realMessages,
  useConversationMessages: (id: string) => ({
    conversation: { _id: id, messages: [], updated_at: Date.now() },
    hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false,
    loadOlder: () => {}, loadNewer: () => {}, jumpToStart: () => {}, jumpToEnd: () => {}, jumpToTimestamp: () => {},
    effectiveTargetMessageId: undefined, isJumpingToTarget: false,
  }),
}));
const realDiff = { ...(await import("../../components/ConversationDiffLayout")) };
mock.module("../../components/ConversationDiffLayout", () => ({
  ...realDiff,
  ConversationDiffLayout: (p: any) => <div data-layout={p.conversation._id} />,
}));

const queuePage = await import("./QueuePageClient");
const { useInboxStore } = await import("../../store/inboxStore");
const { createRoot } = await import("react-dom/client");

const row = (id: string, owner: string) => ({
  _id: id, title: id, user_id: owner, owner_user_id: owner, ...(owner === ME ? {} : { author_name: "Mate" }),
  started_at: 1, updated_at: Date.now(), message_count: 3, is_idle: true, agent_type: "claude_code",
});

let root = createRoot(document.getElementById("root")!);
const mount = async (qs: string) => {
  await act(async () => root.unmount());
  env.qs = qs;
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<queuePage.QueuePageClient />));
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const shown = () => document.querySelector("[data-layout]")?.getAttribute("data-layout") ?? null;

function seed() {
  useInboxStore.setState({ currentUser: { _id: ME, name: "Me" }, clientStateInitialized: true, showMySessions: false, viewingDismissedId: null } as any);
  const s = useInboxStore.getState();
  s.syncRecord("sessions", OWN, row(OWN, ME) as any);
  s.syncRecord("sessions", MINE_TOO, row(MINE_TOO, ME) as any);
  s.syncRecord("sessions", MATE, row(MATE, "user_mate") as any);
  s.navigateToSession(OWN, "restore" as any);
  expect(useInboxStore.getState().currentSessionId).toBe(OWN);
}

test("a teammate's session handed over as ?s= is shown, and clicking Inbox returns to the person's own", async () => {
  seed();
  await mount(`s=${MATE}`);
  expect(shown()).toBe(MATE);
  let s = useInboxStore.getState();
  expect(s.currentSessionId).toBe(OWN);
  expect(s.lastFocusedConversationId).not.toBe(MATE);
  expect(s.clientState.current_conversation_id).not.toBe(MATE);

  await mount(""); // the sidebar's Inbox: a bare /inbox
  expect(shown()).toBe(OWN);
  s = useInboxStore.getState();
  expect(s.viewingDismissedId).toBeNull();
  expect(s.currentSessionId).toBe(OWN);
}, 60_000);

test("the person's own session handed over as ?s= still becomes current (guard)", async () => {
  seed();
  await mount(`s=${MINE_TOO}`);
  expect(shown()).toBe(MINE_TOO);
  expect(useInboxStore.getState().currentSessionId).toBe(MINE_TOO);

  await mount("");
  expect(shown()).toBe(MINE_TOO);
}, 60_000);
