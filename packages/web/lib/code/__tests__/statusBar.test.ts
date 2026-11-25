import { expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { cursorLabel, dropOrder } from "../statusBar";

const at = (doc: string, head: number) => cursorLabel(EditorState.create({ doc, selection: { anchor: head }, extensions: EditorState.tabSize.of(4) }));

it("counts columns with tabs expanded before the cursor", () => {
  expect(at("\tab", 0)).toBe("Ln 1, Col 1");
  expect(at("\tab", 1)).toBe("Ln 1, Col 5");
  expect(at("a\tb\tc", 5)).toBe("Ln 1, Col 10");
  expect(at("x\nab\tc", 5)).toBe("Ln 2, Col 5");
});

it("counts characters on a very long line instead of scanning it", () => {
  const line = `\t${"x".repeat(20_000)}`;
  expect(at(line, line.length)).toBe(`Ln 1, Col ${line.length + 1}`);
});

it("a narrow bar drops the lowest priorities first, the later one first between equals", () => {
  // vim mode, branch, cursor, file format, server chip, selection
  expect(dropOrder([100, 20, 90, 30, 40, 30])).toEqual([1, 5, 3, 4, 2, 0]);
});
