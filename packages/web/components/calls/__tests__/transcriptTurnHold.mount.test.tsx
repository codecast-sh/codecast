// A finger has no Shift key: on a touch screen a press and hold on a call's
// line starts a selection, and the click that hold ends in is spent (it does
// not also seek). A mouse press never holds. Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/transcriptTurnHold.mount.test.tsx
import { beforeAll, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let TranscriptTurnList: typeof import("../TranscriptTurns").TranscriptTurnList;
let LONG_PRESS_MS: number;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ TranscriptTurnList } = await import("../TranscriptTurns"));
  ({ LONG_PRESS_MS } = await import("../../../hooks/useLongPress"));
}, 120_000);

const turns = [
  { index: 0, speaker_id: "u-ann", speaker_name: "Ann", t0: 0, t1: 4_000, segments: [{ seq: 1, text: "First", t0: 0, t1: 4_000 }] },
  { index: 1, speaker_id: "u-bob", speaker_name: "Bob", t0: 4_000, t1: 9_000, segments: [{ seq: 2, text: "Second", t0: 4_000, t1: 9_000 }] },
] as any;

function pointer(el: Element, type: string, pointerType: string) {
  const e = new (window as any).MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  el.dispatchEvent(e);
}

async function mount() {
  const clicks: number[] = [];
  const holds: number[] = [];
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(TranscriptTurnList, {
        turns,
        isSelected: () => false,
        onTurnClick: (i: number) => clicks.push(i),
        onTurnHold: (i: number) => holds.push(i),
      }),
    );
  });
  const turn = (i: number) => host.querySelector(`[data-turn="${i}"]`)!;
  return { clicks, holds, turn, root };
}

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

test("a finger held on a line selects it, and its click is spent", async () => {
  const { clicks, holds, turn, root } = await mount();
  pointer(turn(1), "pointerdown", "touch");
  await wait(LONG_PRESS_MS + 50);
  expect(holds).toEqual([1]);
  pointer(turn(1), "pointerup", "touch");
  await act(async () => void (turn(1) as HTMLElement).click());
  expect(clicks).toEqual([]);
  // The next tap is a tap.
  await act(async () => void (turn(0) as HTMLElement).click());
  expect(clicks).toEqual([0]);
  await act(async () => root.unmount());
});

test("a short tap and a mouse press never hold", async () => {
  const { clicks, holds, turn, root } = await mount();
  // Released at once: a timed short wait can outlast the hold on a loaded machine.
  pointer(turn(0), "pointerdown", "touch");
  pointer(turn(0), "pointerup", "touch");
  await wait(LONG_PRESS_MS);
  pointer(turn(1), "pointerdown", "mouse");
  await wait(LONG_PRESS_MS + 50);
  expect(holds).toEqual([]);
  await act(async () => void (turn(1) as HTMLElement).click());
  expect(clicks).toEqual([1]);
  await act(async () => root.unmount());
});
