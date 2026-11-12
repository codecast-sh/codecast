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
