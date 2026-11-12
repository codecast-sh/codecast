import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as { DOMParser?: unknown }).DOMParser = dom.window.DOMParser;
afterAll(() => {
  delete (globalThis as { DOMParser?: unknown }).DOMParser;
  closeDomWindow(dom);
});

describe("pasting a web table", () => {
  test("text, bold, fill, alignment and a colspan merge come through", async () => {
    const { htmlTable } = await import("./pasteHtml");
    const t = htmlTable(
      '<meta charset="utf-8"><table><tr><th>Item</th><td style="background-color:rgb(255,242,204);text-align:right">$12.50</td></tr>' +
        '<tr><td colspan="2"><span style="font-weight:700">Total</span></td></tr></table>',
    )!;
    expect(t.grid).toEqual([["Item", "$12.50"], ["Total"]]);
    expect(t.styles).toEqual([
      { col: 1, row: 1, style: { b: true } },
      { col: 2, row: 1, style: { fill: "yellow", al: "right" } },
      { col: 1, row: 2, style: { b: true } },
    ]);
    expect(t.merges).toEqual([{ c0: 1, r0: 2, c1: 2, r1: 2 }]);
    expect(htmlTable("just text")).toBeNull();
  });
});

describe("pasting from Google Sheets", () => {
  test("formulas come in as A1 for where they land; line breaks stay", async () => {
    const { htmlTable, r1c1ToA1 } = await import("./pasteHtml");
    expect(r1c1ToA1("=R[0]C[-1]*2+SUM(R1C1:R[-1]C)", 3, 5)).toBe("=B5*2+SUM($A$1:C4)");
    expect(r1c1ToA1('=ROUND(R[0]C[-2],2)&"R1C1"', 4, 2)).toBe('=ROUND(B2,2)&"R1C1"');
    const t = htmlTable('<table><tr><td>5</td><td data-sheets-formula="=R[0]C[-1]*2">10</td><td>Line<br>two</td></tr></table>', { col: 2, row: 3 })!;
    expect(t.grid[0]).toEqual(["5", "=B3*2", "Line\ntwo"]);
  });
});
