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

function render(rawId: string, entity: any = { _id: "k1", title: "Pricing review" }) {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  React.act(() =>
    root.render(React.createElement(CallMomentFrame, { rawId, entity, served: true, href: "/calls/cl-42?t=70" })),
  );
  return root;
}

// The caption is the line said at that moment (webGetCallRef's `line`), the
// title dropping to a dim second line; a line that ended a while before the
// moment says when, as `cast call snap` does.
test("a moment is captioned with the line said then, a guest marked, an older line dated", () => {
  recs = { call_started_at: T, recordings: [ready()] };
  const line = { seq: 7, speaker_id: "guest:g1", speaker_name: "Pat Rivera", text: "The cobalt slide is next", t0: 68_000, t1: 71_000, during: true };
  let root = render("cl-42@1:10", { _id: "k1", title: "Pricing review", line });
  const caption = document.querySelector("[data-moment-line='7']")!;
  expect(caption.textContent).toContain("Pat");
  expect(caption.textContent).not.toContain("Rivera");
  expect(caption.textContent).toContain("guest");
  expect(caption.textContent).toContain("The cobalt slide is next");
  expect(document.body.textContent).toContain("Pricing review");
  expect(document.body.textContent).not.toContain("last said");
  React.act(() => root.unmount());

  root = render("cl-42@1:10", { _id: "k1", title: "Pricing review", line: { ...line, speaker_id: "ua", speaker_name: "Ada", t0: 60_000, t1: 64_000, during: false } });
  expect(document.body.textContent).toContain("last said at 1:00");
  React.act(() => root.unmount());

  // Within a few seconds the line and the picture read as one moment.
  root = render("cl-42@1:10", { _id: "k1", title: "Pricing review", line: { ...line, speaker_id: "ua", speaker_name: "Ada", t0: 66_000, t1: 68_000, during: false } });
  expect(document.body.textContent).not.toContain("last said");
  React.act(() => root.unmount());
});

test("a recorded moment is the video seeked there, linking to the page at that second", () => {
  recs = { call_started_at: T, recordings: [ready()] };
  const root = render("cl-42@1:10");
  const video = document.querySelector("video")!;
  // 70s into the call is 10s into a file that began 60s in.
  expect(video.getAttribute("src")).toBe("https://bucket.example/calls/r1.mp4?sig=1#t=10.00");
  // Loaded with CORS, so the drawn frame can be kept (lib/calls/momentFrames).
  expect(video.getAttribute("crossorigin")).toBe("anonymous");
  expect(document.querySelector("a")!.getAttribute("href")).toBe("/calls/cl-42?t=70");
  expect(document.body.textContent).toContain("1:10");
  expect(document.body.textContent).toContain("Pricing review");
  React.act(() => root.unmount());
});

test("a moment drawn before on this page is its kept picture: no video, the screen still named", async () => {
  const { keepMomentFrame, momentFrameKey, keepCallFrames } = await import("../../../lib/calls/momentFrames");
  const realCreate = document.createElement.bind(document);
  // jsdom has no canvas: stand one in for the keep.
  (document as any).createElement = (tag: string) =>
    tag === "canvas" ? { getContext: () => ({ drawImage() {} }), toBlob: (cb: any) => cb(new Blob(["x"])) } : realCreate(tag);
  try {
    await keepMomentFrame(momentFrameKey("r1", 10), { call: "k1", recording: "r1" }, { videoWidth: 1280, videoHeight: 720 } as any);
  } finally {
    (document as any).createElement = realCreate;
  }
  recs = { call_started_at: T, recordings: [ready()] };
  const root = render("cl-42@1:10");
  expect(document.querySelector("video")).toBeNull();
  expect(document.querySelector("img")!.getAttribute("src")).toMatch(/^blob:/);
  expect(document.querySelector("img")!.getAttribute("alt")).toBe("The call at 1:10");
  React.act(() => root.unmount());
  keepCallFrames("k1");
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

test("a frame scrolled far past gives its player back and keeps its place; the call is asked once", () => {
  // Two observers per card: the latched one that starts the subscription
  // (200px) and the one that holds the player (1500px). The fake reports the
  // reader's distance by margin, the way a real IntersectionObserver would.
  const observers: { margin: string; cb: (e: any[]) => void }[] = [];
  (globalThis as any).IntersectionObserver = class {
    constructor(cb: (e: any[]) => void, opts: { rootMargin: string }) {
      observers.push({ margin: opts.rootMargin, cb });
    }
    observe() {}
    disconnect() {}
  };
  const reader = (within: (margin: string) => boolean) =>
    React.act(() => observers.forEach((o) => o.cb([{ isIntersecting: within(o.margin) }])));
  try {
    recs = { call_started_at: T, recordings: [ready()] };
    const root = render("cl-42@1:10");
    expect(document.querySelector("video")).toBeNull();
    reader(() => true);
    expect(document.querySelector("video")).not.toBeNull();
    // Far past both margins: the player is let go, the box stays (no jump).
    reader(() => false);
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector(".aspect-video")).not.toBeNull();
    expect(document.body.textContent).toContain("1:10");
    // Back within range: the frame mounts again from the latched answer.
    reader((m) => m === "1500px");
    expect(document.querySelector("video")!.getAttribute("src")).toBe("https://bucket.example/calls/r1.mp4?sig=1#t=10.00");
    React.act(() => root.unmount());
  } finally {
    delete (globalThis as any).IntersectionObserver;
  }
});
