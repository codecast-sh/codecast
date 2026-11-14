// ct-73216: two chat writes the server is guaranteed to refuse reached Sentry
// as "[CONVEX M(dispatch:dispatch)] Server Error".
//  A. A read mark naming a message that is gone or in another room
//     (chat.markRead: INVALID "That message is not in this channel") is
//     bookkeeping nobody asked for: it must not be reported or counted as a
//     failed action.
//  B. The conversation's chat chip must not open a DM in a team whose chat is
//     off (chat.openDm: FORBIDDEN "Team chat is not enabled").
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  FocusEvent: dom.window.FocusEvent,
  MutationObserver: dom.window.MutationObserver,
  NodeFilter: dom.window.NodeFilter,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  SVGElement: dom.window.SVGElement,
  DocumentFragment: dom.window.DocumentFragment,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const reported: unknown[] = [];
const realAnalytics = await import("../analytics");
mock.module("../analytics", () => ({ ...realAnalytics, captureError: (e: unknown) => { reported.push(e); } }));
const realConvexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => null,
  useAction: () => async () => null,
}));

const realComposer = { ...(await import("../../components/chat/ChatComposer")) };
mock.module("../../components/chat/ChatComposer", () => ({ ...realComposer, ChatComposer: () => null }));
const realList = { ...(await import("../../components/chat/ChatMessageList")) };
mock.module("../../components/chat/ChatMessageList", () => ({ ...realList, ChatMessageList: () => null }));

const { applyDispatchFailure } = await import("../dispatchBinding");
const { useInboxStore } = await import("../../store/inboxStore");
const { ConversationChat } = await import("../../components/conversation/ConversationChat");

const store = () => useInboxStore.getState();
const CHANNEL = "c".repeat(32);
const STALE_MARK =
  "[CONVEX M(dispatch:dispatch)] [Request ID: cdae58d900b4b5bf] Server Error\n" +
  "Uncaught ConvexError: Uncaught ConvexError: {\"code\":\"INVALID\",\"message\":\"That message is not in this channel\",\"retryable\":false}\n" +
  "    at chatFail (../../convex/chat.ts:103:4)";

describe("A: a read mark refused for a stale marker", () => {
  beforeEach(() => {
    reported.length = 0;
    store()._setDispatch(async () => null);
  });
  afterEach(() => store()._clearRuntimeBindings());

  test("is neither reported nor counted as a failed action", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = store().dispatchErrors;
      applyDispatchFailure("markChannelRead", new Error(STALE_MARK), [CHANNEL, "m".repeat(32)]);
      expect(reported).toHaveLength(0);
      expect(store().dispatchErrors).toBe(before);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("B: the conversation chat chip", () => {
  const TEAM = "t".repeat(32);
  const ME = "u".repeat(32);
  const PEER = { _id: "p".repeat(32), name: "Pat Peer" } as any;
  let root: Root;
  let opens: unknown[][];
  let realOpen: any;

  const mount = async (chatOn: boolean) => {
    await act(async () => {
      useInboxStore.setState({
        currentUser: { _id: ME, name: "Me" },
        teams: [{ _id: TEAM, name: "Union", features: chatOn ? { chat: true } : {} }],
        clientState: { ...store().clientState, ui: { ...(store().clientState?.ui ?? {}), active_team_id: TEAM } },
        chatChannels: {},
        chatRail: [],
        dispatchOpenDm: (...a: unknown[]) => { opens.push(a); return Promise.resolve(undefined); },
      } as any);
    });
    await act(async () => root.render(<MemoryRouter><ConversationChat conversationId="conv_1" people={[PEER]} /></MemoryRouter>));
  };
  const clickChip = async () => {
    const chip = document.querySelector(".cc-chat-chip");
    if (chip) await act(async () => { chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  };

  beforeEach(() => {
    opens = [];
    realOpen = store().dispatchOpenDm;
    root = createRoot(document.getElementById("root")!);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    useInboxStore.setState({ dispatchOpenDm: realOpen } as any);
  });

  test("opens the DM when the team has chat on", async () => {
    await mount(true);
    await clickChip();
    expect(opens).toHaveLength(1);
  });

  test("never asks the server for a DM when the team's chat is off", async () => {
    await mount(false);
    await clickChip();
    expect(opens).toHaveLength(0);
  });
});
