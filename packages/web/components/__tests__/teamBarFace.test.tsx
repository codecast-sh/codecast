// THE HEADER IS THE FACE ROW (pl-756 F3).
//
// The avatar bar used to draw its own faces (TeamBarFace) with its own rings
// and its own answer to "is this person in a call". It draws the face row now,
// from the one model every surface reads, and what is pinned here is the
// shell's chrome around that row: the seats come from the model in the
// model's order with the card hung under them; the header caps the row and
// counts the rest; the hover card keeps a person's activity and profile and
// no longer carries a walkie key; the context menu opens on a face; the pop
// out sends the row away and leaves one chip; and the door to the stage is
// there only while a call is up. Built on a hand made row so what is under
// test is the bar, never the derivation.
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { FaceCard, FaceEntry, FaceRow as FaceRowModel, Link } from "../../lib/faces/faceRow";
import type { PushToTalk } from "../../hooks/useWalkie";
import { teamBarSig } from "../presence/memberPresence";
import { walkieFacesSig } from "../presence/useFaceKey";

// ── the world the bar talks to ──────────────────────────────────────────────
//
// Faithful stand ins, never stubs: each real module is spread and exactly the
// export that would reach a microphone, a router or the server is replaced.

const realWalkieHooks = await import("../../hooks/useWalkie");
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
mock.module("../../hooks/useWalkie", () => ({ ...realWalkieHooks, usePushToTalk: () => ptt }));

const realChatHooks = await import("../../hooks/useChatSync");
let openedDms: string[][] = [];
mock.module("../../hooks/useChatSync", () => ({
  ...realChatHooks,
  useOpenDm: () => (ids: string[]) => openedDms.push(ids),
}));

const nav = { pushed: [] as string[] };
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: (p: string) => nav.pushed.push(p) }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// The row, handed in by the test. The selectors that read the shared row
// (MemberFace's chip, the live rooms) stay real.
const realFaceRowHooks = await import("../../hooks/useFaceRow");
let fakeRow: FaceRowModel;
mock.module("../../hooks/useFaceRow", () => ({ ...realFaceRowHooks, useFaceRow: () => fakeRow }));

const realTeamFeatures = await import("../../lib/teamFeatures");
mock.module("../../lib/teamFeatures", () => ({ ...realTeamFeatures, useCallsAvailable: () => true }));

// The feeder would open a Convex subscription; the bar paints the store.
const realSyncCollection = await import("../../hooks/useSyncCollection");
mock.module("../../hooks/useSyncCollection", () => ({ ...realSyncCollection, useSyncCollection: () => {} }));

// The hover card's session lookups: a router context and a server query.
const realOpenSession = await import("../../hooks/useOpenSession");
mock.module("../../hooks/useOpenSession", () => ({ ...realOpenSession, useOpenSession: () => () => {} }));
const realMissingRow = await import("../../hooks/useMissingSessionRow");
mock.module("../../hooks/useMissingSessionRow", () => ({ ...realMissingRow, useMissingSessionRow: () => null }));

// The context menu is a Radix dropdown in a portal; the bar's wiring is what
// is under test, so the menu renders its items in place.
const realCtx = await import("../ui/context-menu");
mock.module("../ui/context-menu", () => ({
  ...realCtx,
  ContextMenu: ({ state, children }: { state: { menu: { payload: unknown } | null }; children: (p: any) => React.ReactNode }) =>
    state.menu ? <div data-ctx-menu>{children(state.menu.payload)}</div> : null,
  CtxHeader: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
  CtxItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

// The pop out: the shell's word on whether the row floats, and the switch.
const realDesktop = await import("../../lib/desktop");
const floating = { available: true, floating: false, set: [] as boolean[] };
mock.module("../../lib/desktop", () => ({
  ...realDesktop,
  useFacesFloating: () => ({
    available: floating.available,
    floating: floating.floating,
    setFloating: (on: boolean) => floating.set.push(on),
  }),
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
  // The context menu is a Radix popover: a focus scope and a resize observer.
  MutationObserver: dom.window.MutationObserver,
  CustomEvent: dom.window.CustomEvent,
  FocusEvent: dom.window.FocusEvent,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { TeamAvatarBar, BAR_FACES } = await import("../TeamAvatarBar");
const { getCallStageOpen, closeCallStage } = await import("../../lib/calls/callStage");

afterAll(() => {
  mock.module("../ui/context-menu", () => realCtx);
  mock.module("../../lib/desktop", () => realDesktop);
  mock.module("../../hooks/useFaceRow", () => realFaceRowHooks);
  closeDomWindow(dom);
  restoreGlobals();
});

// ── rows by hand ────────────────────────────────────────────────────────────

const ME = "u-me";
const ANN = "u-ann";
const BO = "u-bo";
const TEAM = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";

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
const link = (to: string, kind: Link["kind"]): Link => ({ from: ME, to, kind });
const liveCard: FaceCard = { kind: "live", roomKey: "dm:u-ann:u-me", title: "Ann", end: true, mute: true, muted: false, words: null, hearing: null };

const member = (id: string, name: string) => ({ _id: id, name, presence_state: "active", github_username: name.toLowerCase() });

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  fakeRow = rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]);
  floating.available = true;
  floating.floating = false;
  floating.set = [];
  nav.pushed = [];
  openedDms = [];
  closeCallStage();
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    teamMembers: [member(ME, "Me"), member(ANN, "Ann"), member(BO, "Bo")],
    clientState: { ...useInboxStore.getState().clientState, ui: { ...(useInboxStore.getState().clientState?.ui ?? {}), active_team_id: TEAM } },
    callOccupancy: {},
    liveRooms: [],
    followLeaderId: null,
  } as any);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount() {
  host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<TeamAvatarBar />));
  const fire = async (el: Element, type: string) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  };
  return {
    draw: async (row: FaceRowModel) => {
      fakeRow = row;
      // The mocked hook reads the module variable, so a re-render is what
      // hands the bar the new row.
      await act(async () => root!.render(<TeamAvatarBar key={Math.random()} />));
    },
    q: <T extends Element = HTMLElement>(sel: string) => host!.querySelector(sel) as T | null,
    all: (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[],
    seat: (id: string) => host!.querySelector(`[data-face-id="${id}"]`) as HTMLElement,
    face: (id: string) => host!.querySelector(`[data-face-id="${id}"] .face`) as HTMLElement,
    fire,
    html: () => host!.innerHTML,
  };
}

// ── the row in the header ───────────────────────────────────────────────────

describe("the header draws the model's row", () => {
  test("one seat per entry, in the model's order, with me at the head and the link before the face", async () => {
    fakeRow = rowOf([me({ state: "speaking", level: "mic" }), entry(ANN, "Ann", { tier: "linked", state: "hearing-me" }), entry(BO, "Bo")], [link(ANN, "tx")]);
    const h = await mount();
    expect(h.all("[data-face-id]").map((el) => el.dataset.faceId)).toEqual([ME, ANN, BO]);
    expect(h.face(ANN).getAttribute("data-state")).toBe("hearing-me");
    expect(h.q(".face-link")?.getAttribute("data-link-kind")).toBe("tx");
    // The bar says something is live, for the styles that hide it otherwise.
    expect(h.q(".people-bar")?.getAttribute("data-live")).toBe("1");
  });

  test("the card hangs under the row, and the door to the stage stands beside it only while a call is up", async () => {
    const h = await mount();
    expect(h.q(".engagement-card")).toBeNull();
    expect(h.q("[data-open-call]")).toBeNull();
    await h.draw(rowOf([me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" })], [link(ANN, "call")], liveCard));
    const card = h.q(".engagement-card")!;
    expect(card.getAttribute("data-density")).toBe("bar");
    expect(card.closest(".face-row")).not.toBeNull();
    expect(h.q("[data-open-call]")).not.toBeNull();
    // A listen offers the card's answers, not the stage.
    await h.draw(
      rowOf([me(), entry(ANN, "Ann", { tier: "linked", state: "talking-to-me" })], [link(ANN, "rx")], {
        kind: "incoming", roomKey: "dm:u-ann:u-me", from: ANN, name: "Ann", reply: true, join: true, snooze: true,
        words: { stage: "incoming", badge: "INCOMING", hint: "Ann is talking to you." },
      }),
    );
    expect(h.q(".engagement-card")).not.toBeNull();
    expect(h.q("[data-open-call]")).toBeNull();
    // My own burst is a voice, not a call: the card, and no stage.
    await h.draw(rowOf([me({ state: "speaking", level: "mic" }), entry(ANN, "Ann", { tier: "linked", state: "hearing-me" })], [link(ANN, "tx")], { ...liveCard, mute: false }));
    expect(h.q(".engagement-card")).not.toBeNull();
    expect(h.q("[data-open-call]")).toBeNull();
  });

  test("Open the call opens the stage in a browser, and nothing opens it on its own", async () => {
    fakeRow = rowOf([me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" })], [link(ANN, "call")], liveCard);
    const h = await mount();
    expect(getCallStageOpen()).toBe(false);
    await h.fire(h.q("[data-open-call]")!, "click");
    expect(getCallStageOpen()).toBe(true);
  });

  test("the header caps the row and counts the rest; me and the linked faces are never cut", async () => {
    const crowd = Array.from({ length: BAR_FACES + 3 }, (_, i) => entry(`u-${i}`, `Person ${i}`));
    fakeRow = rowOf([me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" }), ...crowd], [link(ANN, "call")], liveCard);
    const h = await mount();
    const ids = h.all("[data-face-id]").map((el) => el.dataset.faceId);
    expect(ids.length).toBe(BAR_FACES);
    expect(ids.slice(0, 2)).toEqual([ME, ANN]);
    expect(h.q("[data-overflow]")?.textContent).toBe(`+${crowd.length + 2 - BAR_FACES}`);
  });

  test("with nobody on the roster the bar is only its feeder", async () => {
    useInboxStore.setState({ teamMembers: [] } as any);
    const h = await mount();
    expect(h.q(".people-bar")).toBeNull();
  });
});

// ── the chrome around the row ───────────────────────────────────────────────

describe("the hover card", () => {
  test("opens after a dwell on a face, with the person's activity and no walkie key", async () => {
    const h = await mount();
    await h.fire(h.face(ANN), "mouseover");
    expect(h.q("[data-member-card]")).toBeNull();
    await act(async () => {
      await Bun.sleep(160);
    });
    const card = h.q("[data-member-card]")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Ann");
    expect(card.textContent).toContain("Message");
    // The walkie is on the face, not on the card: no key under a dwell.
    expect(card.querySelector(".face-actions")).toBeNull();
    expect(card.querySelector(".walkie-ptt")).toBeNull();
    // Message on the card opens the DM with that person.
    const message = Array.from(card.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Message")!;
    await h.fire(message, "click");
    expect(openedDms).toEqual([[ANN]]);
  });

  test("stands down when the face is clicked: the three actions take its place", async () => {
    const h = await mount();
    await h.fire(h.face(ANN), "mouseover");
    await act(async () => {
      await Bun.sleep(160);
    });
    expect(h.q("[data-member-card]")).not.toBeNull();
    await h.fire(h.face(ANN), "click");
    await act(async () => {
      await Bun.sleep(240);
    });
    expect(h.q("[data-member-card]")).toBeNull();
    expect(h.seat(ANN).querySelector(".people-face-actions")).not.toBeNull();
    // A pointer back over the open face does not stack the card on the actions.
    await h.fire(h.face(ANN), "mouseover");
    await act(async () => {
      await Bun.sleep(160);
    });
    expect(h.q("[data-member-card]")).toBeNull();
  });
});

describe("the context menu", () => {
  test("opens on a face with the person's name and the profile door", async () => {
    const h = await mount();
    await h.fire(h.face(BO), "contextmenu");
    const menu = h.q("[data-ctx-menu]")!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Bo");
    expect(menu.textContent).toContain("Open profile");
    // A right click off a face opens nothing.
    await h.fire(h.q("[data-pop-out]")!, "contextmenu");
    expect(h.all("[data-ctx-menu]").length).toBe(1);
  });
});

describe("the pop out", () => {
  test("sends the row to the floating window", async () => {
    const h = await mount();
    await h.fire(h.q("[data-pop-out]")!, "click");
    expect(floating.set).toEqual([true]);
  });

  test("while the faces float the header keeps one chip, which brings them back", async () => {
    floating.floating = true;
    const h = await mount();
    expect(h.q("[data-face-id]")).toBeNull();
    const chip = h.q(".people-bar button")!;
    expect(chip.textContent).toContain("Faces are floating");
    await h.fire(chip, "click");
    expect(floating.set).toEqual([false]);
  });
});

// ── wake discipline ─────────────────────────────────────────────────────────

describe("the bar wakes on what it draws", () => {
  const roster = (over: any = {}) => ({
    _id: "u_ann",
    name: "Ann Diaz",
    image: "a.png",
    presence_state: "active",
    presence_input_at: 1_700_000_000_000,
    ...over,
  });

  test("heartbeats move nothing: the row's roster signature sleeps through a re-push", () => {
    const before = teamBarSig([roster()]);
    // Everything a presence heartbeat touches, and nothing a 32px face draws.
    const after = teamBarSig([
      roster({
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
    const before = teamBarSig([roster()]);
    expect(teamBarSig([roster({ in_huddle: true })])).not.toBe(before);
    expect(teamBarSig([roster({ status: "busy" })])).not.toBe(before);
    expect(teamBarSig([roster({ image: "b.png" })])).not.toBe(before);
    expect(teamBarSig([roster({ name: "Ann D" })])).not.toBe(before);
    expect(teamBarSig([roster({ in_room_key: "dm:a:b" })])).not.toBe(before);
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

  test("the walkie signature the faces read moves on the three facts a face draws", () => {
    const quiet = walkieFacesSig(status());
    expect(walkieFacesSig(status({ incoming: { fromUserId: "u_ann" } }))).not.toBe(quiet);
    expect(walkieFacesSig(status({ sending: { roomKey: "dm:a:b" } }))).not.toBe(quiet);
    expect(walkieFacesSig(status({ liveRoom: { key: "dm:a:b", mode: "call", since: 1_000 } }))).not.toBe(quiet);
  });

  test("and holds still through the engine's own bookkeeping", () => {
    const quiet = walkieFacesSig(status());
    // The recognizer going down, a reply becoming possible, an error clearing:
    // engine churn that changes no pixel of a face, on a surface mounted for
    // the life of the app. A room held as a burst is the face row's business
    // now (isInHuddle reads the row's links), so it moves this signature no more.
    expect(walkieFacesSig(status({ asr: "unavailable" }))).toBe(quiet);
    expect(walkieFacesSig(status({ canReply: true }))).toBe(quiet);
    expect(walkieFacesSig(status({ error: "that burst did not send" }))).toBe(quiet);
    expect(walkieFacesSig(status({ liveRoom: { key: "dm:a:b", mode: "burst", since: 1_000 } }))).toBe(quiet);
  });
});
