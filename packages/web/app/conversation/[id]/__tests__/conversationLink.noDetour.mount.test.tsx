// ct-101972: opening a conversation link must show that conversation at its
// own address. Today the page draws a placeholder and router.replace()s to
// /inbox?s=<id>, and the inbox rewrites the address back to /conversation/<id>
// once the session loads: two automatic page changes while the person waits.
// This test mounts /conversation/<id> for a signed-in owner (both a cold link,
// answered by resolveConversation, and a session already in the cache) and
// fails if the page sends the address anywhere else.
// Run: cd packages/web && bun test 'app/conversation/[id]/__tests__/conversationLink.noDetour.mount.test.tsx'
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const ID = "jx7a456grjw849zpkszxq7p7hh8jsv7x";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://codecast.sh/conversation/${ID}` });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

/** Every address the page asked for, through the router or the history API. */
const navigations: string[] = [];
const router = {
  replace: (href: string) => navigations.push(String(href)),
  push: (href: string) => navigations.push(String(href)),
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
};
const realReplaceState = dom.window.history.replaceState.bind(dom.window.history);
const realPushState = dom.window.history.pushState.bind(dom.window.history);
dom.window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
  if (url != null) navigations.push(String(url));
  realReplaceState(data, unused, url);
};
dom.window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
  if (url != null) navigations.push(String(url));
  realPushState(data, unused, url);
};

mock.module("next/navigation", () => ({
  useParams: () => ({ id: ID }),
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));
const realAuth = await import("@platform/auth/web");
mock.module("@platform/auth/web", () => ({ ...realAuth, useAuthGate: () => "children" }));

let resolved: unknown = undefined;
const realNoThrow = await import("../../../../hooks/useQueryNoThrow");
mock.module("../../../../hooks/useQueryNoThrow", () => ({
  ...realNoThrow,
  useQueryNoThrow: () => ({ data: resolved, error: undefined, retry: () => {} }),
}));
const realConvex = await import("convex/react");
mock.module("convex/react", () => ({ ...realConvex, useMutation: () => async () => null }));
const realLayout = await import("../../../../components/DashboardLayout");
mock.module("../../../../components/DashboardLayout", () => ({
  ...realLayout,
  DashboardLayout: ({ children }: { children?: unknown }) => children,
}));
const realPlaceholder = await import("../../../../components/ConversationPlaceholder");
mock.module("../../../../components/ConversationPlaceholder", () => ({
  ...realPlaceholder,
  ConversationPlaceholder: () => null,
}));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { default: ConversationPage } = await import("../ConversationPageClient");
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function open() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<ConversationPage />));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return () => act(() => root.unmount());
}

beforeEach(() => {
  navigations.length = 0;
  resolved = undefined;
  realReplaceState(null, "", `/conversation/${ID}`);
});

describe("opening /conversation/<id> while signed in", () => {
  test("a cold link opens the conversation in place, never via /inbox?s=", async () => {
    resolved = { access_level: "owner", conversation_id: ID };
    const unmount = await open();
    expect(navigations.filter((h) => h.includes("/inbox"))).toEqual([]);
    expect(window.location.pathname).toBe(`/conversation/${ID}`);
    await unmount();
  });

  test("a cached session opens in place, never via /inbox?s=", async () => {
    const me = "user_me";
    useInboxStore.setState((s: any) => ({
      ...s,
      currentUser: { ...(s.currentUser ?? {}), _id: me },
      sessions: { ...s.sessions, [ID]: { _id: ID, user_id: me, title: "Team productivity comparison" } },
    }));
    const unmount = await open();
    expect(navigations.filter((h) => h.includes("/inbox"))).toEqual([]);
    expect(window.location.pathname).toBe(`/conversation/${ID}`);
    await unmount();
  });
});
