// ct-73216: two chat writes the server is guaranteed to refuse reached Sentry
// as "[CONVEX M(dispatch:dispatch)] Server Error".
//  A. A read mark naming a message that is gone or in another room
//     (chat.markRead: INVALID "That message is not in this channel") is
//     bookkeeping nobody asked for: it must not be reported or counted as a
//     failed action.
//  B. No surface opens a DM in a team whose chat is off (chat.openDm:
//     FORBIDDEN "Team chat is not enabled"): the conversation chip is not
//     drawn, and openDmChannel itself, which every DM surface goes through,
//     paints no stub and dispatches nothing.
//  C. The refusals that still arrive (a stale client, an older server) are
//     handled quietly; any other permanent refusal is still reported.
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

const reported: { error: unknown; ctx: any }[] = [];
const realAnalytics = await import("../analytics");
mock.module("../analytics", () => ({ ...realAnalytics, captureError: (error: unknown, ctx: any) => { reported.push({ error, ctx }); } }));
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

const { toast } = await import("sonner");

const store = () => useInboxStore.getState();
const CHANNEL = "c".repeat(32);
const refusal = (code: string, message: string) => new Error(
  "[CONVEX M(dispatch:dispatch)] [Request ID: cdae58d900b4b5bf] Server Error\n" +
  `Uncaught ConvexError: Uncaught ConvexError: ${JSON.stringify({ code, message, retryable: false })}\n` +
  "    at chatFail (../../convex/chat.ts:103:4)");
const STALE_MARK = refusal("INVALID", "That message is not in this channel").message;
const CHAT_OFF = "Team chat is not enabled for this team. A team admin can turn it on under Settings → Team.";

const quietly = (fn: () => void) => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try { fn(); } finally { err.mockRestore(); warn.mockRestore(); }
};

describe("A: a read mark refused for a stale marker", () => {
  beforeEach(() => {
    reported.length = 0;
    store()._setDispatch(async () => null);
  });
  afterEach(() => store()._clearRuntimeBindings());

  test("is neither reported nor counted as a failed action", () => {
    const before = store().dispatchErrors;
    quietly(() => applyDispatchFailure("markChannelRead", new Error(STALE_MARK), [CHANNEL, "m".repeat(32)]));
    expect(reported).toHaveLength(0);
    expect(store().dispatchErrors).toBe(before);
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
    expect(Object.keys(store().chatChannels)).toHaveLength(0);
  });
});

describe("B: openDmChannel, the one door every DM surface uses", () => {
  const TEAM = "t".repeat(32);
  const PEER = "p".repeat(32);
  let opens: unknown[][];
  let realOpen: any;
  const setTeams = (teams: any[]) => useInboxStore.setState({
    currentUser: { _id: "u".repeat(32), name: "Me" },
    teams,
    clientState: { ...store().clientState, ui: { ...(store().clientState?.ui ?? {}), active_team_id: TEAM } },
    chatChannels: {},
    chatReads: {},
    dispatchOpenDm: (...a: unknown[]) => { opens.push(a); return Promise.resolve(undefined); },
  } as any);

  beforeEach(() => { opens = []; realOpen = store().dispatchOpenDm; });
  afterEach(() => useInboxStore.setState({ dispatchOpenDm: realOpen } as any));

  test("opens nothing for a team whose chat is off", () => {
    setTeams([{ _id: TEAM, name: "Union", features: {} }]);
    expect(store().openDmChannel([PEER])).toBeNull();
    expect(opens).toHaveLength(0);
    expect(Object.keys(store().chatChannels)).toHaveLength(0);
  });

  test("opens the DM for a team with chat on", () => {
    setTeams([{ _id: TEAM, name: "Union", features: { chat: true } }]);
    expect(store().openDmChannel([PEER])).toBeString();
    expect(opens).toHaveLength(1);
  });

  test("a team list not loaded yet does not block the DM", () => {
    setTeams([]);
    expect(store().openDmChannel([PEER])).toBeString();
    expect(opens).toHaveLength(1);
  });
});

describe("C: refusals that still arrive", () => {
  let toasts: ReturnType<typeof spyOn>;
  beforeEach(() => {
    reported.length = 0;
    store()._setDispatch(async () => null);
    toasts = spyOn(toast, "error").mockImplementation(() => "" as any);
  });
  afterEach(() => {
    toasts.mockRestore();
    store()._clearRuntimeBindings();
  });

  const expectQuiet = (action: string, error: Error, args: unknown[]) => {
    const before = store().dispatchErrors;
    quietly(() => applyDispatchFailure(action, error, args));
    expect(reported).toHaveLength(0);
    expect(store().dispatchErrors).toBe(before);
    expect(toasts).not.toHaveBeenCalled();
  };

  test("markChannelRead: a room gone is retired, not reported", () => {
    useInboxStore.setState({ chatChannels: { [CHANNEL]: { _id: CHANNEL, name: "gone" } } } as any);
    expectQuiet("markChannelRead", refusal("NOT_FOUND", "Channel not found"), [CHANNEL]);
    expect(store().chatChannels[CHANNEL]).toBeUndefined();
  });

  test("markChannelRead: a stale marker is dropped, not reported", () => {
    expectQuiet("markChannelRead", refusal("INVALID", "That message is not in this channel"), [CHANNEL, "m".repeat(32)]);
  });

  test("dispatchOpenDm in a chat-off team removes its stub and is not reported", () => {
    const stub = "chatstub-1";
    useInboxStore.setState({
      chatChannels: { [stub]: { _id: stub, client_id: stub, name: "", kind: "dm" } },
      chatReads: { r1: { _id: "r1", channel_id: stub } },
    } as any);
    expectQuiet("dispatchOpenDm", refusal("FORBIDDEN", CHAT_OFF), [stub, ["p".repeat(32)], "t".repeat(32)]);
    expect(store().chatChannels[stub]).toBeUndefined();
    expect(Object.values(store().chatReads).some((r: any) => r.channel_id === stub)).toBe(false);
  });

  test.each([
    ["sendChatMessage", refusal("FORBIDDEN", CHAT_OFF), [CHANNEL, "hi"]],
    ["addWait", refusal("INVALID", "That message is not in this channel"), ["task_1", { id: "w1" }]],
    ["dispatchOpenDm", refusal("FORBIDDEN", "Not a member of that team"), ["chatstub-2", ["p".repeat(32)]]],
  ] as const)("any other refusal (%s) is still reported and counted", (action, error, args) => {
    const before = store().dispatchErrors;
    quietly(() => applyDispatchFailure(action, error, [...args]));
    expect(reported).toHaveLength(1);
    expect(reported[0].ctx).toMatchObject({ source: "dispatch", action });
    expect(store().dispatchErrors).toBe(before + 1);
  });
});
