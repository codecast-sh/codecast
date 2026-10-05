// The red mark says one thing: the room is being filmed right now. A run that
// was stopped and is only being saved wears neither the breathing dot nor
// REC, at any size, so no surface reads a finished recording as one running.
// And the mark is the Stop control: a press asks, the second press stops.
// Run: bun test components/calls/__tests__/recordingMark.test.tsx
import { beforeAll, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Mark: typeof import("../RecordingMark");

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key] ?? (dom.window as any).Event, configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  Mark = await import("../RecordingMark");
}, 120_000);

function mount(el: React.ReactElement) {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  React.act(() => root.render(el));
  return { host, root };
}

test("recording: the breathing dot and REC, at every size", () => {
  for (const size of ["regular", "pill", "dot"] as const) {
    const { host, root } = mount(React.createElement(Mark.RecordingMark, { size, status: "recording", startedAt: Date.now() - 5_000 }));
    expect(host.querySelector(".rec-pill-dot")).not.toBeNull();
    expect(host.textContent).toContain("REC");
    React.act(() => root.unmount());
  }
});

test("stopping: no breathing dot and no REC on any surface, only that it is saving", () => {
  for (const size of ["regular", "pill", "dot"] as const) {
    const { host, root } = mount(React.createElement(Mark.RecordingMark, { size, status: "stopping" }));
    expect(host.querySelector(".rec-pill-dot")).toBeNull();
    expect(host.textContent).not.toContain("REC");
    expect(host.textContent!.toLowerCase()).toContain("saving");
    expect(host.querySelector("[role=img]")!.getAttribute("title")).toBe("Recording stopped. Saving the video");
    React.act(() => root.unmount());
  }
});

test("the pill carries no clock; the regular mark says starting until the room is filmed", () => {
  let m = mount(React.createElement(Mark.RecordingMark, { size: "pill" }));
  expect(m.host.textContent).toBe("REC");
  React.act(() => m.root.unmount());
  m = mount(React.createElement(Mark.RecordingMark, { status: "starting" }));
  expect(m.host.textContent).toContain("starting");
  React.act(() => m.root.unmount());
});

test("the mark is the Stop control: a press asks, Keep closes, Stop stops", () => {
  let stopped = 0;
  const { host, root } = mount(
    React.createElement(Mark.RecordingStopControl, { onStop: () => void stopped++ }, React.createElement(Mark.RecordingMark, { size: "pill" })),
  );
  // A button's words, without the key cap beside them.
  const words = (b: Element) => [...b.childNodes].filter((n) => n.nodeName !== "KBD").map((n) => n.textContent).join("").trim();
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => words(b) === label || b.getAttribute("aria-label") === label)!;
  const press = (label: string) => React.act(() => button(label).click());
  expect(host.querySelector("[role=dialog]")).toBeNull();
  press("This call is being recorded. Stop recording");
  expect(host.querySelector("[role=dialog]")!.textContent).toContain(Mark.STOP_RECORDING_ASK.title);
  expect(stopped).toBe(0);
  // The answers are the phone's words, and Keep shows the key that closes it.
  expect(button(Mark.STOP_RECORDING_ASK.keep).querySelector("kbd")?.textContent).toBe("Esc");
  press(Mark.STOP_RECORDING_ASK.keep);
  expect(host.querySelector("[role=dialog]")).toBeNull();
  press("This call is being recorded. Stop recording");
  // Enter on the question is never a Stop.
  const box = host.querySelector("[role=dialog]") as HTMLElement;
  React.act(() => void box.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(stopped).toBe(0);
  expect(host.querySelector("[role=dialog]")).not.toBeNull();
  press(Mark.STOP_RECORDING_ASK.stop);
  expect(stopped).toBe(1);
  expect(host.querySelector("[role=dialog]")).toBeNull();
  React.act(() => root.unmount());
});

test("on a phone the question lands just past its own control, wherever that control sits", () => {
  const was = (window as any).matchMedia;
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("max-width"), addEventListener() {}, removeEventListener() {} });
  (window as any).innerHeight = 844;
  const rectAt = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 40, width: 40, height: bottom - top, x: 0, y: top, toJSON() {} });
  try {
    for (const [place, rect, want] of [
      ["below-start", rectAt(96, 120), { top: "128px" }],
      ["above", rectAt(780, 812), { bottom: "76px" }],
    ] as const) {
      const { host, root } = mount(
        React.createElement(Mark.RecordingStopControl, { onStop: () => {}, place }, React.createElement(Mark.RecordingMark, { size: "pill" })),
      );
      (host.querySelector("span") as HTMLElement).getBoundingClientRect = rect as any;
      React.act(() => (host.querySelector("button") as HTMLButtonElement).click());
      const box = host.querySelector("[role=dialog]") as HTMLElement;
      for (const [k, v] of Object.entries(want)) expect(box.style.getPropertyValue(k)).toBe(v);
      React.act(() => root.unmount());
    }
  } finally {
    (window as any).matchMedia = was;
  }
});
