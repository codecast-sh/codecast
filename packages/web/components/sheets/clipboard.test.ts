// Copy and paste inside a sheet keep formulas even though the system
// clipboard (Chrome) keeps only text/plain and text/html.
import { describe, expect, test } from "bun:test";
import { foldOps, toElement, type ArtifactElement, type ArtifactOp } from "@codecast/shared/artifacts";
import { LiveSheet } from "./sheetCore";
import { pasteSheetClipboard, writeSheetClipboard, type SheetCtx } from "./sheetActions";

function sheet(inputs: Record<string, string>) {
  const ops: ArtifactOp[] = [{ k: "tab:Sheet1", put: { kind: "tab", name: "Sheet1", order: 0 } }];
  for (const [a1, input] of Object.entries(inputs)) ops.push({ k: `c:Sheet1!${a1}`, put: { kind: "cell", input } });
  const state = foldOps(new Map(), ops);
  const live = new LiveSheet();
  live.update([...state].map(([k, s]) => toElement(k, s)) as ArtifactElement[]);
  return live;
}

/** A clipboard that, like Chrome's, drops every type but text and HTML between copy and paste. */
function systemClipboard() {
  const stored = new Map<string, string>();
  const event = () => ({ preventDefault() {}, clipboardData: { setData: (t: string, v: string) => { if (t === "text/plain" || t === "text/html") stored.set(t, v); }, getData: (t: string) => stored.get(t) ?? "" } }) as any;
  return { event };
}

function ctx(live: LiveSheet, rect: { c0: number; r0: number; c1: number; r1: number }, applied: ArtifactOp[][]): SheetCtx {
  const tab = live.model.byId.get("Sheet1")!;
  const S = { current: { model: live.model, wb: live.wb, tab, activeTabId: "Sheet1", sel: { anchor: { col: rect.c0, row: rect.r0 }, focus: { col: rect.c1, row: rect.r1 } }, rect, hiddenRows: new Set<number>(), readOnly: false } };
  return { S, docId: "doc1", pasteValuesRef: { current: false }, apply: (ops: ArtifactOp[]) => applied.push(ops), select: () => {}, setCopyRect: () => {}, move: () => {} } as unknown as SheetCtx;
}

describe("sheet clipboard", () => {
  test("a copy pasted through a text+HTML-only clipboard keeps formulas, shifted", () => {
    const live = sheet({ A1: "1", B1: "2", C1: "=A1+B1" });
    const clip = systemClipboard();
    const applied: ArtifactOp[][] = [];
    writeSheetClipboard(clip.event(), false, ctx(live, { c0: 3, r0: 1, c1: 3, r1: 1 }, applied));
    pasteSheetClipboard(clip.event(), ctx(live, { c0: 4, r0: 2, c1: 4, r1: 2 }, applied));
    const put = applied.flat().find((op) => op.k === "c:Sheet1!D2") as any;
    expect(put?.put?.input ?? put?.set?.input).toBe("=B2+C2");
  });

  test("text from elsewhere still pastes as values", () => {
    const live = sheet({ A1: "1" });
    const applied: ArtifactOp[][] = [];
    const e = { preventDefault() {}, clipboardData: { getData: (t: string) => (t === "text/plain" ? "x\ty" : "") } } as any;
    pasteSheetClipboard(e, ctx(live, { c0: 1, r0: 3, c1: 1, r1: 3 }, applied));
    const ops = applied.flat() as any[];
    expect(ops.find((o) => o.k === "c:Sheet1!B3")?.put?.input).toBe("y");
  });
});
