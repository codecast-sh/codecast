// A `cl-42@12:34` alone on a line renders the call's video seeked to that
// second, through the shared alignment rule; a moment nobody recorded reads as
// the call at a time with the reason, never a broken box. Mounted in jsdom
// with the recordings query stubbed.
// Run: bun test --timeout 120000 components/calls/__tests__/callMomentFrame.mount.test.tsx
import { beforeAll, expect, mock, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let CallMomentFrame: typeof import("../CallMomentFrame").CallMomentFrame;
let recs: any = undefined;

const T = 1_000_000;
const ready = (over: any = {}) => ({
  _id: "r1",
  run_id: "r1",
  kind: "composite",
  status: "ready",
  started_at: T + 60_000,
  ended_at: null,
  duration_ms: 120_000,
  url: "https://bucket.example/calls/r1.mp4?sig=1",
  participant_identity: null,
  participant_name: null,
  ...over,
});

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  const h = React.createElement;
  const real = { ...(await import("../../../hooks/useRoomRecording")) };
  mock.module("../../../hooks/useRoomRecording", () => ({ ...real, useCallRecordings: () => recs }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
  ({ createRoot } = await import("react-dom/client"));
  ({ CallMomentFrame } = await import("../CallMomentFrame"));
}, 120_000);

function render(rawId: string) {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  React.act(() =>
    root.render(React.createElement(CallMomentFrame, { rawId, entity: { _id: "k1", title: "Pricing review" }, served: true, href: "/calls/cl-42?t=70" })),
  );
  return root;
}

test("a recorded moment is the video seeked there, linking to the page at that second", () => {
  recs = { call_started_at: T, recordings: [ready()] };
  const root = render("cl-42@1:10");
  const video = document.querySelector("video")!;
  // 70s into the call is 10s into a file that began 60s in.
  expect(video.getAttribute("src")).toBe("https://bucket.example/calls/r1.mp4?sig=1#t=10.00");
  expect(document.querySelector("a")!.getAttribute("href")).toBe("/calls/cl-42?t=70");
  expect(document.body.textContent).toContain("1:10");
  expect(document.body.textContent).toContain("Pricing review");
  React.act(() => root.unmount());
});

test("a moment outside what was recorded says so", () => {
  recs = { call_started_at: T, recordings: [ready()] };
  const root = render("cl-42@0:30");
  expect(document.querySelector("video")).toBeNull();
  expect(document.body.textContent).toContain("No video at 0:30");
  React.act(() => root.unmount());
});

test("a call never recorded, and one still saving, each say which", () => {
  recs = { call_started_at: T, recordings: [] };
  let root = render("cl-42@1:10");
  expect(document.body.textContent).toContain("This call was not recorded");
  React.act(() => root.unmount());
  recs = { call_started_at: T, recordings: [ready({ status: "stopping", url: null, duration_ms: null })] };
  root = render("cl-42@1:10");
  expect(document.body.textContent).toContain("still saving");
  React.act(() => root.unmount());
});

test("a screen shared at that moment is the frame, the one cast call snap took", () => {
  const screen = ready({
    _id: "s1",
    kind: "screen",
    started_at: T + 65_000,
    duration_ms: 30_000,
    url: "https://bucket.example/calls/s1.mp4?sig=1",
    participant_identity: "ann",
    participant_name: "Ann Lee",
  });
  recs = { call_started_at: T, recordings: [ready(), screen] };
  const root = render("cl-42@1:10");
  expect(document.querySelector("video")!.getAttribute("src")).toBe("https://bucket.example/calls/s1.mp4?sig=1#t=5.00");
  expect(document.body.textContent).toContain("Ann's screen");
  React.act(() => root.unmount());
});

test("a frame whose URL is refused, with nothing fresher, says so instead of a black box", () => {
  recs = { call_started_at: T, recordings: [ready({ url: "https://bucket.example/calls/r1.mp4?X-Amz-Signature=abc" })] };
  const root = render("cl-42@1:10");
  React.act(() => {
    document.querySelector("video")!.dispatchEvent(new (window as any).Event("error"));
  });
  expect(document.querySelector("video")).toBeNull();
  expect(document.body.textContent).toContain("not available here");
  React.act(() => root.unmount());
});

test("a moment still being filmed says it is recording now, not saving", () => {
  recs = { call_started_at: T, recordings: [ready({ status: "recording", url: null, duration_ms: null })] };
  const root = render("cl-42@1:10");
  expect(document.body.textContent).toContain("Recording now");
  React.act(() => root.unmount());
});
