// A PERSON IS ONE DOM NODE (pl-756 F2).
//
// That is the whole claim of the row's reorder: if the element Ann's circle
// was drawn in while she was plain presence is the element it is drawn in
// while she is talking to me, linked at the head, and back, then a state
// change IS a change of attribute and a reorder IS a layout animation of
// that one node, and no later refactor can quietly turn either back into a
// remount. The rest follows from it: the FLIP is transform only, 240ms, on
// the seats that moved and no others; a change that moves nobody plays
// nothing; reduced motion plays nothing at all.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import type { FaceEntry, FaceRow as FaceRowModel, Link } from "../../../lib/faces/faceRow";
import type { PushToTalk } from "../../../hooks/useWalkie";
import { MORPH_EASING, MORPH_MS } from "../../calls/useSurfaceMorph";

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
const realChatHooks = await import("../../../hooks/useChatSync");
mock.module("../../../hooks/useChatSync", () => ({ ...realChatHooks, useOpenDm: () => () => {} }));

// ── a browser that can animate ──────────────────────────────────────────────

type FakeAnimation = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; target: Element; cancelled: boolean };
let animations: FakeAnimation[] = [];
let reducedMotion = false;
/** Every seat is a 40px slot in its parent's order: jsdom has no layout, so
 *  the rectangle IS the DOM order, which is what a reorder changes. */
const SLOT = 40;

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
dom.window.matchMedia = ((q: string) => ({
  matches: reducedMotion && q.includes("reduced-motion"),
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as any;
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const parent = this.parentElement;
  const i = parent ? Array.from(parent.children).indexOf(this) : 0;
  const box = { left: i * SLOT, top: 0, width: SLOT, height: SLOT };
  return { ...box, right: box.left + box.width, bottom: box.height, x: box.left, y: 0, toJSON: () => box } as DOMRect;
};
dom.window.Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const anim: any = { keyframes, options, target: this, cancelled: false, cancel() { anim.cancelled = true; }, addEventListener() {}, removeEventListener() {} };
  animations.push(anim);
  return anim;
} as any;

const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { FaceRow, flipKeyframes } = await import("../FaceRow");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// ── rows by hand ────────────────────────────────────────────────────────────

const ME = "u-me";
const ANN = "u-ann";
const BO = "u-bo";

function entry(id: string, name: string, over: Partial<FaceEntry> = {}): FaceEntry {
  return { id, name, me: false, tier: "online", state: "online", level: null, video: null, muted: false, followed: false, joinedAgo: null, unread: 0, ask: 0, ...over };
}
const me = (over: Partial<FaceEntry> = {}) => entry(ME, "Me", { me: true, tier: "me", state: "in-call", ...over });
function rowOf(entries: FaceEntry[], links: Link[] = []): FaceRowModel {
  const mine = entries.find((e) => e.me) ?? null;
  return { entries, links, card: { kind: "none" }, me: mine, room: mine ? "dm:u-ann:u-me" : null };
}
const link = (to: string, kind: Link["kind"]): Link => ({ from: ME, to, kind });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  animations = [];
  reducedMotion = false;
});

async function mount(row: FaceRowModel) {
  host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  const draw = async (r: FaceRowModel) => {
    await act(async () => root!.render(<FaceRow row={r} density="bar" viewerId={ME} />));
  };
  await draw(row);
  return {
    draw,
    seat: (id: string) => host!.querySelector(`[data-face-id="${id}"]`) as HTMLElement,
    circle: (id: string) => host!.querySelector(`[data-face-id="${id}"] .face`) as HTMLElement,
    order: () => Array.from(host!.querySelectorAll("[data-face-id]")).map((s) => (s as HTMLElement).dataset.faceId),
  };
}

/** The FLIP animations, by the seat they played on. */
const played = () =>
  animations.filter((a) => (a.target as HTMLElement).dataset.faceId).map((a) => ({
    id: (a.target as HTMLElement).dataset.faceId!,
    frames: a.keyframes as any[],
    options: a.options,
  }));

// ── the claim ───────────────────────────────────────────────────────────────

describe("a person is one DOM node", () => {
  test("the element Ann's circle was drawn in at rest is the one drawn while she talks to me, linked at the head, and back", async () => {
    const h = await mount(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    const seat = h.seat(ANN);
    const circle = h.circle(ANN);
    expect(circle.getAttribute("data-state")).toBe("online");
    expect(h.order()).toEqual([ANN, BO]);

    // Her burst plays: I appear at the head, she is linked right after me.
    await h.draw(rowOf([me(), entry(ANN, "Ann", { state: "talking-to-me", tier: "linked", level: "voice" }), entry(BO, "Bo")], [link(ANN, "rx")]));
    expect(h.order()).toEqual([ME, ANN, BO]);
    expect(h.seat(ANN)).toBe(seat);
    expect(h.circle(ANN)).toBe(circle);
    expect(circle.getAttribute("data-state")).toBe("talking-to-me");

    // It becomes a call, with her camera on: the same node, now holding video.
    await h.draw(rowOf([me(), entry(ANN, "Ann", { state: "live-with-me", tier: "linked", video: "remote" }), entry(BO, "Bo")], [link(ANN, "call")]));
    expect(h.seat(ANN)).toBe(seat);
    expect(h.circle(ANN)).toBe(circle);
    expect(circle.getAttribute("data-state")).toBe("live-with-me");

    // The room ends: back to presence, still the same node, back in order.
    await h.draw(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    expect(h.order()).toEqual([ANN, BO]);
    expect(h.seat(ANN)).toBe(seat);
    expect(h.circle(ANN)).toBe(circle);
    expect(circle.getAttribute("data-state")).toBe("online");
  });

  test("a reorder is a transform only FLIP, 240ms, on the seats that moved and no others", async () => {
    const h = await mount(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    expect(played()).toEqual([]);
    // Bo talks to me: me at the head, a bridge, Bo, then Ann. Ann was at slot
    // 0 and lands at slot 3; Bo was at slot 1 and lands at slot 2. Me is new
    // and has nowhere to travel from.
    await h.draw(rowOf([me(), entry(BO, "Bo", { state: "talking-to-me", tier: "linked" }), entry(ANN, "Ann")], [link(BO, "rx")]));
    const flips = played();
    expect(flips.map((f) => f.id).sort()).toEqual([ANN, BO].sort());
    for (const f of flips) {
      expect(f.options).toEqual({ duration: MORPH_MS, easing: MORPH_EASING });
      expect(Object.keys(f.frames[0])).toEqual(["transform"]);
      expect(f.frames[1]).toEqual({ transform: "none" });
    }
    expect(flips.find((f) => f.id === ANN)!.frames[0].transform).toBe(`translate(${-3 * SLOT}px, 0px)`);
    expect(flips.find((f) => f.id === BO)!.frames[0].transform).toBe(`translate(${-1 * SLOT}px, 0px)`);
  });

  test("a change that moves nobody plays nothing", async () => {
    const h = await mount(rowOf([me(), entry(ANN, "Ann", { state: "live-with-me", tier: "linked" })], [link(ANN, "call")]));
    animations = [];
    // A mute, a level, a followed band: attributes, not motion.
    await h.draw(rowOf([me({ muted: true, level: "mic" }), entry(ANN, "Ann", { state: "speaking", tier: "linked", level: "voice", followed: true })], [link(ANN, "call")]));
    expect(played()).toEqual([]);
  });

  test("reduced motion is no animation, not a fast one", async () => {
    reducedMotion = true;
    const h = await mount(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    await h.draw(rowOf([me(), entry(BO, "Bo", { state: "talking-to-me", tier: "linked" }), entry(ANN, "Ann")], [link(BO, "rx")]));
    expect(animations.length).toBe(0);
    // And the new order is simply there.
    expect(h.order()).toEqual([ME, BO, ANN]);
  });

  test("an interrupted FLIP is cancelled and continued from where the seat is", async () => {
    const h = await mount(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    await h.draw(rowOf([me(), entry(BO, "Bo", { state: "talking-to-me", tier: "linked" }), entry(ANN, "Ann")], [link(BO, "rx")]));
    const first = played();
    await h.draw(rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]));
    expect(animations.filter((a) => a.cancelled).length).toBe(first.length);
    expect(played().length).toBe(first.length * 2);
  });
});

describe("the geometry", () => {
  test("a seat that did not move has no keyframes at all", () => {
    expect(flipKeyframes({ left: 40, top: 0 }, { left: 40, top: 0 })).toBeNull();
  });
  test("a seat inverts onto where it was and releases", () => {
    expect(flipKeyframes({ left: 0, top: 0 }, { left: 120, top: 8 })).toEqual([
      { transform: "translate(-120px, -8px)" },
      { transform: "none" },
    ]);
  });
});
