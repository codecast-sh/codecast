// Opening a session from outside the inbox (a chat author link, a pill, a
// pane closing back onto a conversation) must take the address bar straight
// to that session. ct-97961: replay rp-15795 at 0:57 shows the address bar go
// /conversation/B (the link) → /conversation/A (the session the person had
// LEFT) → /inbox?s=B → /conversation/B. The kept-mounted inbox pane comes
// back to the front holding ?s=B while the store still has A current and B is
// not cached yet, and its address-bar sync writes A over the link.
//
// The WHOLE inbox page is mounted over the real store; only transports and
// heavy leaves are faked.
// Run: bun test app/inbox/__tests__/openFromElsewhereUrl.mount.test.tsx
import { replaceGlobals } from "../../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
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

const LEFT = "a0000000000000000000000000000000"; // the conversation the person was on
const TARGET = "b0000000000000000000000000000000"; // the one the chat link opens, not in the inbox cache
const env = { qs: "" };

const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useMutation: () => async () => "token", useQuery: () => undefined, useQueries: () => ({}) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(env.qs),
  usePathname: () => "/inbox",
}));
mock.module("sonner", () => ({ toast: Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {} }) }));
mock.module("../../../components/DashboardLayout", () => ({ DashboardLayout: ({ children }: any) => <div data-shell>{children}</div> }));
mock.module("../../../components/FleetBoard", () => ({ FleetBoard: () => <div data-fleet />, InboxHomeToggle: () => null }));
mock.module("../../../components/ActivityFeed", () => ({ ActivityFeed: () => <div data-feed /> }));
mock.module("../../../components/EmptyState", () => ({ EmptyState: () => null }));
mock.module("../../../components/SharePopover", () => ({ SharePopover: () => null }));
mock.module("../../../components/SessionErrorBanner", () => ({ SessionErrorBanner: () => null, SessionResumeBanner: () => null }));
mock.module("../../../components/PlanContextPanel", () => ({ PlanContextPanel: () => null }));
mock.module("../../../components/WorkflowContextPanel", () => ({ WorkflowContextPanel: () => null }));
mock.module("../../../components/TriggerContextPanel", () => ({ TriggerContextPanel: () => null }));
mock.module("../../../components/ConversationPlaceholder", () => ({ ConversationPlaceholder: ({ id }: any) => <div data-placeholder={id} /> }));
const realShortcutsHelp = { ...(await import("../../../components/KeyboardShortcutsHelp")) };
mock.module("../../../components/KeyboardShortcutsHelp", () => ({ ...realShortcutsHelp, ShortcutTooltip: ({ children }: any) => children, KeyCap: ({ children }: any) => <kbd>{children}</kbd> }));
mock.module("../../../hooks/useSeedOwnership", () => ({ useSeedOwnership: () => {} }));
const realOrgTree = { ...(await import("../../../hooks/useSyncOrgTree")) };
mock.module("../../../hooks/useSyncOrgTree", () => ({ ...realOrgTree, useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
const row = (id: string) => ({ _id: id, title: id, started_at: 1, updated_at: Date.now(), message_count: 3, is_idle: true, agent_type: "claude_code" });
// The server hands the target's row over as soon as the inbox asks for it.
mock.module("../../../hooks/useMissingSessionRow", () => ({
  useMissingSessionRow: () => undefined,
  useMissingSessionLookup: (id: string | null) => ({ row: id === TARGET ? row(TARGET) : undefined, failed: false }),
}));
mock.module("../../../hooks/useTitlebarHead", () => ({ useTitlebarHead: () => ({ current: null }) }));
mock.module("../../../hooks/useConversationMessages", () => ({
  useConversationMessages: (id: string) => ({
    conversation: { _id: id, messages: [], is_own: true, updated_at: Date.now() },
    hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false,
    loadOlder: () => {}, loadNewer: () => {}, jumpToStart: () => {}, jumpToEnd: () => {}, jumpToTimestamp: () => {},
    effectiveTargetMessageId: undefined, isJumpingToTarget: false,
  }),
}));
mock.module("../../../components/ConversationDiffLayout", () => ({
  ConversationDiffLayout: (p: any) => <div data-layout={p.conversation._id} />,
}));

const queuePage = await import("../QueuePageClient");
const { TabParamsCtx } = await import("../../../lib/tabParams");
const { useInboxStore } = await import("../../../store/inboxStore");
const { createRoot } = await import("react-dom/client");

// Every address-bar write the page makes, in order.
const writes: string[] = [];
const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);
window.history.pushState = (s: any, t: string, url?: string | URL | null) => { if (url != null) writes.push(`push ${url}`); realPush(s, t, url); };
window.history.replaceState = (s: any, t: string, url?: string | URL | null) => { if (url != null) writes.push(`replace ${url}`); realReplace(s, t, url); };

const settle = async () => {
  for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, i < 4 ? 0 : 10)); });
};

let root = createRoot(document.getElementById("root")!);
const render = async (active: boolean) => {
  const ctx = { tabId: "t1", pathname: "/inbox", params: {}, searchParams: new URLSearchParams(env.qs), isActive: active };
  await act(async () => root.render(
    <TabParamsCtx.Provider value={ctx}><queuePage.QueuePageClient /></TabParamsCtx.Provider>,
  ));
};

test("opening an uncached session from chat never writes the conversation the person left into the address bar", async () => {
  // The person is on A in the inbox tab.
  realReplace(null, "", `/conversation/${LEFT}`);
  useInboxStore.setState({ clientStateInitialized: true, showMySessions: false, sessions: { [LEFT]: row(LEFT) } as any });
  await act(async () => useInboxStore.getState().navigateToSession(LEFT));
  env.qs = "";
  await render(true);
  await settle();
  expect(window.location.pathname).toBe(`/conversation/${LEFT}`);

  // They go to chat: the inbox pane stays mounted in the background.
  realPush(null, "", "/chat/hx7md1p2dqqxh14r42w7fn3zws8ccpnj");
  await render(false);
  await settle();

  // They click a session link in chat. The link lands on /conversation/B, the
  // tab takes its inbox spelling (/inbox?s=B) and the inbox comes forward.
  realPush(null, "", `/conversation/${TARGET}`);
  writes.length = 0;
  env.qs = `s=${TARGET}`;
  await render(true);
  await settle();

  // It lands on B, and nothing on the way names A or the bare inbox.
  expect(useInboxStore.getState().currentSessionId).toBe(TARGET);
  expect(window.location.pathname).toBe(`/conversation/${TARGET}`);
  expect(writes.filter((w) => w.includes(LEFT))).toEqual([]);
  // The link already wrote B: the pane writes nothing at all, so one Back
  // press returns to the chat with no stale entry stacked on top.
  expect(writes).toEqual([]);
}, 120_000);

test("a cached target lands the same way: the pane selects it in place and writes nothing", async () => {
  // Back on the inbox (still on B), the person goes to chat again, and this
  // time opens A, which the inbox already holds.
  await act(async () => useInboxStore.getState().navigateToSession(TARGET));
  realPush(null, "", "/chat/hx7md1p2dqqxh14r42w7fn3zws8ccpnj");
  await render(false);
  await settle();

  realPush(null, "", `/conversation/${LEFT}`);
  writes.length = 0;
  env.qs = `s=${LEFT}`;
  await render(true);
  await settle();

  expect(useInboxStore.getState().currentSessionId).toBe(LEFT);
  expect(window.location.pathname).toBe(`/conversation/${LEFT}`);
  expect(writes).toEqual([]);
}, 120_000);
