// The inbox card's activity line ("editing chat.ts"): what a working session is
// doing right now, from the row's server side activity stamp.
//
// Two contracts are pinned here. The show rule: a working row with a fresh
// stamp shows the phrase, a settled row or a stale stamp does not (presence is
// derived from real activity; stale data hides, never shows as current). And
// the cost: a tool call in one session re-renders THAT card only. The list
// wakes on a structural signature that ignores this field by design
// (sessionStructuralSig), and each card reads its own row's stamp through one
// dep on its existing subscription, so a stamp on row A must commit card A and
// leave card B untouched. React's Profiler counts the commits per card.
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { SESSION_ACTIVITY_FRESH_MS } from "@codecast/shared/contracts";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  // Prism (in the panel's import graph) reads Element.prototype on import.
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Only the transports are faked; the card, the hooks and the store are real,
// because what is being measured is exactly their subscription behaviour.
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

const { useInboxStore } = await import("../../store/inboxStore");
const { flushSyncPublishes } = await import("../../store/syncTransaction");
const { SessionCard } = await import("../GlobalSessionPanel");

const NOW = Date.now();
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function row(id: string, extra: Record<string, unknown>) {
  return {
    _id: id,
    session_id: `activity-${id.slice(0, 1)}`,
    user_id: "me",
    status: "active",
    updated_at: NOW - 5_000,
    last_heartbeat: NOW - 1_000,
    message_count: 12,
    is_connected: true,
    title: `Session ${id.slice(0, 1)}`,
    project_path: "/src/project",
    session_error: null,
    ...extra,
  };
}

const working = (id: string, activity: unknown) => row(id, { agent_status: "working", is_idle: false, activity });
const settled = (id: string, activity: unknown) => row(id, { agent_status: "done", is_idle: true, activity });

function seed(rows: Record<string, unknown>[]) {
  const sessions: Record<string, unknown> = {};
  for (const r of rows) sessions[(r as any)._id] = r;
  useInboxStore.setState({
    sessions,
    conversations: {},
    pending: {},
    currentUser: { _id: "me", name: "Me" },
    clientState: { ui: {} },
  } as any);
}

function card(id: string) {
  const session = useInboxStore.getState().sessions[id] as any;
  return (
    <SessionCard
      session={session}
      isActive={false}
      globalIndex={0}
      onSelect={() => {}}
      sessionLabel={null}
      isFavorite={false}
    />
  );
}

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const lineOf = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-session-id="${id}"] [data-sv-activity]`);

test("a working row with a fresh stamp shows the phrase; a settled row and a stale stamp do not", async () => {
  seed([
    working(A, { text: "editing chat.ts", tool: "Edit", at: NOW - 2_000 }),
    settled(B, { text: "running bun test", tool: "Bash", at: NOW - 2_000 }),
    working(C, { text: "running deploy.sh", tool: "Bash", at: NOW - SESSION_ACTIVITY_FRESH_MS - 60_000 }),
  ]);
  const m = await mount(
    <>
      {card(A)}
      {card(B)}
      {card(C)}
    </>,
  );
  const a = lineOf(m.host, A);
  expect(a).not.toBeNull();
  expect(a!.querySelector("[data-sv-activity-text]")!.textContent).toBe("editing chat.ts");
  // Hover shows the whole phrase.
  expect(a!.getAttribute("title")).toBe("editing chat.ts");
  // The line takes the summary's slot: no summary beside it.
  expect(m.host.querySelector(`[data-session-id="${A}"] [data-sv-summary]`)).toBeNull();
  expect(lineOf(m.host, B)).toBeNull();
  expect(lineOf(m.host, C)).toBeNull();
  await m.unmount();
}, 30_000);

test("a tool call stamp on one row re-renders that card only, and the phrase follows it", async () => {
  seed([
    working(A, { text: "editing chat.ts", tool: "Edit", at: NOW - 2_000 }),
    working(B, { text: "reading daemon.ts", tool: "Read", at: NOW - 2_000 }),
  ]);
  let commitsA = 0;
  let commitsB = 0;
  const m = await mount(
    <>
      <React.Profiler id="a" onRender={() => { commitsA++; }}>{card(A)}</React.Profiler>
      <React.Profiler id="b" onRender={() => { commitsB++; }}>{card(B)}</React.Profiler>
    </>,
  );
  const rows = () => Object.values(useInboxStore.getState().sessions) as any[];
  // Steady state first: the first push of a shape does real work no matter
  // what it carries (syncTable seeds a conversation row per session).
  await act(async () => {
    useInboxStore.getState().syncTable("sessions", rows().map((r) => ({ ...r, last_heartbeat: NOW })));
    flushSyncPublishes();
  });
  commitsA = 0;
  commitsB = 0;
  // The liveness overlay lands a new stamp on A alone (a new object, as every
  // push hands back), plus the heartbeat churn every row carries.
  await act(async () => {
    useInboxStore.getState().syncTable(
      "sessions",
      rows().map((r) =>
        r._id === A
          ? { ...r, last_heartbeat: NOW + 1_000, activity: { text: "running npx tsc", tool: "Bash", at: NOW } }
          : { ...r, last_heartbeat: NOW + 1_000 },
      ),
    );
    flushSyncPublishes();
  });
  expect(commitsA).toBeGreaterThan(0);
  expect(commitsB).toBe(0);
  expect(lineOf(m.host, A)!.querySelector("[data-sv-activity-text]")!.textContent).toBe("running npx tsc");
  expect(lineOf(m.host, B)!.querySelector("[data-sv-activity-text]")!.textContent).toBe("reading daemon.ts");

  // A heartbeat alone (same stamp, new object) repaints neither card.
  commitsA = 0;
  commitsB = 0;
  await act(async () => {
    useInboxStore.getState().syncTable(
      "sessions",
      rows().map((r) => ({ ...r, last_heartbeat: NOW + 2_000, activity: { ...r.activity } })),
    );
    flushSyncPublishes();
  });
  expect(commitsA).toBe(0);
  expect(commitsB).toBe(0);
  await m.unmount();
}, 30_000);
