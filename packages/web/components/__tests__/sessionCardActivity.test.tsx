// The activity line on an inbox card: a working row with a fresh stamp shows
// the phrase; a done row, or a working row whose stamp has aged past the
// freshness cutoff, shows nothing (presence is derived from real activity,
// and stale data hides rather than shows as current). Rendered against the
// real card, store and hooks, the way fixtures/listenerBudget.tsx does.
import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { SESSION_ACTIVITY_FRESH_MS } from "@codecast/shared/contracts";

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
const { SessionCard } = await import("../GlobalSessionPanel");

const ID = "s".repeat(32);
const PHRASE = "editing chat.ts";

function row(overrides: Record<string, any>) {
  const now = Date.now();
  return {
    _id: ID,
    session_id: "activity-card",
    user_id: "me",
    status: "active",
    updated_at: now,
    last_heartbeat: now,
    message_count: 4,
    is_connected: true,
    title: "Activity card",
    project_path: "/src/project",
    session_error: null,
    activity: { text: PHRASE, tool: "Edit", at: now },
    ...overrides,
  };
}

async function renderCard(session: Record<string, any>): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  useInboxStore.setState({
    sessions: { [ID]: session },
    conversations: {},
    pending: {},
    currentUser: { _id: "me", name: "Me" },
    clientState: { ui: {} },
  } as any);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SessionCard
        session={useInboxStore.getState().sessions[ID] as any}
        isActive={false}
        globalIndex={0}
        onSelect={() => {}}
        sessionLabel={null}
        isFavorite={false}
      />,
    ),
  );
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("a working row shows the activity phrase with the live pulse", async () => {
  const { host, unmount } = await renderCard(row({ agent_status: "working", is_idle: false }));
  const line = host.querySelector("[data-sv-activity]");
  expect(line).not.toBeNull();
  expect(line!.querySelector("[data-sv-activity-text]")!.textContent).toBe(PHRASE);
  // Hover shows the whole phrase.
  expect(line!.getAttribute("title")).toBe(PHRASE);
  await unmount();
});

test("a done row shows no activity line even though the row carries a stamp", async () => {
  const { host, unmount } = await renderCard(row({ agent_status: "done", is_idle: true }));
  expect(host.querySelector("[data-sv-activity]")).toBeNull();
  expect(host.textContent).not.toContain(PHRASE);
  await unmount();
});

test("a working row whose stamp aged past the cutoff shows no activity line", async () => {
  const stale = Date.now() - SESSION_ACTIVITY_FRESH_MS - 1_000;
  const { host, unmount } = await renderCard(
    row({ agent_status: "working", is_idle: false, activity: { text: PHRASE, tool: "Edit", at: stale } }),
  );
  expect(host.querySelector("[data-sv-activity]")).toBeNull();
  await unmount();
});
