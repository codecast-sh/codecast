import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { processFile } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { fileDiffRenders } from "../../../test-helpers/pierreFileDiff";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { buildDiffModel } from "../../../lib/diffModel";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
class TestObserver { observe() {} unobserve() {} disconnect() {} }
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Document: dom.window.Document,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: TestObserver,
  IntersectionObserver: TestObserver,
  // Pierre schedules its window passes on frames; the stand-in FileDiff draws
  // nothing for them to measure, so they never run here.
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { PierreDiff } = await import("../PierreDiff");
const { drawableLines, VIRTUALIZE_LINE_THRESHOLD } = await import("../virtualizer");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const lines = (n: number, word = "line") => Array.from({ length: n }, (_, i) => `${word} ${i}`).join("\n") + "\n";

test("a diff's drawable rows are its whole file when it carries one, else its hunks", () => {
  const old = lines(3000);
  const changed = old.replace("line 1500\n", "changed 1500\n");
  const patch = createTwoFilesPatch("a.ts", "a.ts", old, changed);
  const whole = processFile(patch, { oldFile: { name: "a.ts", contents: old }, newFile: { name: "a.ts", contents: changed } })!;
  expect(drawableLines(whole)).toBeGreaterThan(VIRTUALIZE_LINE_THRESHOLD);
  const hunksOnly = processFile(patch)!;
  expect(drawableLines(hunksOnly)).toBeLessThan(20);
});

function render(n: number) {
  const model = buildDiffModel({ oldStr: lines(n, "old"), newStr: lines(n, "new") });
  return (
    <PierreDiff
      model={model}
      name="a.ts"
      lang="typescript"
      theme="dark"
      expandUnchanged={false}
      wrap={false}
      showLineNumbers
      lineAnnotations={[]}
      renderAnnotation={() => null}
    />
  );
}

test("diffs past the threshold draw windowed under one Virtualizer per scroller; short ones draw whole", async () => {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  document.body.append(scroller);
  const slots = [0, 1, 2].map(() => scroller.appendChild(document.createElement("div")));
  const roots = slots.map((slot) => createRoot(slot));
  fileDiffRenders.length = 0;
  await act(() => {
    roots[0].render(render(10));
    roots[1].render(render(150));
    roots[2].render(render(150));
  });
  const last = () => roots.map((_, i) => fileDiffRenders.filter((r) => r.fileDiff.name === "a.ts").at(-(3 - i)));
  const [short, longA, longB] = last();
  expect(short?.virtualizer).toBeUndefined();
  expect(short?.metrics).toBeUndefined();
  // 150 changed lines draw 300 rows.
  expect(longA?.virtualizer).toBeDefined();
  expect(longA?.metrics?.lineHeight).toBe(22);
  expect(longB?.virtualizer).toBe(longA?.virtualizer);
  expect(longA?.virtualizer?.getRoot()).toBe(scroller);

  // The last diff to leave cleans the Virtualizer up.
  const shared = longA!.virtualizer!;
  await act(() => roots[1].unmount());
  expect(shared.getRoot()).toBe(scroller);
  await act(() => roots[2].unmount());
  expect(shared.getRoot()).toBeUndefined();

  // A diff that grows past the threshold remounts windowed.
  fileDiffRenders.length = 0;
  await act(() => roots[0].render(render(150)));
  expect(fileDiffRenders.at(-1)?.virtualizer).toBeDefined();
  await act(() => roots[0].unmount());
  scroller.remove();
}, 30000);
