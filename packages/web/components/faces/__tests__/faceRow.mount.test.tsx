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

const realChatHooks = await import("../../../hooks/useChatSync");
let openedDms: string[][] = [];
mock.module("../../../hooks/useChatSync", () => ({
  ...realChatHooks,
  useOpenDm: () => (ids: string[]) => openedDms.push(ids),
}));

// The camera tiles and the walkie's status, as the engine publishes them:
// the same subscribe/snapshot pair, fed by the test instead of LiveKit.
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
let tiles: any[] = [];
const tileSubs = new Set<() => void>();
function setTiles(next: any[]) {
  tiles = next;
  for (const cb of tileSubs) cb();
}
mock.module("../../../lib/calls/callManager", () => ({
  ...realCallManager,
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
const { FaceRow, FloatingFaceRow, faceRowSize } = await import("../FaceRow");
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

describe("one circle, one attribute", () => {
  test("every state the model can hand a face lands on its circle", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann")])));
    for (const state of STATES) {
      await h.draw(bar(rowOf([entry(ANN, "Ann", { state })])));
      const circle = h.circle(ANN);
      expect(circle.getAttribute("data-state")).toBe(state);
      // A plain face wears the presence dot; an engaged face wears a ring instead.
      expect(h.q(`[data-face-id="${ANN}"] .face-pres`) !== null).toBe(PRESENCE.includes(state));
      // Speaking is the call circles' own attribute, so their stylesheet answers.
      expect(circle.getAttribute("data-speaking")).toBe(state === "speaking" ? "true" : null);
    }
    // Away and offline fade the picture the way every roster does.
    await h.draw(bar(rowOf([entry(ANN, "Ann", { state: "away" })])));
    expect(h.circle(ANN).classList.contains("pres-av-away")).toBe(true);
    await h.draw(bar(rowOf([entry(ANN, "Ann", { state: "offline" })])));
    expect(h.circle(ANN).classList.contains("pres-av-offline")).toBe(true);
    await h.draw(bar(rowOf([entry(ANN, "Ann", { state: "online" })])));
    expect(h.circle(ANN).className).toBe("face");
  });

  test("the marks on a person: mute, unread, ask, followed, the join", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann")])));
    expect(h.q(".face-mute")).toBeNull();
    expect(h.q(".face-unread")).toBeNull();
    expect(h.q(".face-ask")).toBeNull();
    await h.draw(
      bar(rowOf([entry(ANN, "Ann", { state: "live-with-me", muted: true, unread: 3, ask: 2, followed: true })])),
    );
    expect(h.q(".face-mute")).not.toBeNull();
    expect(h.q(".face-unread")!.textContent).toBe("3");
    expect(h.q(".face-ask")).not.toBeNull();
    expect(h.q(`[data-face-id="${ANN}"]`)!.getAttribute("data-ask")).toBe("2");
    expect(h.circle(ANN).getAttribute("data-followed")).toBe("true");
    // The join is the ring and the card's words, never a label under the
    // chin: the card in the band would cover it.
    await h.draw(bar(rowOf([entry(ANN, "Ann", { state: "joining" })])));
    expect(h.circle(ANN).getAttribute("data-state")).toBe("joining");
    expect(h.q(".people-face-joined")).toBeNull();
    // In the bar the card carries the name: nothing hangs under the chin
    // that a card could stack on.
    expect(h.q(".face-name")).toBeNull();
  });

  test("my own face sits at the head while I am engaged, and keys nothing", async () => {
    const h = await mount(bar(rowOf([me({ level: "mic" }), entry(ANN, "Ann", { state: "hearing-me" })])));
    const seats = h.all("[data-face-id]");
    expect(seats.map((s) => s.dataset.faceId)).toEqual([ME, ANN]);
    const mine = h.circle(ME);
    expect(mine.getAttribute("data-me")).toBe("1");
    expect(mine.getAttribute("data-level")).toBe("mic");
    expect(mine.getAttribute("aria-label")).toBe("Me (you)");
    expect(mine.getAttribute("data-walkie-state")).toBeNull();
  });

  test("a face with a camera is a video in the same circle; without one, a picture", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann", { state: "live-with-me", image: "https://x/ann.png" })])));
    expect(h.q(`[data-face-id="${ANN}"] video`)).toBeNull();
    expect(h.q(`[data-face-id="${ANN}"] img, [data-face-id="${ANN}"] .face-avatar-fallback`)).not.toBeNull();
    const track = { attached: 0, attach() { this.attached++; }, detach() { this.attached--; } };
    await act(async () => setTiles([{ key: "ann", identity: ANN, name: "Ann", isLocal: false, kind: "camera", track }]));
    await h.draw(bar(rowOf([entry(ANN, "Ann", { state: "live-with-me", video: "remote", image: "https://x/ann.png" })])));
    expect(h.q(`[data-face-id="${ANN}"] video`)).not.toBeNull();
    expect(track.attached).toBe(1);
  });
});

// ── the links ───────────────────────────────────────────────────────────────

describe("the link is how 'I am talking to them' reads", () => {
  test("every link kind is a bridge before the face it points at", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann")])));
    expect(h.q(".face-link")).toBeNull();
    for (const kind of ["tx", "rx", "both", "call", "ring"] as LinkKind[]) {
      await h.draw(bar(rowOf([me(), entry(ANN, "Ann", { state: "hearing-me", tier: "linked" })], [link(ANN, kind)])));
      const bridges = h.all(".face-link");
      expect(bridges.length).toBe(1);
      expect(bridges[0].getAttribute("data-link-kind")).toBe(kind);
      // Between me and them: the bridge is the element right before their seat.
      const seat = h.q(`[data-face-id="${ANN}"]`)!;
      expect(seat.previousElementSibling).toBe(bridges[0]);
      expect(bridges[0].previousElementSibling).toBe(h.q(`[data-face-id="${ME}"]`));
    }
  });

  test("two linked faces chain: me, then each of them behind its own bridge", async () => {
    const h = await mount(
      bar(
        rowOf(
          [
            me(),
            entry(ANN, "Ann", { state: "live-with-me", tier: "linked" }),
            entry(BO, "Bo", { state: "live-with-me", tier: "linked" }),
          ],
          [link(ANN, "call"), link(BO, "call")],
        ),
      ),
    );
    const kids = Array.from(h.q(".face-row")!.children).map((c) => (c as HTMLElement).dataset.faceId ?? "link");
    expect(kids).toEqual([ME, "link", ANN, "link", BO]);
  });

  test("holding the key dims every face but the one I am talking to", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")])));
    expect(h.q(".face-row")!.getAttribute("data-holding")).toBeNull();
    // The walkie's own facts: my key is open into Ann's room.
    ptt.holding = true;
    await act(async () => emitWalkie({ sending: { roomKey: "dm:u-ann:u-me", live: true, heardLive: false } }));
    expect(h.q(".face-row")!.getAttribute("data-holding")).toBe("1");
    expect(h.q(`[data-face-id="${ANN}"]`)!.getAttribute("data-hold")).toBe("1");
    ptt.holding = false;
    await act(async () => emitWalkie({ sending: null }));
    expect(h.q(".face-row")!.getAttribute("data-holding")).toBeNull();
  });
});

// ── the gesture ─────────────────────────────────────────────────────────────

describe("a face opens one card", () => {
  test("a click pins the card with Talk, Huddle and Message; Escape closes it; Message opens the DM", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann")])));
    const circle = h.circle(ANN);
    expect(circle.getAttribute("aria-expanded")).toBe("false");
    await h.click(circle);
    expect(circle.getAttribute("aria-expanded")).toBe("true");
    const card = h.q("[data-member-card]")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Ann");
    const words = h.all(".face-action-word").map((w) => w.textContent);
    expect(words).toEqual(["Talk", "Huddle", "Message"]);
    await act(async () => {
      circle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.q("[data-member-card]")).toBeNull();
    await h.click(circle);
    await h.click(h.all(".face-action").find((b) => b.textContent?.includes("Message"))!);
    expect(openedDms).toEqual([[ANN]]);
    expect(h.q("[data-member-card]")).toBeNull();
  });

  test("calls off: the card still names them and offers Message, and nothing else", async () => {
    const h = await mount(bar(rowOf([entry(ANN, "Ann")]), { callsEnabled: false }));
    const circle = h.circle(ANN);
    expect(circle.getAttribute("aria-expanded")).toBe("false");
    await h.click(circle);
    expect(h.q("[data-member-card]")).not.toBeNull();
    expect(h.all(".face-action-word").map((w) => w.textContent)).toEqual(["Message"]);
  });

  test("my own face opens my card: the status switch, no actions on myself", async () => {
    const h = await mount(bar(rowOf([me()])));
    await h.click(h.circle(ME));
    const card = h.q("[data-member-card]")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("you");
    expect(h.all(".face-card-status").map((b) => b.textContent)).toEqual(["available", "busy", "away"]);
    expect(h.q(".face-action")).toBeNull();
  });
});

// ── the densities ───────────────────────────────────────────────────────────

describe("two densities, one row", () => {
  test("the bar and the float say which they are, and the float sizes its window", async () => {
    const sizes: { width: number; height: number }[] = [];
    const bridge = { setInteractive() {}, setContentSize: (s: { width: number; height: number }) => sizes.push(s), setDragging() {} };
    const row = rowOf([me(), entry(ANN, "Ann", { state: "live-with-me", tier: "linked" })], [link(ANN, "call")]);
    const h = await mount(<FloatingFaceRow row={row} viewerId={ME} bridge={bridge} />);
    expect(h.q(".face-row")!.getAttribute("data-density")).toBe("float");
    expect(sizes[0]).toEqual(faceRowSize("float", 2, 1));
    // Every circle is a hit region the window lifts click through for.
    expect(h.all("[data-face-hit]").length).toBe(2);
    await h.draw(bar(row));
    expect(h.q(".face-row")!.getAttribute("data-density")).toBe("bar");
  });

  test("the float's controls: a grip that moves the window, Open for a call, and a way to put it away, only while the pointer is in", async () => {
    const drags: boolean[] = [];
    const bridge = { setInteractive() {}, setContentSize() {}, setDragging: (on: boolean) => drags.push(on) };
    const row = rowOf([me(), entry(ANN, "Ann", { state: "live-with-me", tier: "linked" })], [link(ANN, "call")]);
    let closed = 0;
    let opened = 0;
    const chrome = { inCall: true, onExpand: () => opened++, onClose: () => closed++, closeWord: "Hide", closeTitle: "Hide the faces" };
    // jsdom has no pointer capture; the grip's own calls are no-ops here.
    const proto = dom.window.HTMLElement.prototype as any;
    proto.setPointerCapture ??= () => {};
    proto.releasePointerCapture ??= () => {};
    proto.hasPointerCapture ??= () => false;
    const Pointer = (dom.window as any).PointerEvent ?? dom.window.MouseEvent;
    const h = await mount(<FloatingFaceRow row={row} viewerId={ME} bridge={bridge} chrome={chrome} />);
    // Away from the pointer the window is only its faces: no card, no controls.
    expect(h.q(".face-row-chrome")).toBeNull();
    expect(h.q(".face-row-below")).toBeNull();
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    });
    const bar = h.q(".face-row-chrome")!;
    expect(bar).not.toBeNull();
    // The controls are the footer of the one card under the row, which
    // leads with a legend until a face is pointed at.
    expect(bar.closest(".face-row-below")).not.toBeNull();
    expect(h.q(".face-row-below .face-row-legend")).not.toBeNull();
    expect(bar.getAttribute("data-chrome-hit")).not.toBeNull();
    expect(h.all(".face-row-chrome .faces-btn-word").map((w) => w.textContent)).toEqual(["Move", "Open", "Hide"]);
    // The grip: held, the window follows the cursor.
    const grip = h.q('[data-chrome-btn="move"]')!;
    await act(async () => {
      grip.dispatchEvent(new Pointer("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    });
    expect(drags).toEqual([true]);
    await act(async () => {
      grip.dispatchEvent(new Pointer("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
    });
    expect(drags).toEqual([true, false]);
    await h.click(h.q('[data-chrome-btn="open"]')!);
    expect(opened).toBe(1);
    await h.click(h.q('[data-chrome-btn="close"]')!);
    expect(closed).toBe(1);
    // No call: nothing to open, the grip and the way out stay.
    await h.draw(<FloatingFaceRow row={rowOf([entry(ANN, "Ann")])} viewerId={ME} bridge={bridge} chrome={{ ...chrome, inCall: false, closeWord: "Close" }} />);
    expect(h.all(".face-row-chrome .faces-btn-word").map((w) => w.textContent)).toEqual(["Move", "Close"]);
  });
});

// ── the card ────────────────────────────────────────────────────────────────

type Pressed = { action: string; card: FaceCard };

function actionsInto(log: Pressed[]) {
  const on = (action: string) => (card: FaceCard) => log.push({ action, card });
  return {
    join: on("join"),
    snooze: on("snooze"),
    end: on("end"),
    mute: on("mute"),
    camera: on("camera"),
    answer: on("answer"),
    decline: on("decline"),
    cancel: on("cancel"),
  };
}

const ROOM = "dm:u-ann:u-me";
const incomingWords = walkieStageWords({
  sending: null,
  incoming: true,
  locked: false,
  muted: false,
  dropped: false,
  micDenied: false,
  name: "Ann",
});
const talkingWords = walkieStageWords({
  sending: { live: true, heardLive: true },
  incoming: false,
  locked: false,
  muted: false,
  dropped: false,
  micDenied: false,
  name: "Ann",
});

describe("the engagement card renders the model's card", () => {
  test("none renders nothing", async () => {
    const h = await mount(<EngagementCard card={{ kind: "none" }} density="bar" />);
    expect(h.q(".engagement-card")).toBeNull();
  });

  test("incoming: the live words, talk back, join live and snooze", async () => {
    const log: Pressed[] = [];
    const card: FaceCard = { kind: "incoming", roomKey: ROOM, from: ANN, name: "Ann", reply: true, join: true, snooze: true, words: incomingWords };
    const h = await mount(<EngagementCard card={card} density="bar" actions={actionsInto(log)} />);
    const el = h.q(".engagement-card")!;
    expect(el.getAttribute("data-card")).toBe("incoming");
    expect(el.getAttribute("data-density")).toBe("bar");
    expect(el.classList.contains("walkie-strip-rx")).toBe(true);
    expect(h.q(".walkie-stage-badge")).toBeNull();
    expect(h.q(".walkie-stage")!.textContent).toBe("Ann is talking to you");
    expect(h.q(".walkie-key")).not.toBeNull();
    await h.click(h.q('[data-card-action="join"]')!);
    await h.click(h.q('[data-card-action="snooze"]')!);
    expect(log.map((p) => p.action)).toEqual(["join", "snooze"]);
    expect(log[0].card).toBe(card);
    // The line is still open but nobody can answer: no key, no join.
    await h.draw(<EngagementCard card={{ ...card, reply: false, join: false, snooze: false }} density="bar" actions={actionsInto(log)} />);
    expect(h.q(".walkie-key")).toBeNull();
    expect(h.q('[data-card-action="join"]')).toBeNull();
    expect(h.q('[data-card-action="snooze"]')).toBeNull();
  });

  test("live: end and mute, the stage words while the walkie holds the room, and who hears me", async () => {
    const log: Pressed[] = [];
    const card: FaceCard = {
      kind: "live",
      roomKey: ROOM,
      title: "Ann",
      end: true,
      mute: false,
      muted: false,
      words: talkingWords,
      hearing: { state: "hears", text: "Ann hears you" },
    };
    const h = await mount(<EngagementCard card={card} density="float" actions={actionsInto(log)} />);
    const el = h.q(".engagement-card")!;
    expect(el.getAttribute("data-density")).toBe("float");
    expect(el.classList.contains("walkie-strip-tx")).toBe(true);
    expect(h.q(".walkie-stage-badge")!.textContent).toBe("Talking");
    expect(h.q(".walkie-stage-with")!.textContent).toBe(" with Ann");
    // The roster's fact rides the same line after the stage: one sentence,
    // "Talking with Ann · Ann hears you", and no caption plate under it.
    expect(h.q(".walkie-stage")!.textContent).toBe("Talking with Ann · Ann hears you");
    expect(h.q(".walkie-strip-hint")).toBeNull();
    expect(h.q('[data-card-action="mute"]')).toBeNull();
    await h.click(h.q('[data-card-action="end"]')!);
    expect(log.map((p) => p.action)).toEqual(["end"]);

    // A huddle: no walkie words, the room's name, and a mute that toggles.
    const huddle: FaceCard = { kind: "live", roomKey: ROOM, title: "Ann", end: true, mute: true, muted: true, camera: true, cameraOn: false, words: null, hearing: null };
    await h.draw(<EngagementCard card={huddle} density="float" actions={actionsInto(log)} />);
    expect(h.q(".walkie-stage-badge")).toBeNull();
    expect(h.q(".engagement-card-title")!.textContent).toBe("Ann");
    const mute = h.q('[data-card-action="mute"]')!;
    expect(mute.getAttribute("aria-label")).toBe("Unmute");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    // The camera switch beside it, off in this card.
    expect(h.q('[data-card-action="camera"]')!.getAttribute("aria-pressed")).toBe("false");
    await h.click(h.q('[data-card-action="camera"]')!);
    expect(log.at(-1)).toMatchObject({ action: "camera", card: huddle });
    await h.click(mute);
    expect(log.at(-1)).toMatchObject({ action: "mute", card: huddle });
  });

  test("joined notice: the sentence, with the live controls under it", async () => {
    const log: Pressed[] = [];
    const card: FaceCard = { kind: "joined-notice", roomKey: ROOM, text: "Ann joined", end: true, mute: true, muted: false };
    const h = await mount(<EngagementCard card={card} density="bar" actions={actionsInto(log)} />);
    expect(h.q(".engagement-card")!.classList.contains("walkie-strip-joined")).toBe(true);
    expect(h.q('[role="status"]')!.textContent).toBe("Ann joined");
    expect(h.q('[data-card-action="mute"]')!.getAttribute("aria-label")).toBe("Mute");
    await h.click(h.q('[data-card-action="end"]')!);
    expect(log[0]).toMatchObject({ action: "end", card });
  });

  test("ring in: answer and decline", async () => {
    const log: Pressed[] = [];
    const card: FaceCard = { kind: "ring-in", roomKey: ROOM, from: ANN, name: "Ann", answer: true, decline: true };
    const h = await mount(<EngagementCard card={card} density="bar" actions={actionsInto(log)} />);
    expect(h.q(".engagement-card-title")!.textContent).toBe("Ann");
    expect(h.q(".ring-card-line")!.textContent).toBe("Ann is calling");
    await h.click(h.q('[data-card-action="answer"]')!);
    await h.click(h.q('[data-card-action="decline"]')!);
    expect(log.map((p) => p.action)).toEqual(["answer", "decline"]);
  });

  test("ring out: the status and a cancel", async () => {
    const log: Pressed[] = [];
    const card: FaceCard = { kind: "ring-out", roomKey: ROOM, to: ANN, name: "Ann", cancel: true, status: "ringing" };
    const h = await mount(<EngagementCard card={card} density="bar" actions={actionsInto(log)} />);
    expect(h.q(".ring-card-line")!.textContent).toBe("Ringing Ann");
    await h.click(h.q('[data-card-action="cancel"]')!);
    expect(log[0]).toMatchObject({ action: "cancel", card });
  });

  test("the card hangs under the row it is given to", async () => {
    const card: FaceCard = { kind: "ring-out", roomKey: ROOM, to: ANN, name: "Ann", cancel: true, status: "ringing" };
    const row = rowOf([me({ state: "ringing-them" }), entry(ANN, "Ann", { state: "ringing-them", tier: "linked" })], [link(ANN, "ring")]);
    const h = await mount(
      <FaceRow row={row} density="bar" viewerId={ME}>
        <EngagementCard card={card} density="bar" />
      </FaceRow>,
    );
    expect(h.q(".face-row > .face-row-strip > .engagement-card")).not.toBeNull();
    // Beside the faces, never under them: under a face is that face's card.
    expect(h.q(".face-row-below")).toBeNull();
  });
});
