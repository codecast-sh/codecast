import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Chrome reports a selection made inside a shadow root as collapsed at the
// host, with its text intact; only getComposedRanges, handed the root, says
// where the words are. jsdom has no selection engine, so the Selection here is
// a stand-in shaped the way Chrome answers (measured with Selection.modify on
// Chrome 158).

let dom: JSDOM;
let liveSelectionRange: typeof import("../quoteSelection").liveSelectionRange;
let CANVAS_HOST_CLASS: string;

beforeAll(async () => {
  // Imported before the window exists, so the store it reaches does not boot.
  ({ liveSelectionRange } = await import("../quoteSelection"));
  ({ CANVAS_HOST_CLASS } = await import("../quoteUnits"));
  dom = new JSDOM(`<div class="cc-msg-review"><div class="cc-content"><p id="prose">Prose words</p><div id="host"></div></div></div>`);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, ShadowRoot: dom.window.ShadowRoot });
  const host = dom.window.document.getElementById("host")!;
  host.className = CANVAS_HOST_CLASS;
  host.attachShadow({ mode: "open" }).innerHTML = "<p>Being fun to be with</p>";
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).ShadowRoot;
  closeDomWindow(dom);
});

function stubSelection(sel: Partial<Selection>) {
  (dom.window as unknown as { getSelection: () => Partial<Selection> }).getSelection = () => sel;
}

function canvasText(): Text {
  return dom.window.document.getElementById("host")!.shadowRoot!.querySelector("p")!.firstChild as Text;
}

describe("liveSelectionRange", () => {
  test("finds a selection inside a canvas that the document reports collapsed", () => {
    const text = canvasText();
    let rootsAsked: ShadowRoot[] = [];
    stubSelection({
      rangeCount: 1,
      isCollapsed: true,
      toString: () => "Being fun",
      getComposedRanges: ((opts: { shadowRoots: ShadowRoot[] }) => {
        rootsAsked = opts.shadowRoots;
        return [{ startContainer: text, startOffset: 0, endContainer: text, endOffset: 9, collapsed: false }];
      }) as unknown as Selection["getComposedRanges"],
    });
    const range = liveSelectionRange();
    expect(rootsAsked).toEqual([text.getRootNode() as ShadowRoot]);
    expect(range?.toString()).toBe("Being fun");
    expect(range?.startContainer).toBe(text);
  });

  test("a caret returns before asking for composed ranges", () => {
    let asked = false;
    stubSelection({
      rangeCount: 1,
      isCollapsed: true,
      toString: () => "",
      getComposedRanges: (() => { asked = true; return []; }) as unknown as Selection["getComposedRanges"],
    });
    expect(liveSelectionRange()).toBeNull();
    expect(asked).toBe(false);
  });

  test("a selection in the transcript's own prose is the document's range", () => {
    const prose = dom.window.document.getElementById("prose")!.firstChild!;
    const range = dom.window.document.createRange();
    range.setStart(prose, 0);
    range.setEnd(prose, 5);
    stubSelection({ rangeCount: 1, isCollapsed: false, toString: () => "Prose", getRangeAt: () => range });
    expect(liveSelectionRange()).toBe(range);
  });
});
