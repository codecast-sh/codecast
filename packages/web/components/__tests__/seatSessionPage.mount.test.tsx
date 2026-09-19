// The role page is the session page (docs/architecture/
// initiatives-projects-role-page.md I3). The WHOLE inbox page is mounted over
// the real store, because the contract is about where every way of opening a
// session ends: they all set the pane's session, and the pane decides once.
//
//   four routes   a card (navigateToSession), the palette or a pill
//                 (requestNavigate), a link or the chart's route (?s=), and a
//                 stashed seat peeked at: each renders the role layout
//   a hand        a session that reports to a role keeps the session page
//   session view  the plain conversation lasts one visit: leaving the seat and
//                 coming back is the role page again, and "Role page" returns
//   the header    the seat's conversation keeps the session header (never
//                 hideHeader), the share control and the context panels, rests
//                 on one row and opens on demand
//   unknown role  a seat whose role the tree does not hold stays a session
// Run: bun test components/__tests__/seatSessionPage.mount.test.tsx
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

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
afterAll(() => { dom.window.close(); restoreGlobals(); });

const React = await import("react");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;

const SEAT = "seat0000000000000000000000000000";
const HAND = "hand0000000000000000000000000000";
const STRAY = "stray000000000000000000000000000";
const ROLE = "role-chief";
const env = { qs: "" };

// Only the transports and the heavy leaves are faked; the inbox page, the
// pane, the switch and the store are real.
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useMutation: () => async () => "token", useQuery: () => undefined }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(env.qs),
  usePathname: () => "/inbox",
}));
mock.module("sonner", () => ({ toast: Object.assign(() => {}, { success: () => {}, error: () => {}, warning: () => {} }) }));
mock.module("../DashboardLayout", () => ({ DashboardLayout: ({ children }: any) => <div data-shell>{children}</div> }));
mock.module("../FleetBoard", () => ({ FleetBoard: () => <div data-fleet />, InboxHomeToggle: () => null }));
mock.module("../ActivityFeed", () => ({ ActivityFeed: () => <div data-feed /> }));
mock.module("../EmptyState", () => ({ EmptyState: () => null }));
mock.module("../SharePopover", () => ({ SharePopover: () => <button data-share>Share</button> }));
mock.module("../SessionErrorBanner", () => ({ SessionErrorBanner: () => null, SessionResumeBanner: () => null }));
mock.module("../PlanContextPanel", () => ({ PlanContextPanel: () => null }));
mock.module("../WorkflowContextPanel", () => ({ WorkflowContextPanel: () => null }));
mock.module("../TriggerContextPanel", () => ({ TriggerContextPanel: () => <div data-trigger-panel /> }));
mock.module("../ConversationPlaceholder", () => ({ ConversationPlaceholder: ({ id }: any) => <div data-placeholder={id} /> }));
mock.module("../KeyboardShortcutsHelp", () => ({ ShortcutTooltip: ({ children }: any) => children, KeyCap: ({ children }: any) => <kbd>{children}</kbd> }));
mock.module("../anchor/AnchorConversation", () => ({ useSeedOwnership: () => {} }));
mock.module("../../hooks/useSyncOrgTree", () => ({ useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
mock.module("../../hooks/useMissingSessionRow", () => ({ useMissingSessionRow: () => undefined }));
mock.module("../../hooks/useTitlebarHead", () => ({ useTitlebarHead: () => ({ current: null }) }));
mock.module("../../hooks/useConversationMessages", () => ({
  useConversationMessages: (id: string) => ({
    conversation: { _id: id, messages: [], is_own: true, updated_at: Date.now() },
    hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false,
    loadOlder: () => {}, loadNewer: () => {}, jumpToStart: () => {}, jumpToEnd: () => {}, jumpToTimestamp: () => {},
    effectiveTargetMessageId: undefined, isJumpingToTarget: false,
  }),
}));
// The session header lives in ConversationView; what the pane hands it is the
// contract here. Its slots render, so a control the pane forgot would be absent.
mock.module("../ConversationDiffLayout", () => ({
  ConversationDiffLayout: (p: any) => (
    <div data-layout={p.conversation._id} data-hide-header={p.hideHeader ? "1" : "0"} data-density={p.initialDensity ?? ""} data-hide-diff={p.hideDiff ? "1" : "0"}>
      <header data-sv-convhead>{p.headerLeft}{p.headerExtra}{p.headerEnd}</header>
      {p.subHeaderContent}
      {p.leadNode}
    </div>
  ),
}));

const queuePage = await import("../../app/inbox/QueuePageClient");
// The role page's own body has its mount test (org/scope/ScopePage.mount.test);
// here it is the frame plus the conversation it really mounts: the pane, with
// the seat's options and the pane's props handed through.
mock.module("../org/scope/ScopePage", () => ({
  ScopePageInner: ({ id, session }: any) => {
    const { onSessionView, ...pane } = session;
    return (
      <div data-scope-page={id}>
        <aside data-scope-aside="side" />
        <queuePage.InboxConversation {...pane} seat={{ layout: { initialDensity: "condensed", hideDiff: true, leadNode: <p data-lead /> }, seedOwnership: true, onSessionView }} />
      </div>
    );
  },
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { createRoot } = await import("react-dom/client");

const roleSnapshot = { _id: ROLE, name: "Chief of Staff", handle: "chief-of-staff", avatar: null };
const row = (id: string, extra: Record<string, unknown>) => ({ _id: id, title: id, started_at: 1, updated_at: Date.now(), message_count: 3, is_idle: true, agent_type: "claude_code", ...extra });
const seed = () => useInboxStore.setState({
  clientStateInitialized: true,
  showMySessions: false,
  orgTree: { roles: [{ _id: ROLE, short_id: "or-10", name: "Chief of Staff", handle: "chief-of-staff", status: "active" }] } as any,
  sessions: {
    [SEAT]: row(SEAT, { standing_role_id: ROLE, role: roleSnapshot }),
    [HAND]: row(HAND, { org_role_id: ROLE, role: roleSnapshot }),
    [STRAY]: row(STRAY, { standing_role_id: "role-elsewhere", role: { ...roleSnapshot, _id: "role-elsewhere" } }),
  } as any,
});

let root = createRoot(document.getElementById("root")!);
const mount = async (qs = "") => {
  await act(async () => root.unmount());
  env.qs = qs;
  seed();
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<queuePage.QueuePageClient />));
};
// The role page arrives through React.lazy: wait out its placeholder.
const settle = async () => {
  for (let i = 0; i < 200; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, i < 4 ? 0 : 25)); });
    if (i >= 3 && !document.querySelector("[data-placeholder]")) return;
  }
};
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (sel: string) => { const el = q(sel); expect(el).not.toBeNull(); await act(async () => el!.click()); await settle(); };
const go = async (fn: (s: ReturnType<typeof useInboxStore.getState>) => void) => { await act(async () => fn(useInboxStore.getState())); await settle(); };
const expectRolePage = () => {
  expect(q("[data-scope-page]")?.getAttribute("data-scope-page")).toBe(ROLE);
  expect(q("[data-scope-aside]")).not.toBeNull();
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(SEAT);
};

test("a seat opened by four routes renders the role layout", async () => {
  await mount();
  // A card, the chart's select, a fork chip: what the inbox's own click handler does.
  await go((s) => { s.navigateToSession(SEAT); s.setShowMySessions(false); });
  expectRolePage();

  await mount();
  await go((s) => s.requestNavigate(SEAT)); // the palette, a pill in prose
  expectRolePage();

  await mount(`s=${SEAT}`); // /conversation/<id> hands over to /inbox?s=<id>: a shared link, the chart's route
  await settle();
  expectRolePage();

  await mount();
  await go((s) => s.setViewingDismissedId(SEAT)); // a stashed seat, peeked at
  expectRolePage();
}, 600_000);

test("a hand keeps the session page, and so does a seat whose role the tree does not hold", async () => {
  await mount();
  await go((s) => s.navigateToSession(HAND));
  expect(q("[data-scope-page]")).toBeNull();
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(HAND);
  expect(q("[data-seat-role-page]")).toBeNull();
  expect(q("[data-seat-head]")).toBeNull();

  await go((s) => s.navigateToSession(STRAY));
  expect(q("[data-scope-page]")).toBeNull();
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(STRAY);
  expect(q("[data-seat-role-page]")).toBeNull();
}, 600_000);

test("Session view lasts one visit, and Role page returns within it", async () => {
  await mount();
  await go((s) => s.navigateToSession(SEAT));
  expectRolePage();

  await click("[data-seat-session-view]");
  expect(q("[data-scope-page]")).toBeNull();
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(SEAT);
  expect(q("[data-seat-head]")).toBeNull();

  await click("[data-seat-role-page]");
  expectRolePage();

  await click("[data-seat-session-view]");
  await go((s) => s.navigateToSession(HAND));
  await go((s) => s.navigateToSession(SEAT));
  expectRolePage();
}, 600_000);

test("the role page asks for the plain view across the route, once", async () => {
  const { askSessionView } = await import("../../lib/sessionViewVisit");
  await mount();
  // The pane is already showing another session when the person arrives.
  await go((s) => s.navigateToSession(HAND));
  askSessionView(SEAT);
  await go((s) => s.navigateToSession(SEAT));
  expect(q("[data-scope-page]")).toBeNull();
  expect(q("[data-seat-role-page]")).not.toBeNull();

  await go((s) => s.navigateToSession(HAND));
  await go((s) => s.navigateToSession(SEAT));
  expectRolePage();
}, 600_000);

test("the seat keeps the session header and every slot, resting on one row", async () => {
  await mount();
  await go((s) => s.navigateToSession(SEAT));
  const layout = q("[data-layout]")!;
  expect(layout.getAttribute("data-hide-header")).toBe("0");
  expect(layout.getAttribute("data-density")).toBe("condensed");
  expect(q("[data-sv-convhead] [data-share]")).not.toBeNull();
  expect(q("[data-trigger-panel]")).not.toBeNull();
  expect(q("[data-seat-label]")).not.toBeNull();
  expect(q("[data-lead]")).not.toBeNull();

  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("rest");
  await click("[data-seat-head-toggle]");
  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("open");
  // The label leaves the DOM, which is what makes the row's squeeze measure again.
  expect(q("[data-seat-label]")).toBeNull();
  expect(q("[data-seat-head-toggle]")?.getAttribute("aria-expanded")).toBe("true");
  await click("[data-seat-head-toggle]");
  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("rest");
}, 600_000);

// The fold is CSS over the real header, so no action is rebuilt and none can
// be lost: at rest it hides, and the open state hides no action.
test("the fold only hides at rest", async () => {
  const css = (await Bun.file(new URL("../../app/globals.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]*\[data-seat-head[^{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[1], body: m[2] }));
  expect(rules.length).toBeGreaterThan(0);
  for (const r of rules.filter((x) => /display:\s*none/.test(x.body))) {
    for (const sel of r.sel.split(/,\s*\n/)) {
      // Open hides only what the role's header already says: the title and the face before it.
      const repeatsTheRoleHeader = /\[data-seat-head="open"\].*(\.cq-squeeze-row > h1|\.cq-squeeze-row > :has\(\+ h1\))\s*$/.test(sel.trim());
      expect(/\[data-seat-head="rest"\]/.test(sel) || repeatsTheRoleHeader).toBe(true);
    }
  }
  const rest = rules.find((x) => x.sel.includes("cq-squeeze-row"))!;
  for (const kept of ["[data-cc-conv-status]", "[data-cc-conv-actions]", "input"]) expect(rest.sel.includes(kept)).toBe(true);
  expect(rules.some((x) => x.sel.includes("[data-cc-conv-actions] > :not([data-cc-keep])"))).toBe(true);
});
