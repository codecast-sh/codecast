import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { editorToMarks, marksToHtml } from "./boardMarks";

const fromHtml = (html: string) => {
  const dom = new JSDOM(`<div id=r>${html}</div>`);
  const out = editorToMarks(dom.window.document.getElementById("r")!);
  dom.window.close();
  return out;
};

describe("rich editor text", () => {
  test("stored marks survive the editor unchanged", () => {
    for (const t of [
      "plain",
      "**Launch** day plan\nRun the [checklist](https://x.dev) then\n- ship *web*\n- ship ~~mobile~~ desktop",
      "Title\n\nbody after a blank line",
    ]) {
      expect(fromHtml(marksToHtml(t))).toBe(t);
    }
  });
  test("what the browser makes while typing becomes marks", () => {
    expect(fromHtml("Ship <b>now</b><div>second <i>line</i></div><div><br></div><div>• item</div>")).toBe("Ship **now**\nsecond *line*\n\n- item");
    expect(fromHtml('<span style="font-weight: 700;">bold</span> and <strike>gone</strike>')).toBe("**bold** and ~~gone~~");
    expect(fromHtml('see <a href="javascript:x">trap</a>')).toBe("see trap");
  });
  test("marks keep surrounding spaces outside them", () => {
    expect(fromHtml("a<b> bold </b>b")).toBe("a **bold** b");
  });
});
