// THE ROW DRAWS THE MODEL, AND NOTHING ELSE (pl-756 F2).
//
// Every state the model can hand a face lands on the circle as one attribute;
// every link kind is a bridge before the face it points at; my own face sits
// at the head while I am engaged; a click opens the three actions; and the
// engagement card renders each of the model's cards with the buttons the model
// said it has, each handing the card back to its action. Built on hand made
// rows so what is under test is the drawing, never the derivation.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import type { FaceCard, FaceEntry, FaceRow as FaceRowModel, FaceState, Link, LinkKind } from "../../../lib/faces/faceRow";
import type { PushToTalk } from "../../../hooks/useWalkie";

// ── the world the row talks to ──────────────────────────────────────────────
//
// A faithful stand in, never a stub: the real hooks/useWalkie with exactly one
// export replaced, the hook that would otherwise open a microphone; and the
// real hooks/useChatSync with the DM opener replaced, so a Message press is
// counted rather than routed.
const realWalkieHooks = await import("../../../hooks/useWalkie");
const ptt: PushToTalk = {
  holding: false,
  locked: false,
  live: false,
  dropped: false,
  capturing: false,
  reason: null,
  press: () => {},
  release: () => {},
};
mock.module("../../../hooks/useWalkie", () => ({ ...realWalkieHooks, usePushToTalk: () => ptt }));

// The card's session lookups: a router context and a server query.
const realOpenSession = await import("../../../hooks/useOpenSession");
mock.module("../../../hooks/useOpenSession", () => ({ ...realOpenSession, useOpenSession: () => () => {} }));
const realMissingRow = await import("../../../hooks/useMissingSessionRow");
mock.module("../../../hooks/useMissingSessionRow", () => ({ ...realMissingRow, useMissingSessionRow: () => null }));

let openedDms: string[][] = [];
mock.module("../../../hooks/useOpenDm", () => ({
  useOpenDm: () => (ids: string[]) => openedDms.push(ids),
  useOpenChatPath: () => () => {},
}));

// The camera tiles and the walkie's status, as the engine publishes them:
// the same subscribe/snapshot pair, fed by the test instead of LiveKit.
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
let tiles: any[] = [];
const rungInto: Array<[string, string[]]> = [];
const tileSubs = new Set<() => void>();
function setTiles(next: any[]) {
  tiles = next;
  for (const cb of tileSubs) cb();
}
mock.module("../../../lib/calls/callManager", () => ({
  ...realCallManager,
  ringInto: async (roomKey: string, ids: string[]) => {
    rungInto.push([roomKey, ids]);
    return [];
  },
  getCallTiles: () => tiles,
  subscribeCallTiles: (cb: () => void) => {
    tileSubs.add(cb);
    return () => tileSubs.delete(cb);
  },
}));

const realWalkie = { ...(await import("../../../lib/calls/walkie")) };
let walkieOver: Record<string, unknown> = {};
const walkieSubs = new Set<() => void>();
function emitWalkie(over: Record<string, unknown>) {
  walkieOver = over;
  for (const cb of walkieSubs) cb();
}
mock.module("../../../lib/calls/walkie", () => ({
  ...realWalkie,
  getWalkieStatus: () => ({ ...realWalkie.getWalkieStatus(), ...walkieOver }),
  subscribeWalkie: (cb: () => void) => {
    walkieSubs.add(cb);
    return () => walkieSubs.delete(cb);
  },
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  // The crop loop and the float's hit measure both ask for a frame.
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FaceRow, FloatingFaceRow } = await import("../FaceRow");
const { faceRowSize, floatingRowSize } = await import("../../../lib/faces/layout");
const { EngagementCard } = await import("../EngagementCard");
const { walkieStageWords } = await import("../../../hooks/useWalkie");
const { useInboxStore } = await import("../../../store/inboxStore");

afterAll(() => {
  mock.module("../../../lib/calls/callManager", () => realCallManager);
  mock.module("../../../lib/calls/walkie", () => realWalkie);
  closeDomWindow(dom);
  restoreGlobals();
});

// ── rows by hand ────────────────────────────────────────────────────────────

const ME = "u-me";
const ANN = "u-ann";
const BO = "u-bo";
const CY = "u-cy";

function entry(id: string, name: string, over: Partial<FaceEntry> = {}): FaceEntry {
  return {
    id,
    name,
    image: undefined,
    me: false,
    tier: "online",
    state: "online",
    level: null,
    video: null,
    muted: false,
    followed: false,
    joinedAgo: null,
    unread: 0,
    ask: 0,
    ...over,
  };
}
function me(over: Partial<FaceEntry> = {}): FaceEntry {
  return entry(ME, "Me", { me: true, tier: "me", state: "in-call", ...over });
}
function rowOf(entries: FaceEntry[], links: Link[] = [], card: FaceCard = { kind: "none" }): FaceRowModel {
  const mine = entries.find((e) => e.me) ?? null;
  return { entries, links, card, me: mine, room: mine ? "dm:u-ann:u-me" : null };
}
const link = (to: string, kind: LinkKind): Link => ({ from: ME, to, kind });

let root: Root | null = null;
let host: HTMLElement | null = null;
// The card reads the person from the roster: seed one for each face by hand.
beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    teamMembers: [
      { _id: ME, name: "Me", presence_state: "active", status: "available" },
      { _id: ANN, name: "Ann", presence_state: "active", github_username: "ann" },
      { _id: BO, name: "Bo", presence_state: "active", github_username: "bo" },
    ],
    followLeaderId: null,
  } as any);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  openedDms = [];
  ptt.holding = false;
  setTiles([]);
  walkieOver = {};
});

async function mount(node: React.ReactNode) {
  host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(node));
  return {
    draw: async (next: React.ReactNode) => {
      await act(async () => root!.render(next));
    },
    q: <T extends Element = HTMLElement>(sel: string) => host!.querySelector(sel) as T | null,
    all: (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[],
    circle: (id: string) => host!.querySelector(`[data-face-id="${id}"] .face`) as HTMLElement,
    click: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
  };
}

const bar = (row: FaceRowModel, extra: Record<string, unknown> = {}) => (
  <FaceRow row={row} density="bar" viewerId={ME} {...extra} />
);

// ── every state ─────────────────────────────────────────────────────────────

const STATES: FaceState[] = [
  "offline",
  "away",
  "idle",
  "online",
  "busy",
  "in-call",
  "speaking",
  "ringing-them",
  "ringing-me",
  "talking-to-me",
  "hearing-me",
  "live-with-me",
  "joining",
];
const PRESENCE: FaceState[] = ["offline", "away", "idle", "online", "busy"];
const fc = await import("../../../lib/chat/faceChat");
test("hover flicker", async () => {
  const unreg = fc.registerFaceChatLayer({ canShow: () => true });
  fc.deliverChatToFace(ANN, { messageId: "m1", channelId: "c1", channelName: "team", isDm: false, preview: "hello there", at: Date.now(), loud: false, count: 1 }, () => {});
  fc.faceBubbleShown(fc.getFaceChat().bubble!.key);
  fc.retractFaceBubble();
  await new Promise((r) => setTimeout(r, 400));
  const h = await mount(bar(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")])));
  const log: string[] = [];
  const obs = new dom.window.MutationObserver(() => {
    const k = `${!!h.q("[data-member-card]")}/${!!h.q(".fc-card-msgs")}`;
    if (log[log.length - 1] !== k) log.push(k);
  });
  obs.observe(host!, { subtree: true, childList: true });
  const seat = h.q(`[data-face-id="${ANN}"]`)!;
  await act(async () => {
    seat.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: dom.window.document.body }));
  });
  for (let i = 0; i < 15; i++) { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); console.log("t", i, log.join(" ")); }
  const mv = async (from: Element, to: Element, label: string) => {
    await act(async () => {
      from.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
      to.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: from }));
    });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    console.log("after", label, log.join(" "));
  };
  const card = h.q("[data-member-card]")!;
  await mv(seat, card, "seat->card");
  const msg = h.q(".fc-msg")!;
  await mv(card, msg, "card->msg");
  const input = h.q(".fc-reply input")!;
  await mv(msg, input, "msg->input");
  await mv(input, seat, "input->seat");
  console.log("LOG", log, "panel", JSON.stringify(fc.getFaceChat().panel), "unseen", JSON.stringify(fc.getFaceChat().unseen));
  unreg();
}, 60000);
