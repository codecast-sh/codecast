import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { toggleBullet } from "./boardEditCommands";

function setup(html: string) {
  const dom = new JSDOM(`<div id=r contenteditable>${html}</div>`);
  const doc = dom.window.document;
  const ed = doc.getElementById("r") as unknown as HTMLElement;
  const sel = dom.window.getSelection()!;
  return { dom, doc, ed, sel };
}

describe("the List button", () => {
  test("a caret in the first (bare) line bullets that line, not the caret spot", () => {
    const { dom, doc, ed, sel } = setup("Ship <b>it</b> today<div>second</div>");
    const r = doc.createRange();
    r.setStart(ed.querySelector("b")!.firstChild!, 1);
    r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    toggleBullet(ed, sel as unknown as Selection);
    expect(ed.innerHTML).toBe("• Ship <b>it</b> today<div>second</div>");
    dom.window.close();
  });
  test("a selection over two lines bullets both; again takes them off", () => {
    const { dom, doc, ed, sel } = setup("<div>one</div><div>two</div><div>three</div>");
    const divs = ed.querySelectorAll("div");
    const r = doc.createRange();
    r.setStart(divs[0].firstChild!, 1);
    r.setEnd(divs[1].firstChild!, 2);
    sel.removeAllRanges(); sel.addRange(r);
    toggleBullet(ed, sel as unknown as Selection);
    expect(ed.textContent).toBe("• one• twothree");
    toggleBullet(ed, sel as unknown as Selection);
    expect(ed.textContent).toBe("onetwothree");
    dom.window.close();
  });
});
