// RING LIVES UNDER THE KEY, NEVER BESIDE IT.
//
// The DM header used to show two buttons on the same room: the walkie key
// (one-way, they see your face and hear you) and a Ring button (the same room
// as a two-way huddle, with a ring on their side). A ring is a talk that skips
// the one-way stage, so it is the key's escalation: a right click or a long
// press on the key opens one menu whose one item rings. This file is that
// promise, plus the header rule it serves — one voice control per room.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as React from "react";
import type { PushToTalk } from "../../hooks/useWalkie";

const realWalkieHooks = await import("../../hooks/useWalkie");
const realCallManager = await import("../../lib/calls/callManager");

const ptt: PushToTalk & { presses: number; releases: number } = {
  holding: false,
  live: false,
  dropped: false,
  capturing: false,
  reason: null,
  presses: 0,
  releases: 0,
  press: () => { ptt.presses++; },
  release: () => { ptt.releases++; },
};
const rung: { roomKey: string; toUserIds: string[] }[] = [];

// Faithful stand-ins: the real modules with exactly the exports that would
// open a microphone or a call replaced (see teamBarFace.test for why).
mock.module("../../hooks/useWalkie", () => ({
  ...realWalkieHooks,
  usePushToTalk: () => ptt,
  walkieJoinReason: () => null,
}));
// THE MENU SURFACE, STOOD IN FOR — and only the surface. Radix decides once,
// when its layout-effect shim loads, whether a document exists; in a shared
// test process a neighbouring file loads it before this one has a DOM, and
// after that every Radix portal (the menu's included) stays unmounted for the
// life of the process. A module mock cannot reach a binding Radix already
// captured. So the two primitives the key draws its menu with render inline
// here: the same children, the same select, no portal. What this file proves
// is the key's own wiring — when the menu opens, what it offers, what
// choosing it does, and that the gesture never leaks into a talk.
const realContextMenu = await import("../ui/context-menu");
mock.module("../ui/context-menu", () => ({
  ...realContextMenu,
  ContextMenu: ({ state, children }: any) =>
    state.menu ? React.createElement("div", { role: "menu" }, children(state.menu.payload)) : null,
  CtxItem: ({ children, onSelect, disabled, title }: any) =>
    React.createElement("div", { role: "menuitem", "aria-disabled": disabled || undefined, title, onClick: disabled ? undefined : onSelect }, children),
}));
mock.module("../../lib/calls/callManager", () => ({
  ...realCallManager,
  startHuddle: async (opts: { roomKey: string; toUserIds: string[] }) => { rung.push(opts); },
}));

const DOM_KEYS = [
  "window", "document", "navigator", "HTMLElement", "Element", "Node", "Event",
  "MouseEvent", "PointerEvent", "CustomEvent", "KeyboardEvent", "FocusEvent", "ResizeObserver", "MutationObserver", "getComputedStyle", "requestAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const hadGlobals = new Map<string, { had: boolean; was: unknown }>();
let win: any;

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as any;
  win = dom.window;
  for (const k of DOM_KEYS) hadGlobals.set(k, { had: k in g, was: g[k] });
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.PointerEvent = dom.window.PointerEvent ?? dom.window.MouseEvent;
  // Radix dispatches these from the global scope; bun's own would not be
  // jsdom Events and the document refuses them.
  g.CustomEvent = dom.window.CustomEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.FocusEvent = dom.window.FocusEvent;
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.MutationObserver = dom.window.MutationObserver;
  g.getComputedStyle = dom.window.getComputedStyle;
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 1; };
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  const g = globalThis as any;
  for (const [k, { had, was }] of hadGlobals) {
    if (had) g[k] = was;
    else delete g[k];
  }
});

const ROOM = "dm:u_me:u_ann";

async function mountKey(ring?: { toUserIds: string[] }) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { WalkiePttButton } = await import("../calls/WalkiePtt");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(WalkiePttButton, {
        roomKey: ROOM,
        resolveChannelId: () => "chan",
        label: "Talk",
        size: "sm",
        ring,
      }),
    );
  });
  const key = host.querySelector("button.walkie-ptt") as HTMLElement;
  const fire = async (type: string, init: any = {}) => {
    await act(async () => {
      key.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...init }));
    });
  };
  const menuItem = () =>
    Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) => /Ring/.test(el.textContent ?? "")) as HTMLElement | undefined;
  return {
    key,
    fire,
    menuItem,
    act,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("walkie key: ring under the key", () => {
  test("a right click opens the one-item ring menu, and choosing it rings the room", async () => {
    rung.length = 0;
    const k = await mountKey({ toUserIds: ["u_ann", "u_bob"] });
    expect(k.key.title).toContain("Right click to ring");
    expect(k.menuItem()).toBeUndefined();

    await k.fire("contextmenu");
    const item = k.menuItem();
    expect(item?.textContent).toContain("Ring everyone and start a huddle");

    await k.act(async () => {
      item!.dispatchEvent(new win.MouseEvent("click", { bubbles: true, button: 0 }));
    });
    expect(rung).toEqual([{ roomKey: ROOM, toUserIds: ["u_ann", "u_bob"], anchorTitle: undefined }]);
    // The right click never toggled the talk.
    expect(ptt.presses).toBe(0);
    await k.unmount();
  });

  test("a long press opens the menu and its click is spent — no burst starts", async () => {
    const k = await mountKey({ toUserIds: ["u_ann"] });
    await k.fire("pointerdown");
    await new Promise((r) => setTimeout(r, 560));
    await k.act(async () => {});
    expect(k.menuItem()?.textContent).toContain("Ring them");
    await k.fire("pointerup");
    await k.fire("click");
    expect(ptt.presses).toBe(0);
    await k.unmount();
  });

  test("a plain click still talks, and a key with no ring has no menu", async () => {
    const k = await mountKey();
    expect(k.key.title).not.toContain("Right click");
    await k.fire("contextmenu");
    expect(k.menuItem()).toBeUndefined();
    await k.fire("click");
    expect(ptt.presses).toBe(1);
    await k.unmount();
  });
});

describe("chat header: one voice control per room", () => {
  const page = readFileSync(new URL("../../app/chat/page.tsx", import.meta.url), "utf8");
  const header = page.slice(page.indexOf('className="ch-head"'), page.indexOf("</header>"));

  test("the DM key carries the ring, and the huddle button is a channel's alone", () => {
    expect(header).toMatch(/<WalkiePttButton[\s\S]*?ring=\{\{ toUserIds: activeChannel\.dmMemberIds/);
    // The huddle button renders only where there is no key: never for a DM.
    const huddleAt = header.indexOf("<HuddleButton");
    expect(huddleAt).toBeGreaterThan(-1);
    const guard = header.slice(header.lastIndexOf("{activeChannel", huddleAt), huddleAt);
    expect(guard).toContain('activeChannel.kind !== "dm"');
    expect(header).not.toMatch(/<HuddleButton[\s\S]*?ring=/);
  });
});
