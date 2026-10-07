// The isolated replay player as codecast hosts it (ReplayPlayerFrame): the
// /ops replay page drives it from its scrubber and event list and follows its
// time posts, and an `rp-N@m:ss` alone on its line embeds it at that moment.
// Mounted in jsdom with the capability mint stubbed; the player's messages are
// dispatched as the real page posts them, from its origin and its window.
// Run: bun test --timeout 120000 components/ops/__tests__/replayPlayer.mount.test.tsx
import { beforeAll, expect, mock, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Player: typeof import("../ReplayPage").Player;
let ReplayMomentEmbed: typeof import("../ReplayMomentEmbed").ReplayMomentEmbed;
const PLAYER = "https://replay.codecast.sh";
const minted: any[] = [];
let answer: any = null;

const REPLAY = {
  _id: "rx72qtvpbmmrmwcjqmhzawejsx8bq9gm",
  short_id: "rp-7",
  workspace: "team:t1",
  source_id: "s1",
  source_name: "web",
  provider: "posthog",
  external_id: "0199abc",
  url: "https://shop.example.com/checkout",
  user: null,
  started_at: 1_000_000,
  duration_ms: 30_000,
  counts: { clicks: 1, errors: 1, failed_requests: 0 },
  group_ids: [],
  chunks: 1,
  dom_chunks: 2,
  has_timeline: true,
  imported_at: null,
  updated_at: 1_000_000,
} as any;

const EVENTS = [
  { t: 0, type: "nav", url: "https://shop.example.com/checkout" },
  { t: 5_000, type: "click", label: "Pay", selector: "button" },
  { t: 20_000, type: "error", message: "TypeError: card is undefined" },
] as any[];

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLIFrameElement", "Element", "Node", "Event", "MessageEvent", "localStorage", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).requestAnimationFrame = (cb: any) => setTimeout(() => cb(Date.now()), 16);
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
  (dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
  React = await import("react");
  const h = React.createElement;
  const convexReact = await import("convex/react");
  // One function for every render, as Convex's own useAction returns: the
  // player's mint effect depends on it.
  const mint = async (args: any) => {
    minted.push(args);
    return answer;
  };
  mock.module("convex/react", () => ({
    ...convexReact,
    useAction: () => mint,
  }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
  ({ createRoot } = await import("react-dom/client"));
  ({ Player } = await import("../ReplayPage"));
  ({ ReplayMomentEmbed } = await import("../ReplayMomentEmbed"));
}, 120_000);

const flush = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function mount(el: any) {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  React.act(() => root.render(el));
  return root;
}

/** What the player page posts to its parent, as the browser delivers it. */
function fromPlayer(frame: HTMLIFrameElement, data: any, origin = PLAYER) {
  React.act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { source: "codecast-replay-player", ...data }, origin, source: frame.contentWindow as any }));
  });
}

function spyOn(frame: HTMLIFrameElement): any[] {
  const sent: any[] = [];
  (frame.contentWindow as any).postMessage = (msg: any, origin: string) => sent.push({ msg, origin });
  return sent;
}

test("the ops page drives the player from its scrubber and list, and follows its clock", async () => {
  minted.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, groupRefs: [] }));
  await flush();
  // One capability, minted for this replay at the page's time, the player's own bar hidden.
  expect(minted).toEqual([{ replay: REPLAY._id, t_ms: 0, controls: false }]);
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe(`${PLAYER}/p/CAP?t=0&controls=0`);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  const sent = spyOn(frame);

  // Ready: it is told where the page stands.
  fromPlayer(frame, { type: "ready", duration_ms: 30_000, width: 1280, height: 800, t_ms: 0 });
  expect(sent).toEqual([{ msg: { source: "codecast-replay-host", type: "seek", t_ms: 0 }, origin: PLAYER }]);

  // A click on an event pauses the player and seeks it there.
  sent.length = 0;
  React.act(() => (document.querySelector("[data-ev='1']") as HTMLElement).click());
  expect(sent.map((s) => s.msg.type)).toEqual(["pause", "seek"]);
  expect(sent[1].msg.t_ms).toBe(5_000);

  // Its time posts move the list and the play state.
  fromPlayer(frame, { type: "time", t_ms: 21_000, playing: true });
  expect(document.querySelector("[data-current='true']")!.getAttribute("data-ev")).toBe("2");
  expect(document.querySelector("button[aria-label='Pause']")).not.toBeNull();

  // The play button and the speeds are commands to it.
  sent.length = 0;
  React.act(() => (document.querySelector("button[aria-label='Pause']") as HTMLElement).click());
  React.act(() => (Array.from(document.querySelectorAll(".ops-seg button")).find((b) => b.textContent === "4x") as HTMLElement).click());
  expect(sent.map((s) => s.msg)).toEqual([
    { source: "codecast-replay-host", type: "pause" },
    { source: "codecast-replay-host", type: "speed", speed: 4 },
  ]);

  // Anything not from the player's origin and this frame is ignored.
  fromPlayer(frame, { type: "time", t_ms: 1_000, playing: false }, "https://evil.example");
  expect(document.querySelector("[data-current='true']")!.getAttribute("data-ev")).toBe("2");
  React.act(() => root.unmount());
});

test("a player that cannot play says why, and the page keeps its own clock", async () => {
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?controls=0`, frame_url: "", expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, groupRefs: [] }));
  await flush();
  const frame = document.querySelector("iframe")!;
  fromPlayer(frame, { type: "error", message: "This replay link has expired." });
  expect(document.body.textContent).toContain("could not be played: This replay link has expired.");
  expect(document.querySelector("iframe")).toBeNull();
  React.act(() => root.unmount());
});

test("a replay without a page capture never asks for a player", async () => {
  minted.length = 0;
  const root = mount(React.createElement(Player, { replay: { ...REPLAY, dom_chunks: 0 }, events: EVENTS, initialT: 0, groupRefs: [] }));
  await flush();
  expect(minted).toEqual([]);
  expect(document.querySelector("iframe")).toBeNull();
  React.act(() => root.unmount());
});

test("rp-N@m:ss embeds the player with its own bar at that second", async () => {
  minted.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=83000`, frame_url: "", expires_at: 0 };
  const root = mount(React.createElement(ReplayMomentEmbed, { rawId: "rp-7@1:23", entity: REPLAY, served: true, href: "/ops/replays/rp-7?t=83000" }));
  await flush();
  expect(minted).toEqual([{ replay: REPLAY._id, t_ms: 83_000 }]);
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe(`${PLAYER}/p/CAP?t=83000`);
  expect(frame.style.opacity).toBe("0");
  fromPlayer(frame, { type: "ready", duration_ms: 185_000, width: 1280, height: 800, t_ms: 83_000 });
  expect(frame.style.opacity).toBe("1");
  expect(document.querySelector("a")!.getAttribute("href")).toBe("/ops/replays/rp-7?t=83000");
  expect(document.body.textContent).toContain("1:23");
  React.act(() => root.unmount());
});

test("a moment of a replay with no capture, or one the viewer cannot read, says so", async () => {
  minted.length = 0;
  let root = mount(React.createElement(ReplayMomentEmbed, { rawId: "rp-7@0:05", entity: { ...REPLAY, dom_chunks: 0 }, served: true, href: "/ops/replays/rp-7?t=5000" }));
  await flush();
  expect(minted).toEqual([]);
  expect(document.body.textContent).toContain("kept no page capture");
  React.act(() => root.unmount());
  root = mount(React.createElement(ReplayMomentEmbed, { rawId: "rp-9@0:05", entity: null, served: true, href: "/ops/replays/rp-9?t=5000" }));
  expect(document.body.textContent).toContain("not available to you");
  React.act(() => root.unmount());
});
