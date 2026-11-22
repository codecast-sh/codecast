// The world a face row is drawn in for faceRow.mount.test.tsx: the hooks and
// engines the row talks to, a DOM, rows by hand, and a mount.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, mock } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { withTeamRoster } from "../../../test-helpers/teamRoster";
import type { FaceCard, FaceEntry, FaceRow as FaceRowModel, Link, LinkKind } from "../../../lib/faces/faceRow";
import type { PushToTalk } from "../../../hooks/useWalkie";

// ── the world the row talks to ──────────────────────────────────────────────
//
// A faithful stand in, never a stub: the real hooks/useWalkie with exactly one
// export replaced, the hook that would otherwise open a microphone; and the
// real hooks/useChatSync with the DM's server feeder replaced, so the card
// reads the conversation the test seeds into the store.
const realWalkieHooks = await import("../../../hooks/useWalkie");
export const ptt: PushToTalk = {
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

const realChatSync = await import("../../../hooks/useChatSync");
mock.module("../../../hooks/useChatSync", () => ({ ...realChatSync, useChannelMessagesSync: () => ({}), useThreadSync: () => ({ loading: false, unavailable: false }) }));

// Where the card sent the reader in chat.
export const openedChat: string[] = [];
mock.module("../../../hooks/useOpenDm", () => ({
  useOpenDm: () => () => {},
  useOpenChatPath: () => (path: string) => openedChat.push(path),
}));

// The camera tiles and the walkie's status, as the engine publishes them:
// the same subscribe/snapshot pair, fed by the test instead of LiveKit.
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
let tiles: any[] = [];
export const rungInto: Array<[string, string[]]> = [];
const tileSubs = new Set<() => void>();
export function setTiles(next: any[]) {
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
export function emitWalkie(over: Record<string, unknown>) {
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

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
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
export const { FaceRow, FloatingFaceRow } = await import("../FaceRow");
export const { faceRowSize, floatingRowSize } = await import("../../../lib/faces/layout");
export const { EngagementCard } = await import("../EngagementCard");
export const { walkieStageWords } = await import("../../../hooks/useWalkie");
export const { useInboxStore } = await import("../../../store/inboxStore");
export const { dmKeyFor } = await import("@codecast/shared/chat");
export const { activeTeamIdOf } = await import("../../../lib/activeTeam");
export const faceChat = await import("../../../lib/chat/faceChat");

afterAll(() => {
  mock.module("../../../lib/calls/callManager", () => realCallManager);
  mock.module("../../../lib/calls/walkie", () => realWalkie);
  closeDomWindow(dom);
  restoreGlobals();
});

// ── rows by hand ────────────────────────────────────────────────────────────

export const ME = "u-me";
export const ANN = "u-ann";
export const BO = "u-bo";
export const CY = "u-cy";

export function entry(id: string, name: string, over: Partial<FaceEntry> = {}): FaceEntry {
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
    ...over,
  };
}
export function me(over: Partial<FaceEntry> = {}): FaceEntry {
  return entry(ME, "Me", { me: true, tier: "me", state: "in-call", ...over });
}
export function rowOf(entries: FaceEntry[], links: Link[] = [], card: FaceCard = { kind: "none" }): FaceRowModel {
  const mine = entries.find((e) => e.me) ?? null;
  return { entries, links, card, me: mine, room: mine ? "dm:u-ann:u-me" : null };
}
export const link = (to: string, kind: LinkKind): Link => ({ from: ME, to, kind });

let root: Root | null = null;
let host: HTMLElement | null = null;
// The card reads the person from the roster: seed one for each face by hand.
beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    ...withTeamRoster([
      { _id: ME, name: "Me", presence_state: "active", status: "available" },
      { _id: ANN, name: "Ann", presence_state: "active", github_username: "ann" },
      { _id: BO, name: "Bo", presence_state: "active", github_username: "bo" },
    ], { clientState: useInboxStore.getState().clientState }),
    followLeaderId: null,
  } as any);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  ptt.holding = false;
  setTiles([]);
  walkieOver = {};
});

export async function mount(node: React.ReactNode) {
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

export const bar = (row: FaceRowModel, extra: Record<string, unknown> = {}) => (
  <FaceRow row={row} density="bar" viewerId={ME} {...extra} />
);

/** Unmount the row a test drew, for a test that draws more than one. */
export async function unmountRoot() {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}
