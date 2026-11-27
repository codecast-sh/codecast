// The whole board view with a fold in it (pl-1145): select-all, a selection
// made before the fold and a comment on a held element all leave what the
// fold hides alone. Fails if BoardView stops reading the shown set. Also: the
// pill's count follows the live board, a duplicated pill lands by its own box,
// and a tapped frame shows its tools with no hover.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { collapseFrameOps } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const el = (key: string, kind: string, f: Record<string, any>) => ({ key, kind, rev: 1, ...f }) as BoardEl;
const open = [
  el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Budget caps" }),
  el("a", "sticky", { x: 40, y: 64, w: 200, h: 160, text: "held a" }),
  el("b", "sticky", { x: 300, y: 64, w: 200, h: 160, text: "held b" }),
  el("out", "sticky", { x: 900, y: 64, w: 200, h: 160, text: "outside" }),
];
const foldOps = collapseFrameOps({ elements: open, get: (k) => open.find((e) => e.key === k) }, "f");
const folded = open.map((e) => ({ ...e, ...foldOps.filter((o) => o.k === e.key).reduce((acc, o) => ({ ...acc, ...(o as any).set }), {}) }) as BoardEl);
const pill = folded.find((e) => e.key === "f")!;
// A comment someone left on sticky "a" before the frame folded.
const comment = el("c1", "comment", { anchor: "a", point: { x: 100, y: 100 }, text: "is this right?", author_name: "Ana Bee" });

let elements: BoardEl[] = open;
const realLive = { ...(await import("../live/useLiveArtifact")) };
mock.module("../live/useLiveArtifact", () => ({
  ...realLive,
  useLiveElements: () => elements,
  useLiveComments: () => [comment],
  useLivePresence: () => [],
}));
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...realConvex, useConvex: () => ({}) }));

const { createRoot } = await import("react-dom/client");
const { default: BoardView } = await import("./BoardView");

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const NOOP = () => {};
const live = {
  ready: true,
  draft: { active: false },
  canUndo: false,
  canRedo: false,
  apply: (ops: any[]) => { applied.push(...ops); },
  preview: NOOP, commit: NOOP, undo: NOOP, redo: NOOP, setPresence: NOOP, comment: NOOP,
} as any;
/** Every op the board applied. */
let applied: any[] = [];
let selected: string[] = [];
/** Every selection the board asked for, in order: a held key in any of them is a stale pick that escaped. */
let asked: string[][] = [];
function Host({ initial }: { initial: string[] }) {
  const [selection, setSel] = useState(initial);
  selected = selection;
  return (
    <BoardView
      doc={{ _id: "doc_board", title: "Huddle board", doc_type: "board" } as any}
      live={live}
      selection={selection}
      setSelection={(keys: string[]) => { asked.push(keys); setSel(keys); }}
      mode="edit"
      toScreen={NOOP}
      setToolbar={NOOP}
      setPanel={NOOP}
      setExports={NOOP}
      setImport={NOOP}
      {...({} as any)}
    />
  );
}
const q = (sel: string) => container.querySelector<HTMLElement>(sel);

afterAll(async () => {
  await act(() => root.unmount());
  restoreGlobals();
  closeDomWindow(dom);
});

describe("a board with a fold", () => {
  test("a selection made before the fold drops what the fold now hides", async () => {
    elements = open;
    await act(() => root.render(<Host initial={["a", "out"]} />));
    expect(selected).toEqual(["a", "out"]);
    elements = folded;
    await act(() => root.render(<Host initial={["a", "out"]} />));
    expect(selected).toEqual(["out"]);
    expect(q('[data-key="a"]')).toBeNull();
    expect(q('[data-key="f"]')!.classList.contains("board-frame-pill")).toBe(true);
  });

  test("select-all picks what is on the canvas, never what the fold holds", async () => {
    elements = folded;
    await act(() => root.render(<Host initial={[]} />));
    asked = [];
    const board = q("[data-board]")!;
    await act(() => {
      board.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      board.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", metaKey: true, ctrlKey: true, bubbles: true }));
    });
    expect([...selected].sort()).toEqual(["f", "out"]);
    expect(asked.length).toBeGreaterThan(0);
    for (const keys of asked) expect(keys.filter((k) => k === "a" || k === "b")).toEqual([]);
  });

  test("a comment on a held element pins to the pill", async () => {
    elements = folded;
    await act(() => root.render(<Host initial={[]} />));
    const pin = q(".board-pin")!;
    expect(pin).not.toBeNull();
    // The pill's top-right corner, not the held sticky's spot (100, 100) inside the fold.
    expect(parseFloat(pin.style.left)).toBe(Number(pill.x) + Number(pill.w) - 8);
    expect(parseFloat(pin.style.top)).toBe(Number(pill.y) - 8);
  });
});

describe("a pill on the live board", () => {
  test("its count follows what it holds as held elements are deleted and come back", async () => {
    elements = folded;
    await act(() => root.render(<Host initial={[]} />));
    const count = () => q('[data-key="f"] .board-frame-pill-count')!.textContent;
    expect(count()).toBe("(2)");
    elements = folded.filter((e) => e.key !== "a");
    await act(() => root.render(<Host initial={[]} />));
    expect(count()).toBe("(1)");
    elements = folded;
    await act(() => root.render(<Host initial={[]} />));
    expect(count()).toBe("(2)");
  });

  test("duplicated, it lands beside its own box, not beside the footprint of what it holds", async () => {
    elements = folded;
    // A fresh mount: the host keeps its selection across renders.
    await act(() => root.render(<Host key="dup" initial={["f"]} />));
    expect(selected).toEqual(["f"]);
    applied = [];
    const board = q("[data-board]")!;
    await act(() => {
      board.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "d", metaKey: true, ctrlKey: true, bubbles: true }));
    });
    const copy = applied.find((o) => o.put?.kind === "frame");
    expect(copy).toBeDefined();
    // A gap of 24 to the pill's right, at its height: the held stickies (down to y 224) and the sticky
    // outside at x 900 are not in the way of a 48-tall pill.
    expect(copy.put.x).toBe(Math.round(Number(pill.x) + Number(pill.w) + 24));
    expect(copy.put.y).toBe(Number(pill.y));
    // What it holds is copied with it, by the same offset, and folded into the copy.
    const dx = copy.put.x - Number(pill.x);
    const heldCopies = applied.filter((o) => o.put?.kind === "sticky");
    expect(heldCopies.map((o) => o.put.x).sort((m: number, n: number) => m - n)).toEqual([40 + dx, 300 + dx]);
    expect([...copy.put.collapsed.holds].sort()).toEqual(heldCopies.map((o) => o.k).sort());
  });
});

describe("an open frame on a touch screen", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("./board.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  const tap = (node: HTMLElement, type: string) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 10 });
    Object.defineProperty(e, "pointerType", { value: "touch" });
    Object.defineProperty(e, "pointerId", { value: 7 });
    node.dispatchEvent(e);
  };
  const tools = () => q('[data-key="f"] > .board-frame-tools')!;

  test("a tap on its title selects it and shows Reflow and Collapse, with no hover", async () => {
    elements = open;
    await act(() => root.render(<Host key="tap" initial={[]} />));
    expect(selected).toEqual([]);
    expect(q('[data-key="f"]')!.classList.contains("is-hovered")).toBe(false);
    expect(getComputedStyle(tools()).opacity).toBe("0");
    const title = q('[data-key="f"] [data-part=frame-title]')!;
    await act(() => { tap(title, "pointerdown"); tap(title, "pointerup"); });
    expect(selected).toEqual(["f"]);
    expect(q('[data-key="f"]')!.classList.contains("is-hovered")).toBe(false);
    expect(q('[data-key="f"]')!.classList.contains("is-selected")).toBe(true);
    expect(getComputedStyle(tools()).opacity).toBe("1");
    expect(getComputedStyle(tools()).pointerEvents).toBe("auto");
    expect(tools().querySelector('[aria-label="Reflow frame"]')).not.toBeNull();
    expect(tools().querySelector('[aria-label="Collapse frame"]')).not.toBeNull();
  });

  test("its tool buttons are 44px on a coarse pointer", () => {
    const sheet = style.sheet!;
    const coarse = [...sheet.cssRules].filter((r): r is CSSMediaRule => (r as CSSMediaRule).media?.mediaText.includes("pointer: coarse"));
    const rule = coarse.flatMap((m) => [...m.cssRules] as CSSStyleRule[]).find((r) => r.selectorText === ".board-frame-tools .board-bar-btn");
    expect(rule).toBeDefined();
    expect(rule!.style.minWidth).toBe("44px");
    expect(rule!.style.height).toBe("44px");
  });
});
