// ONE PRESS OF BACK IS ONE STEP BACK (ct-98092).
//
// In the desktop app, Back (⌘[ on a Mac, Alt+← elsewhere) walks Modern's nav
// trail. A key held a moment past the system's key-repeat delay sends a
// second keydown with `repeat: true`. Nothing swallowed that repeat, so one
// press from a chat opened over conversation A went back to A and then, 0.3s
// later, on to B, the conversation before it (replay rp-16212 at 4:33: nav
// /inbox?s=A, /conversation/A, /conversation/B, one window keydown).
//
// Everything here is the app's own: the shortcut catalog and the platform
// keydown handler, the nav.back action (navBack), the store, and the trail
// recorder watching the active tab. Only the router is a stand-in: a push
// moves the active tab to the path, as the tab shell does.
// Run: cd packages/web && bun test shortcuts/__tests__/navBackHeld.test.ts
import { afterAll, beforeEach, expect, test } from "bun:test";
// Loaded before the DOM globals: the store boots its cache hydrate when it
// first loads under a window.
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const A_ID = "jx765h5n77wmm0jk9z72at93kn8jgx9y";
const B_ID = "jx7etyd2b961e2wzxx7zvs2ss98gzxh9";
const A = `/inbox?s=${A_ID}`;
const B = `/inbox?s=${B_ID}`;
const CHAT = "/chat/hx7tv3hz9553rss8zvkqc2dbx58j48bd";
const TAB = "tab_main";

const dom = new JSDOM("<!doctype html><html class='modern-style'><body></body></html>", { url: `https://codecast.sh${CHAT}` });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage });

const { createKeydownHandler, ShortcutDispatcher } = await import("@platform/keys");
const { shortcutCatalog } = await import("../registry");
const { KEY_OWNERSHIP } = await import("../keyOwnership");
const { trailOf, _resetTrailForTests } = await import("../../lib/navTrail");
const { startNavTrail } = await import("../../lib/navTrailRecorder");
const { navBack } = await import("../../hooks/useNavTrail");
const { getNavLog, _resetViewNavForTests } = await import("../../store/viewNav");
const { sessionFocusKind } = await import("../../lib/inboxRouting");

const prior = useInboxStore.getState();
let stopTrail: (() => void) | null = null;
afterAll(() => {
  stopTrail?.();
  useInboxStore.setState(prior, true);
  closeDomWindow(dom);
  restoreGlobals();
});

const session = (id: string, title: string): InboxSession =>
  ({ _id: id, session_id: `sess-${id}`, title, updated_at: 1, agent_type: "claude_code", message_count: 1, is_idle: true, has_pending: false }) as InboxSession;

const settle = () => new Promise((r) => setTimeout(r, 0));

// The router: a push moves the active tab, the way the tab shell does.
const push = (path: string) => useInboxStore.getState().updateTab(TAB, { path });

// Every conversation the store made current, in order.
let currents: Array<string | null> = [];
let stopWatch: (() => void) | null = null;

beforeEach(() => {
  stopTrail?.();
  stopWatch?.();
  dom.window.sessionStorage.clear();
  _resetTrailForTests();
  useInboxStore.setState({
    ...useInboxStore.getInitialState(),
    sessions: { [A_ID]: session(A_ID, "Union ship flow fix"), [B_ID]: session(B_ID, "Aesthetics lead") },
    conversations: {},
    currentSessionId: null,
    viewingDismissedId: null,
    showMySessions: false,
    pending: {},
    clientState: {},
    tabs: [{ id: TAB, title: "", path: B, createdAt: 0 }],
    activeTabId: TAB,
  } as any);
  stopTrail = startNavTrail();
  currents = [];
  stopWatch = useInboxStore.subscribe((s, p) => {
    if (s.currentSessionId !== p.currentSessionId) currents.push(s.currentSessionId);
  });
});

// The Back key's own chord on this platform, as a keydown.
function backKey(repeat: boolean): KeyboardEvent {
  const def = shortcutCatalog.shortcuts.find((d) => d.action === "nav.back")!;
  const chord = (shortcutCatalog.isMac ? def.mac ?? def.key : def.key).split("+");
  const key = chord.pop()!;
  return new dom.window.KeyboardEvent("keydown", {
    key: key === "arrowleft" ? "ArrowLeft" : key,
    metaKey: chord.includes("meta"),
    altKey: chord.includes("alt"),
    ctrlKey: chord.includes("ctrl"),
    shiftKey: chord.includes("shift"),
    repeat,
    bubbles: true,
    cancelable: true,
  }) as unknown as KeyboardEvent;
}

function keydownHandler() {
  const dispatcher = new ShortcutDispatcher<string>();
  dispatcher.setContext("desktop", true);
  // The action shortcuts/actions.ts registers for nav.back.
  dispatcher.register("nav.back", () => navBack(push));
  return createKeydownHandler(shortcutCatalog as any, dispatcher, KEY_OWNERSHIP as any);
}

// B, then A in the inbox, then the Line lead's chat opened from the rail.
async function walkToChat(opts: { current: string }) {
  const st = useInboxStore.getState();
  st.navigateToSession(B_ID);
  await settle();
  st.navigateToSession(A_ID);
  push(A);
  await settle();
  push(CHAT);
  await settle();
  if (opts.current !== A_ID) useInboxStore.getState().navigateToSession(opts.current);
  await settle();
  expect(trailOf(TAB).map((e) => e.path)).toEqual([B, A, CHAT]);
  currents = [];
  _resetViewNavForTests();
}

const tabPath = () => useInboxStore.getState().tabs.find((t) => t.id === TAB)!.path;

test("Back held past the key-repeat delay takes one step, not two", async () => {
  await walkToChat({ current: A_ID });
  const handle = keydownHandler();

  // One press: the keydown, then the auto-repeat the held key sends.
  handle(backKey(false));
  await settle();
  expect(tabPath()).toBe(A);
  handle(backKey(true));
  await settle();

  expect(tabPath()).toBe(A);
  expect(useInboxStore.getState().currentSessionId).toBe(A_ID);
  expect(trailOf(TAB).map((e) => e.path)).toEqual([B, A]);
  expect(currents).not.toContain(B_ID);
  // At most the one view change the press asked for (none here: A was
  // already current under the chat), and never a hop on to B.
  expect(getNavLog().filter((e) => e.field === "currentSessionId" && !e.blocked && e.to === B_ID)).toEqual([]);
});

test("arriving at /inbox?s=A with B current makes A current and lit, never B", async () => {
  // The store still points at B (the rail, the recents) while the chat is on
  // screen; Back's arrival names A.
  await walkToChat({ current: B_ID });
  expect(useInboxStore.getState().currentSessionId).toBe(B_ID);

  keydownHandler()(backKey(false));
  await settle();

  const s = useInboxStore.getState();
  expect(tabPath()).toBe(A);
  expect(s.currentSessionId).toBe(A_ID);
  // On the inbox the rail lights the current session (DashboardLayout's
  // sessionListActiveIdOf), so A is the lit row.
  expect(sessionFocusKind("/inbox", s.currentConversation?.source)).toBe("current");
  expect(s.viewingDismissedId ?? s.currentSessionId).toBe(A_ID);
  expect(currents).toEqual([A_ID]);
  const moves = getNavLog().filter((e) => e.field === "currentSessionId" && !e.blocked);
  expect(moves.map((e) => [e.from, e.to])).toEqual([[B_ID, A_ID]]);
});
