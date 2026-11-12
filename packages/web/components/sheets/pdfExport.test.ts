import { describe, expect, test } from "bun:test";
import { foldOps, toElement, type ArtifactElement, type ArtifactOp } from "@codecast/shared/artifacts";
import { LiveSheet } from "./sheetCore";
import { sheetPdf } from "./pdfExport";

describe("PDF export", () => {
  test("a tab becomes a well-formed PDF with its shown values, one page per screenful of rows", () => {
    const ops: ArtifactOp[] = [
      { k: "tab:S", put: { kind: "tab", name: "Budget (Q4)", order: 0, frozen_rows: 1 } },
      { k: "c:S!A1", put: { kind: "cell", input: "Item", b: true, fill: "blue" } },
      { k: "c:S!B1", put: { kind: "cell", input: "Cost" } },
    ];
    for (let r = 2; r <= 80; r++) ops.push({ k: `c:S!A${r}`, put: { kind: "cell", input: `Line ${r}` } }, { k: `c:S!B${r}`, put: { kind: "cell", input: "€1,200.50" } });
    const live = new LiveSheet();
    live.update([...foldOps(new Map(), ops)].map(([k, st]) => toElement(k, st)) as ArtifactElement[]);
    const bytes = sheetPdf(live.model, live.wb, "S");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(Budget \\(Q4\\)) Tj");
    expect(text).toContain("(\\2001,200.50) Tj");
    expect(Number(text.match(/\/Count (\d+)/)![1])).toBeGreaterThan(1);
    // Every object offset in the xref points at "N 0 obj".
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1]);
    const offsets = text.slice(xrefAt).match(/^\d{10} 00000 n $/gm)!.map((l) => Number(l.slice(0, 10)));
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
