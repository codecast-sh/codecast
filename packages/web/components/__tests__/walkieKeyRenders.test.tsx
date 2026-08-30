// SIX FACES, ONE PERSON TALKING, AND NOBODY WOKEN.
//
// The avatar bar mounts a push-to-talk key per teammate for the life of the
// app, and the people wall mounts one per member of the team. Every one of them
// used to subscribe to the walkie's whole status object, which moves on things
// no key draws: a partial transcript arriving several times a second, the
// recognizer going down, an error clearing, a room changing what it is. So one
// teammate talking re-rendered every face on screen, repeatedly, for an answer
// that had not moved.
//
// The key subscribes to a signature of its OWN room now. This file is the
// promise in both directions: it holds still through the churn, and it still
// wakes the moment this key's own answer changes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { dmRoomKey } from "@codecast/shared/contracts";

const hadGlobals = new Map<string, { had: boolean; was: unknown }>();

beforeAll(() => {
  // A real URL, not the default opaque origin: `localStorage` throws a
  // SecurityError on one, and the store reaches for it at import time.
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://local.codecast.sh/",
  });
  const g = globalThis as any;
  for (const k of ["window", "document", "navigator", "location", "localStorage", "sessionStorage", "matchMedia", "Element", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "AudioContext", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
    hadGlobals.set(k, { had: k in g, was: g[k] });
  }
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  // The store's own imports reach for these at module scope (analytics reads
  // `location`), so the page has to exist before the hook does.
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
  g.sessionStorage = dom.window.sessionStorage;
  g.matchMedia = dom.window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  g.getComputedStyle = dom.window.getComputedStyle;
  g.requestAnimationFrame = () => 1;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // The cues are real code on this path (a burst arriving chirps); an
  // oscillator that plays nothing is enough for a render test.
  g.AudioContext = class {
    currentTime = 0;
    destination = {};
    resume = () => Promise.resolve();
    createGain = () => ({ gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} });
    createOscillator = () => ({ frequency: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, type: "sine", connect() {}, start() {}, stop() {}, disconnect() {} });
    createAnalyser = () => ({ fftSize: 256, smoothingTimeConstant: 0, getByteTimeDomainData: () => {} });
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createBiquadFilter = () => ({ type: "lowpass", frequency: { value: 1, setValueAtTime() {} }, Q: { value: 1 }, connect() {}, disconnect() {} });
    close = () => Promise.resolve();
  };
});

afterAll(() => {
  const g = globalThis as any;
  for (const [k, { had, was }] of hadGlobals) {
    if (had) g[k] = was;
    else delete g[k];
  }
});

const ME = "user_me";
const MEMBERS = ["u1", "u2", "u3", "u4", "u5", "u6"];

/** A teammate's burst arriving, which is the ordinary churn: a real report
 *  through the engine's own entry point, not a poke at its internals. */
function burstFrom(fromUserId: string, n: number) {
  return {
    messageId: `m-${n}`,
    channelId: "chan-x",
    roomKey: dmRoomKey(ME, fromUserId),
    fromUserId,
    fromName: "Somebody",
    createdAt: Date.now(),
  };
}

async function mountFaces() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  // THE SUBSCRIPTION ITSELF, not the hook wrapped around it. `usePushToTalk`
  // opens microphones, so the neighbouring face suite replaces it with a stub
  // for the whole process — and a stub subscribes to nothing, which would make
  // this file pass while measuring air. `useWalkieKeySig` is what decides the
  // render count, it comes through that suite's mock unchanged (it spreads the
  // real module), and the guard below pins the wiring between the two.
  const { useWalkieKeySig } = await import("../../hooks/useWalkie");

  const renders: Record<string, number> = {};
  function Face({ memberId }: { memberId: string }) {
    renders[memberId] = (renders[memberId] ?? 0) + 1;
    const sig = useWalkieKeySig(dmRoomKey(ME, memberId));
    return React.createElement("span", { "data-sig": sig });
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement("div", null, MEMBERS.map((m) => React.createElement(Face, { key: m, memberId: m }))));
  });
  return { renders, root, act, host };
}

describe("walkie: the key's subscription", () => {
  test("is the one push-to-talk actually uses", async () => {
    // The render counts below are only about the shipped key if the shipped key
    // subscribes this way. Read from the source because the hook cannot be
    // asked at runtime: the suite next door replaces it wholesale.
    const source = readFileSync(new URL("../../hooks/useWalkie.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function usePushToTalk"));
    const hook = body.slice(0, body.indexOf("\n}"));
    expect(hook).toContain("useWalkieKeySig(roomKey)");
    // And never the whole snapshot, which is the subscription this replaced.
    expect(hook).not.toContain("useWalkieStatus()");
  });
});

describe("walkie: a bar of faces through somebody else's burst", () => {
  afterEach(async () => {
    const walkie = await import("../../lib/calls/walkie");
    walkie.observeWalkie({ bursts: [], doorOpen: false });
  });

  /** The engine needs a client before any of its gestures mean anything; the
   *  media plane stays unbound, so a report joins no room and opens no device.
   *  What is exercised is the recompute and the status push. */
  async function bindEngine() {
    const walkie = await import("../../lib/calls/walkie");
    walkie.bindWalkie({ mutation: async () => null, action: async () => null } as any);
    return walkie;
  }

  test("fifty pushes of engine churn wake none of the six", async () => {
    const walkie = await bindEngine();
    const { renders, root, act } = await mountFaces();
    const first = { ...renders };
    expect(Object.values(first)).toEqual([1, 1, 1, 1, 1, 1]);

    // Fifty teammates' bursts, each a real report through the engine's own
    // entry point. Every one of them publishes a new status — `incoming`
    // changes, so the walkie genuinely wakes its subscribers fifty times — and
    // none of them changes what any of these six keys says.
    //
    // ONE FLUSH PER PUSH, deliberately. Fifty pushes inside a single `act` are
    // coalesced into one commit, which would hide forty-nine of the renders
    // this is counting: with the old whole-status subscription the batched
    // version showed 2 renders a face and the honest version shows 51.
    let pushes = 0;
    const off = walkie.subscribeWalkie(() => void pushes++);
    for (let n = 0; n < 50; n++) {
      await act(async () => {
        walkie.observeWalkie({ bursts: [burstFrom("u1", n)], doorOpen: true });
      });
    }
    off();
    // The instrument first: a test that woke nobody because nothing happened
    // would pass while proving nothing.
    expect(pushes).toBeGreaterThanOrEqual(50);

    expect(renders).toEqual(first);
    root.unmount();
  });

  test("and the key still wakes when its own answer moves", async () => {
    // The other half, and the one a frozen subscription would also pass: a
    // walkie that has gone unavailable takes every key away, so every face has
    // to hear about it.
    const walkie = await bindEngine();
    const { useInboxStore } = await import("../../store/inboxStore");
    // From a known idle call plane, whatever the file before this one left
    // behind: the engine is a module singleton and these tests share it.
    useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
    walkie.refreshWalkie();
    expect(walkie.getWalkieStatus().unavailable).toBeNull();

    const { renders, root, act } = await mountFaces();
    const before = { ...renders };

    await act(async () => {
      useInboxStore.getState().setCallState({ roomKey: "dm:somewhere:else", phase: "connected" });
      walkie.refreshWalkie();
    });

    // The instrument: the key really did become unavailable.
    expect(walkie.getWalkieStatus().unavailable).toBe("another-call");
    for (const m of MEMBERS) expect(renders[m]).toBeGreaterThan(before[m]);

    await act(async () => {
      useInboxStore.getState().setCallState({ roomKey: null, phase: "idle" });
      walkie.refreshWalkie();
    });
    root.unmount();
  });
});
