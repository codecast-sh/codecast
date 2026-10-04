// A link to a moment that names a screen (`?t=150&view=screen`, what a cited
// frame of a shared screen opens) lands the player on that screen, with the
// room's file mounted underneath for the voices; a moment no screen covers
// falls back to the room. Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/callVideoPlayer.view.mount.test.tsx
import { beforeAll, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let CallVideoPlayer: typeof import("../CallVideoPlayer").CallVideoPlayer;

const T = 1_000_000;
const file = (over: any) => ({
  run_id: "c1",
  status: "ready",
  ended_at: null,
  participant_identity: null,
  participant_name: null,
  ...over,
});
// The room filmed from 60s for 4 minutes; Ana's screen from 120s for 100s.
const FILES = [
  file({ id: "c1", kind: "composite", started_at: T + 60_000, duration_ms: 240_000, url: "https://b/c1.mp4" }),
  file({ id: "s1", kind: "screen", started_at: T + 120_000, duration_ms: 100_000, participant_identity: "u_ana", participant_name: "Ana", url: "https://b/s1.mp4" }),
];

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLVideoElement", "Element", "Node", "Event", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ CallVideoPlayer } = await import("../CallVideoPlayer"));
}, 120_000);

function mount() {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  const handleRef = { current: null as any };
  React.act(() => root.render(React.createElement(CallVideoPlayer, { files: FILES as any, callStartedAt: T, handleRef })));
  return { root, handleRef };
}

const srcs = () => [...document.querySelectorAll("video")].map((v) => v.getAttribute("src"));

test("a moment linked on a screen opens on that screen, the room underneath", () => {
  const { root, handleRef } = mount();
  expect(srcs()).toEqual(["https://b/c1.mp4"]);
  let landed = false;
  React.act(() => {
    landed = handleRef.current.seek(150_000, { play: false, view: { screen: true } });
  });
  expect(landed).toBe(true);
  expect(srcs()).toEqual(["https://b/c1.mp4", "https://b/s1.mp4"]);
  expect(document.querySelector('[role="radio"][aria-checked="true"]')!.textContent).toContain("Ana");
  React.act(() => root.unmount());
});

test("by identity too, and a moment no screen covers stays on the room", () => {
  let { root, handleRef } = mount();
  React.act(() => void handleRef.current.seek(150_000, { play: false, view: { screen: true, identity: "u_ana" } }));
  expect(srcs()).toEqual(["https://b/c1.mp4", "https://b/s1.mp4"]);
  React.act(() => root.unmount());
  ({ root, handleRef } = mount());
  React.act(() => void handleRef.current.seek(90_000, { play: false, view: { screen: true } }));
  expect(srcs()).toEqual(["https://b/c1.mp4"]);
  React.act(() => root.unmount());
});

test("a phone refusing the room's sound under a screen asks for a tap, and the tap plays it", async () => {
  const proto = (globalThis as any).HTMLVideoElement.prototype;
  const realPlay = proto.play;
  let refuse = true;
  const played: string[] = [];
  proto.play = function (this: HTMLVideoElement) {
    played.push(this.getAttribute("src") ?? "");
    if (refuse) return Promise.reject(Object.assign(new Error("needs a gesture"), { name: "NotAllowedError" }));
    return Promise.resolve();
  };
  try {
    const { root, handleRef } = mount();
    await React.act(async () => void handleRef.current.seek(150_000, { play: true, view: { screen: true } }));
    const chip = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Tap for sound"));
    expect(chip()).toBeTruthy();
    refuse = false;
    played.length = 0;
    await React.act(async () => chip()!.click());
    expect(played).toEqual(["https://b/c1.mp4"]);
    // The room's file playing is what clears it.
    await React.act(async () => void document.querySelector("video")!.dispatchEvent(new (globalThis as any).Event("playing")));
    expect(chip()).toBeUndefined();
    React.act(() => root.unmount());
  } finally {
    proto.play = realPlay;
  }
});
