// The box the room's recording questions open in. Enter answers only a
// question that has a default (Record), and never as the repeat of the press
// that opened it; Esc closes the box and never reaches the stage behind it
// (which collapses on Esc); a press inside the control keeps it open and a
// press anywhere else closes it. Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/recordingQuestionBox.mount.test.tsx
import { beforeAll, beforeEach, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let RecordingQuestionBox: typeof import("../RecordingMark").RecordingQuestionBox;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ RecordingQuestionBox } = await import("../RecordingMark"));
}, 120_000);

let closes = 0;
let enters = 0;
let stage = 0;

beforeEach(() => {
  closes = enters = stage = 0;
});

function Host({ withEnter }: { withEnter: boolean }) {
  const inside = React.useRef<HTMLSpanElement>(null);
  return React.createElement(
    "span",
    { ref: inside, id: "control" },
    React.createElement("button", { id: "trigger" }, "REC"),
    React.createElement(
      RecordingQuestionBox,
      { label: "Stop recording?", place: "below", insideRef: inside, onClose: () => closes++, onEnter: withEnter ? () => enters++ : undefined },
      React.createElement("button", { id: "answer" }, "Keep recording"),
    ),
  );
}

function mount(withEnter: boolean) {
  document.body.innerHTML = "<div id='root'></div><div id='elsewhere'></div>";
  const root = createRoot(document.getElementById("root")!);
  // A stage behind the box that collapses on Esc, listening where CallStage does.
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && stage++;
  window.addEventListener("keydown", onKey);
  React.act(() => root.render(React.createElement(Host, { withEnter })));
  const box = document.querySelector("[role=dialog]") as HTMLElement;
  return {
    box,
    done: () => {
      React.act(() => root.unmount());
      window.removeEventListener("keydown", onKey);
    },
  };
}

const key = (el: Element, k: string, repeat = false) =>
  React.act(() => void el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: k, repeat, bubbles: true })));
const press = (id: string) => document.getElementById(id)!.dispatchEvent(new (window as any).Event("pointerdown", { bubbles: true }));

test("focus lands on the box, not on an answer", () => {
  const { box, done } = mount(true);
  expect(document.activeElement).toBe(box);
  done();
});

test("Enter answers a question with a default, once, and never as a held repeat", () => {
  const { box, done } = mount(true);
  key(box, "Enter", true);
  expect(enters).toBe(0);
  key(box, "Enter");
  expect(enters).toBe(1);
  // Enter on an answer button is that button's, not the box's default.
  key(document.getElementById("answer")!, "Enter");
  expect(enters).toBe(1);
  done();
});

test("without a default, Enter answers nothing", () => {
  const { box, done } = mount(false);
  key(box, "Enter");
  expect(enters).toBe(0);
  expect(closes).toBe(0);
  done();
});

test("Esc closes the box and never reaches the stage behind it", () => {
  const { box, done } = mount(false);
  key(box, "Escape");
  expect(closes).toBe(1);
  expect(stage).toBe(0);
  done();
});

test("a press on the control or in the box keeps it open; a press elsewhere closes it", () => {
  const { done } = mount(false);
  press("trigger");
  press("answer");
  expect(closes).toBe(0);
  press("elsewhere");
  expect(closes).toBe(1);
  done();
});
