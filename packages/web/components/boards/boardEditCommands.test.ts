import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { toggleBullet } from "./boardEditCommands";
import { editorToMarks } from "./boardMarks";

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
    expect(editorToMarks(ed)).toBe("- Ship **it** today\nsecond");
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
    expect(editorToMarks(ed)).toBe("- one\n- two\nthree");
    // The whole sticky: a mixed selection bullets the line that lacks one; again takes them all off.
    const r2 = doc.createRange();
    r2.selectNodeContents(ed);
    sel.removeAllRanges(); sel.addRange(r2);
    toggleBullet(ed, sel as unknown as Selection);
    expect(editorToMarks(ed)).toBe("- one\n- two\n- three");
    const r3 = doc.createRange();
    r3.selectNodeContents(ed);
    sel.removeAllRanges(); sel.addRange(r3);
    toggleBullet(ed, sel as unknown as Selection);
    expect(editorToMarks(ed)).toBe("one\ntwo\nthree");
    dom.window.close();
  });
  test("lines broken with Shift+Enter (<br>) are lines too", () => {
    const { dom, doc, ed, sel } = setup("<div>Title<br>first<br>second</div>");
    const div = ed.querySelector("div")!;
    const r = doc.createRange();
    r.setStart(div.childNodes[2], 1);
    r.setEnd(div.childNodes[4], 3);
    sel.removeAllRanges(); sel.addRange(r);
    toggleBullet(ed, sel as unknown as Selection);
    expect(editorToMarks(ed)).toBe("Title\n- first\n- second");
    dom.window.close();
  });
});

describe("saving formatted text", () => {
  test("bold across a Shift+Enter break is saved as bold on each line", () => {
    const { dom, ed } = setup("<div><b>Pricing page<br>SSO tier</b></div>");
    expect(editorToMarks(ed)).toBe("**Pricing page**\n**SSO tier**");
    dom.window.close();
  });
});
