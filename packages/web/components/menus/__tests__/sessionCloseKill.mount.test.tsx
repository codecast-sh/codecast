// The session menu's Close and Kill, and the selection's Kill, mounted: Close
// is one press; Kill ends at once when nothing is lost and asks first
// (killReviewOf) when it would cancel a trigger, drop queued messages or cut a
// turn off.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://app.test/inbox", pretendToBeVisual: true });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver,
  getComputedStyle: w.getComputedStyle.bind(w), DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event,
  CustomEvent: w.CustomEvent, MouseEvent: w.MouseEvent, PointerEvent: w.MouseEvent, FocusEvent: w.FocusEvent, NodeFilter: w.NodeFilter,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
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

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { SessionMenuItems } = await import("../ObjectContextMenus");
const { KillSelection } = await import("../../BulkMoveSessions");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("../../ui/dropdown-menu");
type InboxSession = import("../../../store/inboxStore").InboxSession;

const NOW = Date.now();
const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, session_id: `s-${id}`, title: `Row ${id}`, user_id: "me", owned_by_me: true, message_count: 4, agent_status: "idle", is_idle: true, updated_at: NOW - 60_000, ...extra }) as unknown as InboxSession;
const armed = (id: string, conv: string) => ({ _id: id, title: `Check ${id}`, prompt: "p", status: "scheduled", schedule_type: "once", originating_conversation_id: conv });

let root: any;
let calls: string[];
const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
const press = (el: Element) => React.act(async () => { (el as HTMLElement).click(); });
const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const itemNamed = (text: string) => [...w.document.querySelectorAll('[role="menuitem"]')].find((el: any) => el.textContent?.trim().startsWith(text)) as HTMLElement | undefined;

beforeEach(() => {
  calls = [];
  useInboxStore.setState({ sessions: {}, conversations: {}, agentTasks: {}, buckets: {}, bucketAssignments: {}, currentUser: { _id: "me" } } as any);
  root = createRoot(w.document.getElementById("root"));
});
afterEach(async () => { await React.act(async () => root.unmount()); await tick(); w.document.body.innerHTML = '<div id="root"></div>'; });

async function openMenu(session: InboxSession) {
  await React.act(async () => root.render(
    <DropdownMenu open>
      <DropdownMenuTrigger asChild><button type="button">open</button></DropdownMenuTrigger>
      <DropdownMenuContent>
        <SessionMenuItems session={session} onClose={() => calls.push("close")} onKill={() => calls.push("kill")} />
      </DropdownMenuContent>
    </DropdownMenu>,
  ));
}

describe("the session menu", () => {
  test("a live session offers Close and Kill; Close is one press", async () => {
    await openMenu(row("a"));
    expect(itemNamed("Close")).toBeDefined();
    expect(itemNamed("Kill session")).toBeDefined();
    await press(itemNamed("Close")!);
    expect(calls).toEqual(["close"]);
  });

  test("Kill on a session with nothing armed or queued ends at once", async () => {
    await openMenu(row("a"));
    await press(itemNamed("Kill session")!);
    expect(calls).toEqual(["kill"]);
    expect(q("[data-switch-review]")).toBeNull();
  });

  test("Kill on a session with an armed trigger asks first, and kills only on the review's confirm", async () => {
    useInboxStore.setState({ agentTasks: { t1: armed("t1", "a") } } as any);
    await openMenu(row("a"));
    await press(itemNamed("Kill session")!);
    expect(calls).toEqual([]);
    const review = q("[data-switch-review]")!;
    expect(review).not.toBeNull();
    expect(review.textContent).toContain("Check t1");
    await press(q("[data-switch-confirm]")!);
    expect(calls).toEqual(["kill"]);
  });

  test("a closed session offers no Close, and keeps its Kill", async () => {
    await openMenu(row("a", { inbox_dismissed_at: NOW - 1000 }));
    expect(itemNamed("Close")).toBeUndefined();
    expect(itemNamed("Kill session")).toBeDefined();
  });
});

describe("KillSelection", () => {
  const mountKill = (sessions: InboxSession[]) => React.act(async () => root.render(
    <KillSelection sessions={sessions} onKill={(ids) => calls.push(`kill ${ids.join(",")}`)} onClear={() => calls.push("clear")} />,
  ));

  test("a selection with a session mid-turn or holding queued messages asks first; cancel kills nothing", async () => {
    await mountKill([row("a", { is_idle: false }), row("b", { has_pending: true })]);
    await press(q("[data-bulk-kill]")!);
    expect(calls).toEqual([]);
    expect(q("[data-switch-review]")!.textContent).toContain("Kill 2 sessions");
    await press(q("[data-switch-cancel]")!);
    expect(calls).toEqual([]);
    await press(q("[data-bulk-kill]")!);
    await press(q("[data-switch-confirm]")!);
    expect(calls).toEqual(["kill a,b", "clear"]);
  });

  test("an idle selection with nothing to lose ends at once", async () => {
    await mountKill([row("a"), row("b")]);
    await press(q("[data-bulk-kill]")!);
    expect(calls).toEqual(["kill a,b", "clear"]);
  });

  test("a role's own session goes straight to its kill, which asks to retire the role instead of this review", async () => {
    useInboxStore.setState({ agentTasks: { t1: armed("t1", "seat") } } as any);
    await mountKill([row("seat", { standing_role_id: "r1", has_pending: true })]);
    await press(q("[data-bulk-kill]")!);
    expect(q("[data-switch-review]")).toBeNull();
    expect(calls).toEqual(["kill seat", "clear"]);
  });
});
