// ct-101797: opening a teammate's session through /conversation/<id> (Team
// Activity, a pill, a shared link) must not make it the inbox's current
// session. The page redirects into the inbox to SHOW it, but the person's own
// current session and the remembered pointer (lastFocusedConversationId /
// clientState.current_conversation_id) must stay on their own work, so the
// next visit to the inbox, or a reload, lands on their queue.
// Opening the person's OWN session the same way still makes it current.
// Run: cd packages/web && bun test "app/conversation/[id]/teammateOpen.mount.test.tsx"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/conversation/x" });
dom.window.document.hasFocus = () => true;
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

const ME = "user_me";
const OWN = "jx7own00000000000000000000000000";
const MATE = "jx7mate0000000000000000000000000";
const MINE_TOO = "jx7mine0000000000000000000000000";

let routeId = MATE;
let resolved: { access_level: string; conversation_id: string } | undefined;
const replaced: string[] = [];

const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNav,
  useParams: () => ({ id: routeId }),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: (u: string) => replaced.push(u), push: (u: string) => replaced.push(u) }),
}));
const realAuth = { ...(await import("@platform/auth/web")) };
mock.module("@platform/auth/web", () => ({ ...realAuth, useAuthGate: () => "children" }));
const realNoThrow = { ...(await import("../../../hooks/useQueryNoThrow")) };
mock.module("../../../hooks/useQueryNoThrow", () => ({
  ...realNoThrow,
  useQueryNoThrow: () => ({ data: resolved, error: null, retry: () => {} }),
}));
const realLayout = { ...(await import("../../../components/DashboardLayout")) };
mock.module("../../../components/DashboardLayout", () => ({ ...realLayout, DashboardLayout: ({ children }: any) => children ?? null }));
const realPlaceholder = { ...(await import("../../../components/ConversationPlaceholder")) };
mock.module("../../../components/ConversationPlaceholder", () => ({ ...realPlaceholder, ConversationPlaceholder: () => null }));

const { default: ConversationPage } = await import("./ConversationPageClient");
const { useInboxStore } = await import("../../../store/inboxStore");
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

function seed() {
  useInboxStore.setState({ currentUser: { _id: ME, name: "Me" } as any });
  const s = useInboxStore.getState();
  s.syncRecord("sessions", OWN, { _id: OWN, user_id: ME, owner_user_id: ME, title: "mine", updated_at: 2 } as any);
  s.syncRecord("sessions", MINE_TOO, { _id: MINE_TOO, user_id: ME, owner_user_id: ME, title: "mine too", updated_at: 1 } as any);
  // The teammate's session is already in this browser's cache, as it is after
  // Team Activity or a pill showed it.
  s.syncRecord("sessions", MATE, { _id: MATE, user_id: "user_mate", owner_user_id: "user_mate", author_name: "Mate", title: "theirs", updated_at: 3 } as any);
  s.navigateToSession(OWN, "restore" as any);
  expect(useInboxStore.getState().currentSessionId).toBe(OWN);
}

async function open(id: string, access: string | null) {
  routeId = id;
  resolved = access ? { access_level: access, conversation_id: id } : undefined;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConversationPage />));
  await act(() => root.unmount());
}

beforeEach(() => {
  replaced.length = 0;
  seed();
});

describe("opening a session through /conversation/<id>", () => {
  for (const [label, access] of [["served from cache", null], ["resolved by the server", "team"]] as const) {
    test(`a teammate's session does not become the inbox's current session (${label})`, async () => {
      await open(MATE, access);
      expect(replaced).toContain(`/inbox?s=${MATE}`); // still shown, through the inbox
      const s = useInboxStore.getState();
      expect(s.currentSessionId).not.toBe(MATE);
      expect(s.lastFocusedConversationId).not.toBe(MATE);
      expect(s.clientState.current_conversation_id).not.toBe(MATE);
    });
  }

  test("the person's own session still becomes current (guard)", async () => {
    await open(MINE_TOO, "owner");
    expect(replaced).toContain(`/inbox?s=${MINE_TOO}`);
    expect(useInboxStore.getState().currentSessionId).toBe(MINE_TOO);
  });
});
