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
const lengthChecks: any[] = [];
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
  mock.module("convex/react", () => ({
    ...convexReact,
    useAction: () => async (args: any) => {
      minted.push(args);
      return answer;
    },
    useMutation: () => async (args: any) => {
      lengthChecks.push(args);
      return { queued: true };
    },
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
  localStorage.setItem("ops.replay.skipIdle", "0");
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, issueMarks: [] }));
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

  // A time post the player queued before the seek lands after it and is not followed; the seek's echo is.
  fromPlayer(frame, { type: "time", t_ms: 2_000, playing: true });
  expect(document.querySelector("[data-current='true']")!.getAttribute("data-ev")).toBe("1");
  expect(document.querySelector("button[aria-label='Pause']")).toBeNull();
  fromPlayer(frame, { type: "time", t_ms: 5_000, playing: false });
  expect(document.querySelector("[data-current='true']")!.getAttribute("data-ev")).toBe("1");
  await React.act(async () => { await new Promise((r) => setTimeout(r, 320)); });

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

test("moving from one recording to another in the app opens the next at the time its address asks for", async () => {
  minted.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: null, issueMarks: [] }));
  await flush();
  const first = document.querySelector("iframe")!;
  fromPlayer(first, { type: "time", t_ms: 4_000, playing: false });
  // A link to another recording at 25s: its own player opens there, never at the last one's clock.
  const B = { ...REPLAY, _id: "rx72qtvpbmmrmwcjqmhzawejsx8bq9gn", short_id: "rp-8" };
  minted.length = 0;
  React.act(() => root.render(React.createElement(Player, { replay: B, events: EVENTS, initialT: 25_000, issueMarks: [] })));
  await flush();
  expect(minted).toEqual([{ replay: B._id, t_ms: 25_000, controls: false }]);
  expect(document.querySelector(".rp-clock, [data-clock]")?.textContent ?? document.body.textContent).toContain("0:25");
  // A link to the same recording at another time seeks the open player there.
  const frame = document.querySelector("iframe")!;
  const sent = spyOn(frame);
  fromPlayer(frame, { type: "ready", duration_ms: 30_000, width: 1280, height: 800, t_ms: 25_000 });
  sent.length = 0;
  React.act(() => root.render(React.createElement(Player, { replay: B, events: EVENTS, initialT: 6_000, issueMarks: [] })));
  expect(sent.map((x) => x.msg).filter((m) => m.type === "seek")).toEqual([{ source: "codecast-replay-host", type: "seek", t_ms: 6_000 }]);
  // The address echoing the player's own time moves nothing.
  sent.length = 0;
  React.act(() => root.render(React.createElement(Player, { replay: B, events: EVENTS, initialT: 6_200, issueMarks: [] })));
  expect(sent).toEqual([]);
  React.act(() => root.unmount());
});

test("skip idle jumps the player over a quiet stretch and keeps it playing; idle to the end stops there", async () => {
  localStorage.removeItem("ops.replay.skipIdle");
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, issueMarks: [] }));
  await flush();
  const frame = document.querySelector("iframe")!;
  const sent = spyOn(frame);
  fromPlayer(frame, { type: "ready", duration_ms: 30_000, width: 1280, height: 800, t_ms: 0 });
  sent.length = 0;
  // 5s to 20s holds nothing: from 6s it jumps to a second before the error, still playing.
  fromPlayer(frame, { type: "time", t_ms: 6_500, playing: true });
  expect(sent.map((s) => s.msg)).toEqual([{ source: "codecast-replay-host", type: "seek", t_ms: 19_000, play: true }]);
  expect(document.querySelector("button[aria-label='Pause']")).not.toBeNull();
  await React.act(async () => { await new Promise((r) => setTimeout(r, 320)); });
  // After the error nothing happens again: playback ends at the end.
  sent.length = 0;
  fromPlayer(frame, { type: "time", t_ms: 21_500, playing: true });
  expect(sent.map((s) => s.msg.type)).toEqual(["pause", "seek"]);
  expect(sent[1].msg.t_ms).toBe(30_000);
  expect(document.querySelector("button[aria-label='Play']")).not.toBeNull();
  // The toggle turns it off, and says so.
  const toggle = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Skip idle"))!;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  React.act(() => (toggle as HTMLElement).click());
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(localStorage.getItem("ops.replay.skipIdle")).toBe("0");
  React.act(() => root.unmount());
});

test("the rail filters by kind with counts, and a request opens to its detail", async () => {
  const events = [
    ...EVENTS,
    { t: 8_000, type: "network", method: "POST", url: "https://shop.example.com/api/pay", status: 502, ms: 340 },
    { t: 9_000, type: "network", method: "GET", url: "https://shop.example.com/api/cart", status: 200, ms: 3_400 },
    { t: 9_500, type: "click", label: "", selector: "[rrweb-id=4]" },
  ] as any[];
  const root = mount(React.createElement(Player, { replay: { ...REPLAY, dom_chunks: 0 }, events: events.sort((a, b) => a.t - b.t), initialT: 0, issueMarks: [] }));
  await flush();
  const tab = (name: string) => Array.from(document.querySelectorAll("[role='tab']")).find((b) => b.textContent?.startsWith(name)) as HTMLElement;
  expect(tab("Network").textContent).toBe("Network 2");
  // Errors are exceptions and console errors; the failed request is Network's.
  expect(tab("Errors").textContent).toBe("Errors 1");
  React.act(() => tab("Network").click());
  const rows = Array.from(document.querySelectorAll(".rp-ev"));
  expect(rows.length).toBe(2);
  const failedOnly = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Failed only")) as HTMLElement;
  expect(failedOnly.textContent).toBe("Failed only 1");
  React.act(() => failedOnly.click());
  expect(document.querySelectorAll(".rp-ev").length).toBe(1);
  React.act(() => failedOnly.click());
  expect(rows[0].querySelector(".rp-net [data-grade='failed']")!.textContent).toBe("502");
  expect(rows[1].querySelector(".rp-net [data-grade='slow']")!.textContent).toBe("200");
  React.act(() => (rows[0].querySelector("button[aria-label='Show detail']") as HTMLElement).click());
  expect(document.querySelector(".rp-ev-detail")!.textContent).toContain("https://shop.example.com/api/pay");
  // A click whose element the recorder lost says so, rather than a bare "click".
  React.act(() => tab("Actions").click());
  expect(document.body.textContent).toContain("an element since removed");
  // Every action opens to its locator.
  const click = Array.from(document.querySelectorAll(".rp-ev")).find((r) => r.textContent?.includes("an element since removed"))!;
  React.act(() => (click.querySelector("button[aria-label='Show detail']") as HTMLElement).click());
  expect(document.querySelector(".rp-ev-detail")!.textContent).toContain("not in the capture");
  React.act(() => root.unmount());
});

test("a player that cannot play says why, and the page keeps its own clock", async () => {
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?controls=0`, frame_url: "", expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, issueMarks: [] }));
  await flush();
  const frame = document.querySelector("iframe")!;
  fromPlayer(frame, { type: "error", message: "This replay link has expired." });
  // The cause in a person's words, and the steps: try again (a fresh link), or the vendor's player.
  expect(document.body.textContent).toContain("The player link expired");
  expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Try again")).toBe(true);
  expect(document.querySelector("iframe")).toBeNull();
  React.act(() => root.unmount());
});

test("a replay without a page capture never asks for a player", async () => {
  minted.length = 0;
  const root = mount(React.createElement(Player, { replay: { ...REPLAY, dom_chunks: 0 }, events: EVENTS, initialT: 0, issueMarks: [] }));
  await flush();
  expect(minted).toEqual([]);
  expect(document.querySelector("iframe")).toBeNull();
  React.act(() => root.unmount());
});

test("rp-N@m:ss embeds the player at that second, driven by the page's own bar", async () => {
  minted.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=83000`, frame_url: "", expires_at: 0 };
  const root = mount(React.createElement(ReplayMomentEmbed, { rawId: "rp-7@1:23", entity: REPLAY, served: true, href: "/ops/replays/rp-7?t=83000" }));
  await flush();
  expect(minted).toEqual([{ replay: REPLAY._id, t_ms: 83_000, controls: false }]);
  const frame = document.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe(`${PLAYER}/p/CAP?t=83000`);
  expect(frame.style.opacity).toBe("0");
  // A player that cannot see this page's origin says hello; the host answers to the player's origin alone.
  const sent = spyOn(frame);
  fromPlayer(frame, { type: "hello" });
  expect(sent).toEqual([{ msg: { source: "codecast-replay-host", type: "hello" }, origin: PLAYER }]);
  fromPlayer(frame, { type: "hello" }, "https://evil.example");
  expect(sent.length).toBe(1);
  expect(frame.style.opacity).toBe("0");
  fromPlayer(frame, { type: "ready", duration_ms: 185_000, width: 1280, height: 800, t_ms: 83_000 });
  expect(frame.style.opacity).toBe("1");
  expect(document.querySelector("a")!.getAttribute("href")).toBe("/ops/replays/rp-7?t=83000");
  expect(document.body.textContent).toContain("1:23");
  // The page's bar: the moment marked on the scrubber, and its play button drives the player.
  expect(document.querySelector(".rp-mini .rp-issue-tick")).not.toBeNull();
  sent.length = 0;
  React.act(() => (document.querySelector(".rp-mini .rp-play") as HTMLElement).click());
  expect(sent.map((m) => (m.msg as { type: string }).type)).toEqual(["play"]);
  React.act(() => root.unmount());
});

test("a page of moments opens only a few players by itself; the rest wait for a click", async () => {
  minted.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP`, frame_url: "", expires_at: 0 };
  const { LIVE_PLAYERS_MAX } = await import("../ReplayMomentEmbed");
  const n = LIVE_PLAYERS_MAX + 1;
  const root = mount(
    React.createElement(
      "div",
      null,
      Array.from({ length: n }, (_, i) => React.createElement(ReplayMomentEmbed, { key: i, rawId: `rp-7@0:0${i}`, entity: REPLAY, served: true, href: "/ops/replays/rp-7" })),
    ),
  );
  await flush();
  await flush();
  expect(minted.length).toBe(LIVE_PLAYERS_MAX);
  expect(document.querySelectorAll("iframe").length).toBe(LIVE_PLAYERS_MAX);
  const waiting = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent?.includes("Play the page at"));
  expect(waiting.length).toBe(1);
  React.act(() => (waiting[0] as HTMLElement).click());
  await flush();
  expect(minted.length).toBe(n);
  expect(document.querySelectorAll("iframe").length).toBe(n);
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

test("a capture longer than the stored length asks the server to read it, once", async () => {
  lengthChecks.length = 0;
  answer = { short_id: "rp-7", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const root = mount(React.createElement(Player, { replay: REPLAY, events: EVENTS, initialT: 0, issueMarks: [] }));
  await flush();
  const frame = document.querySelector("iframe")!;
  fromPlayer(frame, { type: "ready", duration_ms: 299_970, width: 1280, height: 800, t_ms: 0 });
  await flush();
  expect(lengthChecks).toEqual([{ replay: REPLAY._id }]);
  // The clock rounds before it splits: never 4:60.0.
  expect(document.body.textContent).toContain("/ 5:00.0");
  fromPlayer(frame, { type: "ready", duration_ms: 299_970, width: 1280, height: 800, t_ms: 0 });
  await flush();
  expect(lengthChecks.length).toBe(1);
  React.act(() => root.unmount());
});

test("keys walk failures and actions, theater hides the rail, and issues are marked on the scrubber", async () => {
  const events = [
    ...EVENTS,
    { t: 8_000, type: "network", method: "GET", url: "https://shop.example.com/api/poll?cursor=", status: 200, ms: 20_000 },
    { t: 9_000, type: "network", method: "GET", url: "https://shop.example.com/api/poll?cursor=", status: 200, ms: 20_000 },
    { t: 12_000, type: "network", method: "POST", url: "https://shop.example.com/api/pay", status: 502, ms: 40 },
  ].sort((a: any, b: any) => a.t - b.t) as any[];
  localStorage.removeItem("ops.replay.theater");
  localStorage.removeItem("ops.replay.mutedEndpoints");
  const root = mount(React.createElement(Player, { replay: { ...REPLAY, dom_chunks: 0 }, events, initialT: 0, issueMarks: [{ t: 12_000, short_id: "eg-9", title: "POST /api/pay 502" }] }));
  await flush();
  const press = (key: string) => React.act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
  const current = () => Number(document.querySelector("[role='slider']")!.getAttribute("aria-valuenow"));
  // All lists what a person watches for: the poll that answered is only in Network.
  expect(Array.from(document.querySelectorAll(".rp-ev")).some((r) => r.textContent?.includes("/api/poll"))).toBe(false);
  press("n");
  expect(current()).toBe(12_000);
  press("n");
  expect(current()).toBe(20_000);
  press("p");
  expect(current()).toBe(12_000);
  press("[");
  expect(current()).toBe(5_000);
  expect(document.querySelector(".rp-issue-tick")!.getAttribute("title")).toContain("eg-9");
  // A request that answered can be hidden from the Network tab; the failure stays.
  const tab = (name: string) => Array.from(document.querySelectorAll("[role='tab']")).find((b) => b.textContent?.startsWith(name)) as HTMLElement;
  React.act(() => tab("Network").click());
  expect(document.querySelectorAll(".rp-ev").length).toBe(2);
  React.act(() => (document.querySelector("button[aria-label='Hide GET /api/poll']") as HTMLElement).click());
  expect(document.querySelectorAll(".rp-ev").length).toBe(1);
  expect(document.querySelector(".rp-muted")!.textContent).toContain("2 requests hidden");
  // Theater hides the rail and remembers it.
  press("t");
  expect(document.querySelector(".rp-rail")).toBeNull();
  expect(localStorage.getItem("ops.replay.theater")).toBe("1");
  press("t");
  expect(document.querySelector(".rp-rail")).not.toBeNull();
  React.act(() => root.unmount());
});

test("a recording the import cut short marks the rest on the scrubber, and a time past it lands at the cut with the vendor's player there", async () => {
  // rp-5132's shape: PostHog says 1:45:49, the copy reaches 14:28.5.
  const cutRow = { ...REPLAY, duration_ms: 6_349_000, captured_ms: 868_500, dom_chunks: 0 };
  const events = [...EVENTS, { t: 868_000, type: "click", label: "Close", selector: "button" }];
  const root = mount(React.createElement(Player, { replay: cutRow, events, initialT: 3_600_000, issueMarks: [], vendor: { href: "https://us.posthog.com/project/1/replay/0199abc", name: "PostHog" } }));
  await flush();
  // Nothing reads the rest and nothing would: the scrubber marks the cut alone, and the notice offers the vendor's own player.
  expect(document.querySelector(".rp-cut")?.textContent).toBe("");
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toContain("rest not read in");
  const notice = document.querySelector(".rp-past-cut")!;
  expect(notice.textContent).toContain("1:00:00");
  expect(notice.querySelector("a")!.getAttribute("href")).toBe("https://us.posthog.com/project/1/replay/0199abc?t=3600");
  expect(document.querySelector("[role='slider']")!.getAttribute("aria-valuenow")).toBe("868500");
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toContain("14:28 of 1:45:49 imported");
  // The bar holds no import state: it lives on the scrubber's cut.
  expect(document.querySelector(".rp-bar")!.textContent).not.toContain("imported");
  // A seek inside the copy clears the notice.
  React.act(() => (document.querySelector("[data-ev='1']") as HTMLElement).click());
  expect(document.querySelector(".rp-past-cut")).toBeNull();
  React.act(() => root.unmount());
});

test("rp-5132 with its page capture: the player's clock runs the row's length, and the stored reach still cuts it", async () => {
  // The real numbers: captured 868,522 ms of 6,349,000. The player's ready says the row's length (its clock ends there).
  answer = { short_id: "rp-5132", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const cutRow = { ...REPLAY, short_id: "rp-5132", duration_ms: 6_349_000, captured_ms: 868_522, dom_chunks: 3 };
  const events = [...EVENTS, { t: 860_000, type: "click", label: "Close", selector: "button" }];
  const root = mount(React.createElement(Player, { replay: cutRow, events, initialT: 3_600_000, issueMarks: [], vendor: { href: "https://us.posthog.com/project/1/replay/0199abc", name: "PostHog" } }));
  await flush();
  const frame = document.querySelector("iframe")!;
  fromPlayer(frame, { type: "ready", duration_ms: 6_349_000, width: 1280, height: 800, t_ms: 868_522 });
  await flush();
  // Nothing reads the rest and nothing would: the scrubber marks the cut alone, and the notice offers the vendor's own player.
  expect(document.querySelector(".rp-cut")?.textContent).toBe("");
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toContain("rest not read in");
  expect(document.querySelector(".rp-past-cut")!.textContent).toContain("1:00:00");
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toContain("14:28 of 1:45:49 imported");
  // The cut is not drawn as idle time to skip.
  const idle = Array.from(document.querySelectorAll(".rp-idle")).map((el) => el.getAttribute("title") ?? "");
  expect(idle.some((t) => t.includes("1:31:"))).toBe(false);
  // A newer player that says where its capture ends agrees.
  fromPlayer(frame, { type: "ready", duration_ms: 6_349_000, capture_end_ms: 868_522, width: 1280, height: 800, t_ms: 868_522 });
  await flush();
  expect(document.querySelector(".rp-cut")).not.toBeNull();
  React.act(() => root.unmount());
});

test("while the rest of a long recording is read, the notice shows how far, and the time asked for plays once it is in", async () => {
  const reading = { next_blob: 60, blobs: 240, retry_at: null, error: null, updated_at: Date.now() };
  const cutRow = { ...REPLAY, duration_ms: 6_349_000, captured_ms: 868_500, dom_chunks: 0, import_rest: reading };
  const events = [...EVENTS, { t: 868_000, type: "click", label: "Close", selector: "button" }];
  const props = { events, initialT: 3_600_000, issueMarks: [], vendor: { href: "https://us.posthog.com/project/1/replay/0199abc", name: "PostHog" } };
  const root = mount(React.createElement(Player, { ...props, replay: cutRow }));
  await flush();
  // The scrubber keeps only the hatched region; its state is in words where there is room for them.
  expect(document.querySelector(".rp-cut")?.textContent).toBe("");
  // How far is said in time, never as a share of the vendor's blobs (a recording still being written grows them).
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toBe("14:28 of 1:45:49 imported · reading now");
  expect(document.querySelector(".rp-past-cut")!.textContent).toContain("not imported yet · 14:28 of 1:45:49 imported");
  expect(document.querySelector(".rp-past-cut .rp-rest")!.textContent).toBe("reading now");
  // The rest lands past the asked time: the notice goes and the clock moves there, playing.
  const more = [...events, { t: 3_700_000, type: "click", label: "Save", selector: "button" }];
  React.act(() => root.render(React.createElement(Player, { ...props, events: more, replay: { ...cutRow, captured_ms: 3_700_000, import_rest: { ...reading, next_blob: 150 } } })));
  await flush();
  expect(document.querySelector(".rp-past-cut")).toBeNull();
  expect(document.querySelector("[role='slider']")!.getAttribute("aria-valuenow")).toBe("3600000");
  expect(document.querySelector(".rp-play")!.getAttribute("aria-label")).toBe("Pause");
  React.act(() => root.unmount());
});

test("reading the rest stopped: a press asks for it again", async () => {
  let asked = 0;
  const cutRow = { ...REPLAY, duration_ms: 6_349_000, captured_ms: 868_500, dom_chunks: 0, import_rest: { next_blob: 60, blobs: 240, retry_at: null, error: "PostHog answered 500", updated_at: Date.now() } };
  const root = mount(React.createElement(Player, { replay: cutRow, events: EVENTS, initialT: 3_600_000, issueMarks: [], readRest: () => asked++ }));
  await flush();
  expect(document.querySelector(".rp-past-cut")!.textContent).toContain("1:00:00 not imported yet · 14:28 of 1:45:49 imported");
  expect(document.querySelector(".rp-past-cut .rp-rest")!.textContent).toContain("stopped");
  const btn = document.querySelector(".rp-past-cut .rp-rest button") as HTMLButtonElement;
  expect(btn.textContent).toBe("Read again");
  React.act(() => btn.click());
  expect(asked).toBe(1);
  React.act(() => root.unmount());
});

test("a cut the server waits out says why and when, and offers no press the server would refuse", async () => {
  const cutRow = { ...REPLAY, duration_ms: 6_349_000, captured_ms: 868_500, dom_chunks: 0, import_rest: null };
  const until = Date.now() + 10 * 60_000;
  const root = mount(React.createElement(Player, { replay: cutRow, events: EVENTS, initialT: 3_600_000, issueMarks: [], hold: { why: "realtime", until }, vendor: { href: "https://us.posthog.com/project/1/replay/0199abc", name: "PostHog" } }));
  await flush();
  expect(document.querySelector(".rp-past-cut .rp-rest")!.textContent).toContain("PostHog is still recording · read at");
  expect(document.querySelector(".rp-cut")!.getAttribute("title")).toContain("PostHog is still recording");
  expect(document.querySelector(".rp-past-cut .rp-rest button")).toBeNull();
  expect(document.querySelector(".rp-past-cut a")!.getAttribute("href")).toContain("t=3600");
  React.act(() => root.unmount());
});

test("the page asked for the rest and the server has not answered: the notice says it is starting, with no button", async () => {
  const cutRow = { ...REPLAY, duration_ms: 6_349_000, captured_ms: 868_500, dom_chunks: 0, import_rest: null };
  const root = mount(React.createElement(Player, { replay: cutRow, events: EVENTS, initialT: 3_600_000, issueMarks: [], starting: true, readRest: () => {} }));
  await flush();
  expect(document.querySelector(".rp-past-cut .rp-rest")!.textContent).toBe("starting import");
  expect(document.querySelector(".rp-past-cut .rp-rest button")).toBeNull();
  React.act(() => root.unmount());
});

test("a ?t past a cut that only the player knows (no stored reach) still lands at the cut with the notice", async () => {
  answer = { short_id: "rp-5153", has_dom: true, cap: "CAP", player_url: `${PLAYER}/p/CAP?t=0&controls=0`, frame_url: `${PLAYER}/frame`, expires_at: 0 };
  const row = { ...REPLAY, short_id: "rp-5153", duration_ms: 30_847_000, captured_ms: null, dom_chunks: 3 };
  const events = [...EVENTS, { t: 860_000, type: "click", label: "Close", selector: "button" }];
  const root = mount(React.createElement(Player, { replay: row, events, initialT: 7_200_000, issueMarks: [], vendor: { href: "https://us.posthog.com/project/1/replay/x", name: "PostHog" } }));
  await flush();
  const frame = document.querySelector("iframe")!;
  // The player clamps to what it holds and says so before its capture's end is known.
  fromPlayer(frame, { type: "ready", duration_ms: 30_847_000, capture_end_ms: 864_000, width: 1280, height: 800, t_ms: 864_000 });
  await flush();
  expect(document.querySelector(".rp-past-cut")!.textContent).toContain("2:00:00");
  React.act(() => root.unmount());
});

test("a copy that covers its recording draws no cut", async () => {
  const root = mount(React.createElement(Player, { replay: { ...REPLAY, dom_chunks: 0, captured_ms: 29_000 }, events: EVENTS, initialT: 0, issueMarks: [] }));
  await flush();
  expect(document.querySelector(".rp-cut")).toBeNull();
  React.act(() => root.unmount());
});
