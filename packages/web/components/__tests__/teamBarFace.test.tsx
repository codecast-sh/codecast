// THE FACE IN THE AVATAR BAR IS A WALKIE KEY.
//
// The founder's complaint was that the walkie in the shell's team strip lived
// inside a hover card that only appears after a pointer dwells for 120ms — "i
// don't want a little mic in the dropdown here". The face is the key now, the
// same key the people wall has, and these are the two halves of that promise:
// the gesture (hold talks, a tap opens the conversation, and a tap can never
// leave a burst behind) and the flow the bar shows while it happens.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { dmRoomKey } from "@codecast/shared/contracts";
import { MIN_BURST_MS } from "../../lib/calls/walkie";
import { WALL_TAP_MS } from "../people/peopleWallLayout";
import { teamBarSig } from "../presence/memberPresence";
import { walkieFacesSig } from "../presence/useFaceKey";
import type { PushToTalk } from "../../hooks/useWalkie";

// ── the world the face talks to ─────────────────────────────────────────────
//
// A FAITHFUL STAND-IN, never a stub: `mock.module` replaces a module for the
// whole test process and bun loads every test file before running any of them,
// so a partial replacement of a widely imported module breaks other files'
// tests. This spreads the real hooks/useWalkie and overrides exactly one
// export — the hook that would otherwise open a microphone. `pttHoldProps`,
// `walkieKeyState` and `isWalkieHoldKey` stay real, which is the point: the
// composition under test is the shipped one.

const realWalkieHooks = await import("../../hooks/useWalkie");

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
/** Every room the face asked to key, in order. */
let keyedRooms: string[] = [];

mock.module("../../hooks/useWalkie", () => ({
  ...realWalkieHooks,
  usePushToTalk: (roomKey: string | undefined) => {
    keyedRooms.push(roomKey ?? "");
    return ptt;
  },
}));

const nav = { pushed: [] as string[] };
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (p: string) => nav.pushed.push(p) }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

let openedDms: string[][] = [];
mock.module("../../hooks/useChatSync", () => ({
  useOpenDm: () => (ids: string[]) => openedDms.push(ids),
}));

const { pttHoldProps, isWalkieHoldKey } = realWalkieHooks;
const { faceKeyHandlers, JOINED_MS } = await import("../presence/useFaceKey");

// ── the gesture, driven directly ────────────────────────────────────────────

function handlers(onTap: () => void) {
  let downAt = 0;
  return faceKeyHandlers(pttHoldProps(ptt), {
    begin: () => { downAt = performance.now(); },
    finish: () => {
      if (performance.now() - downAt < WALL_TAP_MS) onTap();
    },
  });
}

describe("the face is the key", () => {
  test("a press keys the mic and a release under the tap window opens the conversation", () => {
    let taps = 0;
    const h = handlers(() => { taps++; });
    const before = ptt.presses;
    h.onPointerDown({ button: 0, preventDefault: () => {} } as any);
    h.onPointerUp();
    expect(ptt.presses).toBe(before + 1);
    expect(taps).toBe(1);
  });

  test("a tap can never land a burst — the engine's floor is above the tap window", () => {
    // The two numbers are load-bearing together: a press opens the microphone
    // immediately (waiting 300ms to find out what somebody meant would eat the
    // first word of every sentence), and every gesture short enough to be a tap
    // is a gesture the engine throws away.
    expect(WALL_TAP_MS).toBeLessThan(MIN_BURST_MS);
  });

  test("a hold past the tap window is a hold, not a click", async () => {
    let taps = 0;
    const h = handlers(() => { taps++; });
    h.onPointerDown({ button: 0, preventDefault: () => {} } as any);
    await Bun.sleep(WALL_TAP_MS + 30);
    h.onPointerUp();
    expect(taps).toBe(0);
    expect(ptt.releases).toBeGreaterThan(0);
  });

  test("the keyboard holds the same key, and Tab is not a press", () => {
    let taps = 0;
    const h = handlers(() => { taps++; });
    const before = ptt.presses;
    h.onKeyDown({ key: " ", repeat: false, preventDefault: () => {} } as any);
    h.onKeyUp({ key: " " } as any);
    expect(ptt.presses).toBe(before + 1);
    expect(taps).toBe(1);
    // Tab times no press, so its keyup must not open a DM on the way past.
    h.onKeyUp({ key: "Tab" } as any);
    expect(taps).toBe(1);
    expect(isWalkieHoldKey("Tab")).toBe(false);
  });

  test("a pointer crossing a face does not open its microphone; focus does", () => {
    const h = handlers(() => {});
    // Six faces sit in the shell's top bar and a mouse on its way anywhere
    // sweeps them. Warming on hover would light the browser's recording
    // indicator because somebody moved a pointer. Tabbing onto one is
    // deliberate in a way that passing over it is not.
    expect(h.onPointerEnter).toBeUndefined();
    expect(typeof h.onFocus).toBe("function");
  });
});

// ── the flow the bar shows ──────────────────────────────────────────────────

// A REAL DOM, because the gesture is the thing under test: React attaches its
// listeners to a root and a hold is four events landing on one element.
//
// Handed back afterwards, every key of it. Bun runs all test files in one
// process, and a stray `document` global makes react-dom/server take its
// browser path in the files that come after — which is how a leak here fails a
// diff-rendering test three files down the alphabet.
const DOM_KEYS = [
  "window", "document", "navigator", "HTMLElement", "Element", "Node", "Event",
  "MouseEvent", "IS_REACT_ACT_ENVIRONMENT",
] as const;
const hadGlobals = new Map<string, { had: boolean; was: unknown }>();

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as any;
  for (const k of DOM_KEYS) hadGlobals.set(k, { had: k in g, was: g[k] });
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.MouseEvent = dom.window.MouseEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  const g = globalThis as any;
  for (const [k, { had, was }] of hadGlobals) {
    if (had) g[k] = was;
    else delete g[k];
  }
});

const VIEWER = "u_me";
const MEMBER = { _id: "u_ann", name: "Ann Diaz", presence_state: "active" as const };
const ROOM = dmRoomKey(VIEWER, String(MEMBER._id));

type Faces = { talkingId: string; sendingRoomKey: string; joinedRoom: string };
const idle: Faces = { talkingId: "", sendingRoomKey: "", joinedRoom: "" };

async function mountFace(faces: Faces = idle, member: any = MEMBER) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { TeamBarFace } = await import("../presence/TeamBarFace");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const draw = async (f: Faces, m: any = member) => {
    await act(async () => {
      root.render(
        React.createElement(TeamBarFace, {
          member: m,
          viewerId: VIEWER,
          callsEnabled: true,
          selected: false,
          faces: f,
          card: null,
          onHoverEnter: () => {},
          onHoverLeave: () => {},
          onContextMenu: () => {},
        }),
      );
    });
  };
  await draw(faces);
  return {
    draw,
    key: () => host.querySelector("button.people-face") as HTMLElement,
    html: () => host.innerHTML,
    act,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("the bar shows the flow", () => {
  test("the face keys the DM room with this person, and nobody else's", async () => {
    keyedRooms = [];
    const f = await mountFace();
    expect(keyedRooms[0]).toBe(ROOM);
    expect(f.key().getAttribute("title")).toBe(`Hold to talk to Ann Diaz · click to open the DM`);
    expect(f.key().getAttribute("data-tx")).toBeNull();
    expect(f.key().getAttribute("data-rx")).toBeNull();
    await f.unmount();
  });

  test("the warm ring says my own microphone is open to them", async () => {
    const f = await mountFace();
    expect(f.key().getAttribute("data-tx")).toBeNull();
    ptt.capturing = true;
    await f.draw({ ...idle, sendingRoomKey: ROOM });
    expect(f.key().getAttribute("data-tx")).toBe("1");
    expect(f.key().getAttribute("data-walkie-state")).toBe("live");
    ptt.capturing = false;
    await f.unmount();
  });

  test("the cool ring says their voice is coming out of this machine", async () => {
    const f = await mountFace();
    await f.draw({ ...idle, talkingId: String(MEMBER._id) });
    expect(f.key().getAttribute("data-rx")).toBe("1");
    // Somebody else talking is not this face's business.
    await f.draw({ ...idle, talkingId: "u_bo" });
    expect(f.key().getAttribute("data-rx")).toBeNull();
    await f.unmount();
  });

  test("a join says so under the face, for four seconds", async () => {
    const f = await mountFace();
    expect(f.html()).not.toContain("joined");
    await f.draw({ ...idle, joinedRoom: ROOM });
    expect(f.html()).toContain("joined");
    expect(f.key().getAttribute("data-joined")).toBe("1");
    // And it is an event, not a badge the face now wears.
    await f.act(async () => {
      await Bun.sleep(JOINED_MS + 60);
    });
    expect(f.html()).not.toContain("joined");
    await f.unmount();
  });

  test("a burst is not a huddle: the violet chip stands down while one is live", async () => {
    // `in_huddle` is true for any live seat, so the chip lit for three seconds
    // of somebody's voice and read exactly like an hour in a call.
    const inRoom = { ...MEMBER, in_huddle: true };
    const f = await mountFace(idle, inRoom);
    expect(f.html()).toContain("In a huddle");
    await f.draw({ ...idle, talkingId: String(MEMBER._id) }, inRoom);
    expect(f.html()).not.toContain("In a huddle");
    // Somebody stepped in on purpose: it is a call now, and the chip is true
    // again.
    await f.draw({ talkingId: String(MEMBER._id), sendingRoomKey: "", joinedRoom: ROOM }, inRoom);
    expect(f.html()).toContain("In a huddle");
    await f.unmount();
  });

  test("a refused hold says why, in the tooltip and to a reader", async () => {
    ptt.reason = "You are in another call";
    const f = await mountFace();
    expect(f.key().getAttribute("title")).toBe("You are in another call");
    expect(f.key().getAttribute("aria-disabled")).toBe("true");
    ptt.reason = null;
    await f.unmount();
  });

  test("a tap opens the conversation with that person", async () => {
    openedDms = [];
    const f = await mountFace();
    const down = new window.Event("pointerdown", { bubbles: true });
    Object.defineProperty(down, "button", { value: 0 });
    await f.act(async () => { f.key().dispatchEvent(down); });
    await f.act(async () => {
      f.key().dispatchEvent(new window.Event("pointerup", { bubbles: true }));
    });
    expect(openedDms).toEqual([[String(MEMBER._id)]]);
    await f.unmount();
  });
});

// ── wake discipline ─────────────────────────────────────────────────────────

describe("the bar wakes on what it draws", () => {
  const member = (over: any = {}) => ({
    _id: "u_ann",
    name: "Ann Diaz",
    image: "a.png",
    presence_state: "active",
    presence_input_at: 1_700_000_000_000,
    ...over,
  });

  test("heartbeats move nothing: the bar sleeps through a roster re-push", () => {
    const before = teamBarSig([member()]);
    // Everything a presence heartbeat touches, and nothing a 32px face draws.
    const after = teamBarSig([
      member({
        presence_input_at: 1_700_000_600_000,
        recent_session_messages: 42,
        recent_session_updated: 1_700_000_600_000,
        recent_session_last_message: "still going",
        daemon_last_seen: 1_700_000_600_000,
      }),
    ]);
    expect(after).toBe(before);
  });

  test("a face that changes wakes it", () => {
    const before = teamBarSig([member()]);
    expect(teamBarSig([member({ in_huddle: true })])).not.toBe(before);
    expect(teamBarSig([member({ status: "busy" })])).not.toBe(before);
    expect(teamBarSig([member({ image: "b.png" })])).not.toBe(before);
    expect(teamBarSig([member({ name: "Ann D" })])).not.toBe(before);
    expect(teamBarSig([member({ in_room_key: "dm:a:b" })])).not.toBe(before);
  });

  const status = (over: any = {}) =>
    ({
      sending: null,
      incoming: null,
      liveRoom: null,
      unavailable: null,
      canReply: false,
      asr: "live",
      error: null,
      ...over,
    }) as any;
  const inRoom = (mode: string) => ({ liveRoom: { key: ROOM, mode, since: 1_000 } });

  test("the walkie signature moves on the three facts a face draws", () => {
    const quiet = walkieFacesSig(status());
    expect(walkieFacesSig(status({ incoming: { fromUserId: "u_ann" } }))).not.toBe(quiet);
    expect(walkieFacesSig(status({ sending: { roomKey: ROOM } }))).not.toBe(quiet);
    expect(walkieFacesSig(status(inRoom("call")))).not.toBe(quiet);
  });

  test("and holds still through the engine's own bookkeeping", () => {
    const quiet = walkieFacesSig(status());
    // A room being held open after a burst, the recognizer going down, a reply
    // becoming possible, an error clearing: engine churn that changes no pixel
    // of a face, on a surface mounted for the life of the app.
    expect(walkieFacesSig(status(inRoom("burst")))).toBe(quiet);
    expect(walkieFacesSig(status(inRoom("listen")))).toBe(quiet);
    expect(walkieFacesSig(status({ asr: "unavailable" }))).toBe(quiet);
    expect(walkieFacesSig(status({ canReply: true }))).toBe(quiet);
    expect(walkieFacesSig(status({ error: "that burst did not send" }))).toBe(quiet);
  });
});
