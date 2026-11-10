// The Modern rail, mounted. Two promises it keeps:
// - On a phone it sits in a drawer (MobileDrawer), and every row that goes
//   somewhere closes it; a row that opens a level (More) keeps it open.
// - It is always mounted, so a live count is in every heartbeat's path: the
//   Inbox row (useNeedsInputCount, over wake signatures) and the Ops count
//   (the Ops lists, never sessions) commit nothing on one.
// Run: cd packages/web && bun test --isolate components/sidebar/modernRail.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/inbox", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  indexedDB,
  IDBKeyRange,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { useInboxStore } = await import("../../store/inboxStore");
const { ModernNavView, RegistryNavSection } = await import("./ModernNav");
const { MoreDrillList } = await import("./MoreNav");
const { ModernInboxRow } = await import("./ModernSidebar");
const { OpsRailCount } = await import("./OpsRailCount");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const shut = { items: [], expanded: false, onToggle: () => {} };
const ALL = { chat: true, calls: true, changes: true, org: true, line: true, team: true, staff: true } as const;

async function clicks(render: (close: () => void, more: () => void) => ReactNode) {
  let closed = 0;
  let mores = 0;
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(<MemoryRouter>{render(() => { closed++; }, () => { mores++; })}</MemoryRouter>));
  const rows = [...host.querySelectorAll<HTMLElement>("a[data-nav-row]")];
  for (const row of rows) {
    await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  }
  const more = host.querySelector<HTMLElement>("[data-rail-more] button");
  if (more) await act(async () => { more.click(); });
  await act(async () => root.unmount());
  return { rows: rows.length, closed, mores };
}

test("every page row of the rail closes the drawer; More opens its level and keeps it", async () => {
  const r = await clicks((close, more) => {
    const row = (id: "inbox" | "decisions" | "threads" | "activity") => <RegistryNavSection id={id} isActive={false} isNarrow={false} onMobileClose={close} />;
    return (
      <ModernNavView
        isNarrow={false}
        onMobileClose={close}
        onMore={more}
        live={{ inbox: row("inbox"), decisions: row("decisions"), threads: row("threads"), activity: row("activity") }}
        activeId={null}
        gates={ALL}
        tasks={shut}
        docs={shut}
      />
    );
  });
  // Inbox, Decisions, Threads, Activity, five Work rows, three Automation, four Code & Ops.
  expect(r.rows).toBe(16);
  expect(r.closed).toBe(r.rows);
  expect(r.mores).toBe(1);
});

test("every row of the More level closes the drawer", async () => {
  const r = await clicks((close) => <MoreDrillList activeId={null} gates={ALL} focused onMobileClose={close} />);
  expect(r.rows).toBeGreaterThanOrEqual(30);
  expect(r.closed).toBe(r.rows);
});

test("a heartbeat re-renders neither the Inbox row nor the Ops count", async () => {
  const ME = "user_rail_heartbeat";
  const sessions: Record<string, any> = {};
  for (let i = 0; i < 300; i++) {
    sessions[`s${i}`] = { _id: `s${i}`, user_id: ME, title: `Session ${i}`, status: i % 3 ? "completed" : "active", agent_status: i % 3 ? "idle" : "working", is_idle: i % 3 !== 0, updated_at: Date.now() - i * 1000, last_heartbeat: Date.now(), message_count: 4 };
  }
  useInboxStore.setState({ sessions, currentUser: { _id: ME } } as any);

  let commits = 0;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ConvexProvider client={offlineConvexClient()}>
      <MemoryRouter>
        <Profiler id="rail" onRender={() => { commits++; }}>
          <ModernInboxRow isActive={false} isNarrow={false} />
          <OpsRailCount />
        </Profiler>
      </MemoryRouter>
    </ConvexProvider>,
  ));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(host.textContent).toContain("Inbox");

  const settled = commits;
  for (let k = 0; k < 5; k++) {
    await act(async () => {
      const s = useInboxStore.getState().sessions as Record<string, any>;
      useInboxStore.setState({ sessions: { ...s, s0: { ...s.s0, last_heartbeat: Date.now() + k } } } as any);
    });
  }
  expect(commits).toBe(settled);
  await act(async () => root.unmount());
});
