// Theme frames on the canvas (pl-1145): the pill a fold draws, the chip
// title, the hover controls' wiring, what the canvas and export skip, and how
// a pill is hit.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { collapseFrameOps } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Event: dom.window.Event,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// The chip's object, as the resolver would hand it back: ct-1 was made in call t1, whose board is doc_board.
const rows: Record<string, { served: boolean; entity: any }> = {
  "ct-1": { served: true, entity: { short_id: "ct-1", title: "Ship the board", from_call: "t1" } },
  "ct-9": { served: true, entity: null },
};
const realEntity = { ...(await import("../../lib/entityDisplay")) };
mock.module("../../lib/entityDisplay", () => ({
  ...realEntity,
  useEntityResolution: (ref: string) => ({ ...(rows[ref] ?? { served: false, entity: null }), rawId: ref, type: "task", status: undefined, label: ref, fullLabel: ref, shortLabel: ref, href: "" }),
}));
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: (_q: unknown, args: any) => ({ data: args === "skip" ? undefined : args.ref === "t1" ? { board: "doc_board" } : { board: null }, error: undefined, retry() {} }),
}));
const realPill = { ...(await import("../EntityIdPill")) };
mock.module("../EntityIdPill", () => ({ ...realPill, EntityIdPill: ({ shortId }: { shortId: string }) => <a data-pill={shortId}>{shortId}</a> }));

const { createRoot } = await import("react-dom/client");
const { BoardElementView } = await import("./BoardElements");
const { BoardFrameContext } = await import("./BoardFrameParts");
const { boardFolds } = await import("./boardFolds");
const { hitKey } = await import("./useBoardGestures");
const { boardSvg } = await import("./boardExport");

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const NOOP = () => {};
const el = (key: string, kind: string, f: Record<string, any>) => ({ key, kind, rev: 1, ...f }) as BoardEl;

const board = [
  el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Budget caps" }),
  el("a", "sticky", { x: 40, y: 64, w: 200, h: 160, text: "held a" }),
  el("b", "sticky", { x: 300, y: 64, w: 200, h: 160, text: "held b" }),
  el("ab", "connector", { from: "a", to: "b" }),
  el("out", "sticky", { x: 900, y: 64, w: 200, h: 160, text: "outside" }),
];
function fold(els: BoardEl[], key: string): BoardEl[] {
  const ops = collapseFrameOps({ elements: els, get: (k) => els.find((e) => e.key === k) }, key);
  return els.map((e) => {
    const set = ops.filter((o) => o.k === e.key && "set" in o).reduce((acc, o) => ({ ...acc, ...(o as any).set }), {});
    return { ...e, ...set } as BoardEl;
  });
}
const folded = fold(board, "f");
const byKey = new Map(folded.map((e) => [e.key, e]));

type Calls = { reflow: string[]; toggleFold: string[] };
async function draw(els: BoardEl[], opts: { readOnly?: boolean; docId?: string } = {}): Promise<Calls> {
  const calls: Calls = { reflow: [], toggleFold: [] };
  // The board knows every element, drawn or folded away.
  const all = new Map([...byKey, ...els.map((e) => [e.key, e] as const)]);
  const actions = {
    docId: opts.docId ?? "doc_board",
    readOnly: !!opts.readOnly,
    reflow: (k: string) => calls.reflow.push(k),
    toggleFold: (k: string) => calls.toggleFold.push(k),
    kindOf: (k: string) => all.get(k)?.kind,
  };
  await act(() => root.render(
    <BoardFrameContext.Provider value={actions}>
      {els.filter((e) => e.kind !== "connector").map((e) => <BoardElementView key={e.key} el={e} editing={false} onEditInput={NOOP} onEditDone={NOOP} />)}
    </BoardFrameContext.Provider>,
  ));
  return calls;
}
const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const click = async (node: HTMLElement | null) => {
  expect(node).not.toBeNull();
  await act(() => { node!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
};

afterAll(async () => {
  await act(() => root.unmount());
  restoreGlobals();
  closeDomWindow(dom);
});

describe("a folded frame", () => {
  test("draws as a pill reading its title and how many things it holds; the canvas skips what it holds", async () => {
    await draw(boardFolds(folded, byKey).shown);
    const pill = q('[data-key="f"]')!;
    expect(pill.classList.contains("board-frame-pill")).toBe(true);
    expect(pill.textContent).toContain("Budget caps");
    expect(pill.querySelector(".board-frame-pill-count")!.textContent).toBe("(2)");
    expect(q('[data-key="a"]')).toBeNull();
    expect(q('[data-key="b"]')).toBeNull();
    expect(q('[data-key="out"]')).not.toBeNull();
  });
  test("its chevron expands it, once", async () => {
    const calls = await draw([folded[0]]);
    await click(q('[aria-label="Expand frame"]'));
    expect(calls.toggleFold).toEqual(["f"]);
    expect(calls.reflow).toEqual([]);
  });
  test("a read-only viewer sees the chevron but cannot press it", async () => {
    await draw([folded[0]], { readOnly: true });
    expect(q('[aria-label="Expand frame"]')).toBeNull();
    expect(q(".board-frame-pill-chev")).not.toBeNull();
  });
  test("a pill is hit as a whole, while an open frame's body is canvas", async () => {
    await draw([folded[0], el("g", "frame", { x: 2000, y: 0, w: 400, h: 300, title: "Open" })]);
    expect(hitKey(q('[data-key="f"] .board-frame-pill-count'))).toBe("f");
    expect(hitKey(q('[data-key="g"]'))).toBeNull();
    expect(hitKey(q('[data-key="g"] [data-part=frame-title]'))).toBe("g");
  });
});

describe("an open frame's hover controls", () => {
  test("Reflow and Collapse each call their action once, for this frame", async () => {
    const calls = await draw([board[0]]);
    const tools = q(".board-frame-tools")!;
    expect(tools.hasAttribute("data-board-ui")).toBe(true);
    await click(q('[aria-label="Reflow frame"]'));
    expect(calls).toEqual({ reflow: ["f"], toggleFold: [] });
    await click(q('[aria-label="Collapse frame"]'));
    expect(calls).toEqual({ reflow: ["f"], toggleFold: ["f"] });
  });
  test("a read-only board has none", async () => {
    await draw([board[0]], { readOnly: true });
    expect(q(".board-frame-tools")).toBeNull();
  });
});

describe("a frame titled by an object", () => {
  test("shows its status tag, the object's chip and a new mark when this board's call made it", async () => {
    await draw([el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Budget", ref: "ct-1", status: "decided" })]);
    const title = q("[data-part=frame-title]")!;
    expect(title.querySelector(".board-frame-status.is-decided")!.textContent).toBe("decided");
    expect(title.querySelector('[data-pill="ct-1"]')).not.toBeNull();
    expect(title.querySelector(".board-frame-new")).not.toBeNull();
    // The chip takes its own press (link, hover card) instead of starting a drag.
    expect(title.querySelector('[data-pill="ct-1"]')!.closest("[data-board-ui]")).not.toBeNull();
  });
  test("no new mark on another call's board", async () => {
    await draw([el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Budget", ref: "ct-1" })], { docId: "doc_other" });
    expect(q(".board-frame-new")).toBeNull();
    expect(q(".board-frame-status")).toBeNull();
  });
  test("an object the viewer can't read falls back to the frame's title", async () => {
    await draw([el("f", "frame", { x: 0, y: 0, w: 600, h: 400, title: "Parked idea", ref: "ct-9", status: "parked" })]);
    const title = q("[data-part=frame-title]")!;
    expect(title.querySelector("[data-pill]")).toBeNull();
    expect(title.textContent).toBe("parkedParked idea");
  });
});

describe("export", () => {
  test("draws the pill and leaves out what it holds", async () => {
    const svg = await boardSvg({ elements: folded, byKey, root: container });
    expect(svg).not.toContain("held a");
    expect(svg).not.toContain("held b");
    expect(svg).toContain("outside");
    expect(svg).toContain("Budget caps (2)");
    expect(svg).toContain('data-folded="f"');
  });
});
