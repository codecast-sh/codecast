import { afterAll, describe, expect, it, mock } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
// Loaded before the DOM globals: the store boots its cache hydrate when it
// first loads under a window, and that rebinds dispatch under later files.
import { useInboxStore } from "../../store/inboxStore";

// "Talk to the session" on a decision: the session that asked opens in the
// inbox, selected, in the same tick as the click. Nothing waits on the server:
// it only locates the ask's message for the scroll, and the switch never
// waited for that answer. A stashed or dismissed asker comes back into the inbox for good.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/decisions/sd-1", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The server's findAskMessage answers only when the test says so.
let answer: (v: { message_id: string; timestamp: number } | null) => void = () => {};
let fail: (e: Error) => void = () => {};
let asked = 0;
const real = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...real,
  useConvex: () => ({ query: () => { asked++; return new Promise((resolve, reject) => { answer = resolve; fail = reject; }); } }),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const { useJumpToDecisionAsk } = await import("../useJumpToDecisionAsk");

const CONV = "c".repeat(32);
const DECISION = "d".repeat(32);
const prior = useInboxStore.getState();
let jump: (() => Promise<boolean>) | null = null;
let at = "";
function Probe() {
  jump = useJumpToDecisionAsk(CONV, DECISION, "Ship it?");
  const loc = useLocation();
  at = loc.pathname + loc.search;
  return null;
}

afterAll(() => {
  useInboxStore.setState(prior, true);
  dom.window.close();
  restoreGlobals();
});

describe("useJumpToDecisionAsk", () => {
  it("selects the asking session in the inbox before the server answers, restored if it was hidden", async () => {
    useInboxStore.setState({
      tabs: [],
      activeTabId: null,
      sessions: { [CONV]: { _id: CONV, title: "Asker", inbox_dismissed_at: 1_000 } },
      messages: {},
      currentSessionId: null,
      viewingDismissedId: null,
      pendingNavigateId: null,
      pendingScrollToMessageId: null,
    } as any);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<MemoryRouter initialEntries={["/decisions/sd-1"]}><Probe /></MemoryRouter>));

    await act(async () => { void jump!(); });
    const st = useInboxStore.getState();
    expect(st.currentSessionId).toBe(CONV);
    expect(st.viewingDismissedId).toBeNull();
    expect(st.sessions[CONV].inbox_dismissed_at).toBeNull();
    expect(at).toBe(`/inbox?s=${CONV}`);
    expect(st.pendingScrollToMessageId).toBeNull();

    // The server names the ask later; the thread then scrolls to it.
    await act(async () => { answer({ message_id: "m_ask", timestamp: 42 }); });
    expect(useInboxStore.getState().pendingScrollToMessageId).toBe("m_ask");
    expect(useInboxStore.getState().pendingScrollToMessageTimestamp).toBe(42);
    await act(async () => root.unmount());
  });

  it("restores and adopts a killed asker (a finished flow station)", async () => {
    useInboxStore.setState({
      sessions: { [CONV]: { _id: CONV, title: "Station", is_subagent: true, parent_conversation_id: "p".repeat(32), inbox_killed_at: 1_000 } },
      currentSessionId: null,
      viewingDismissedId: null,
      pendingNavigateId: null,
      pendingScrollToMessageId: null,
    } as any);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<MemoryRouter initialEntries={["/decisions/sd-1"]}><Probe /></MemoryRouter>));
    await act(async () => { void jump!(); });
    const st = useInboxStore.getState();
    expect(st.currentSessionId).toBe(CONV);
    expect(st.sessions[CONV].inbox_killed_at).toBeNull();
    // A nested asker is adopted: it stands alone in the inbox from now on.
    expect(st.sessions[CONV].inbox_adopted_at).toBeGreaterThan(0);
    await act(async () => root.unmount());
  });

  // ct-98091: the decision sheet's "asked … ago" line. Wherever the ask is,
  // the thread opens on the asking session, and it scrolls to the ask exactly
  // when one is located.
  const viewing = () => ({
    sessions: { [CONV]: { _id: CONV, title: "Asker" } },
    currentSessionId: null, viewingDismissedId: null, pendingNavigateId: null,
    pendingScrollToMessageId: null, pendingScrollToMessageTimestamp: null,
  });
  async function press(messages: any[] = []) {
    useInboxStore.setState({ ...viewing(), messages: { [CONV]: messages } } as any);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<MemoryRouter initialEntries={["/inbox"]}><Probe /></MemoryRouter>));
    const before = asked;
    let result: Promise<boolean> = Promise.resolve(false);
    await act(async () => { result = jump!(); });
    return { root, result, queried: () => asked > before };
  }

  it("scrolls to the ask in the loaded rows without asking the server", async () => {
    const { root, result, queried } = await press([
      { _id: "m_before", timestamp: 1 },
      { _id: "m_ask", timestamp: 7, tool_calls: [{ id: "t1", name: "Bash", input: `cast decide "Ship it?" ${DECISION}` }] },
    ]);
    expect(await result).toBe(true);
    expect(queried()).toBe(false);
    expect(useInboxStore.getState().currentSessionId).toBe(CONV);
    expect(useInboxStore.getState().pendingScrollToMessageId).toBe("m_ask");
    expect(useInboxStore.getState().pendingScrollToMessageTimestamp).toBe(7);
    await act(async () => root.unmount());
  });

  it("opens the session with no scroll target when the server finds no ask", async () => {
    const { root, result, queried } = await press();
    expect(queried()).toBe(true);
    await act(async () => { answer(null); });
    expect(await result).toBe(true);
    expect(useInboxStore.getState().currentSessionId).toBe(CONV);
    expect(useInboxStore.getState().pendingScrollToMessageId).toBeNull();
    await act(async () => root.unmount());
  });

  it("opens the session with no scroll target when the server lookup fails", async () => {
    const { root, result, queried } = await press();
    expect(queried()).toBe(true);
    await act(async () => { fail(new Error("offline")); });
    expect(await result).toBe(true);
    expect(useInboxStore.getState().currentSessionId).toBe(CONV);
    expect(useInboxStore.getState().pendingScrollToMessageId).toBeNull();
    await act(async () => root.unmount());
  });
});
