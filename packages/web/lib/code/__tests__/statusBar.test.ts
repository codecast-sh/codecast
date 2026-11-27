import { expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { cursorLabel, dropOrder, formatSegments } from "../statusBar";
import { fileFormatField } from "../buffers";

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

it("shows the line ending and encoding only when a file differs from LF and plain UTF-8", () => {
  const plain = EditorState.create({ doc: "x", extensions: [fileFormatField] });
  expect(formatSegments(plain)).toEqual({ language: "Plain Text", indent: "Spaces: 2", lineEnding: "", encoding: "", largeFile: "" });
  const crlf = EditorState.create({ doc: "x", extensions: [fileFormatField.init(() => ({ lineSeparator: "\r\n", bom: true, lossy: false }))] });
  expect(formatSegments(crlf)).toMatchObject({ lineEnding: "CRLF", encoding: "UTF-8 with BOM" });
});

it("the cursor segment's width covers its document's last line at a three-digit column", async () => {
  const { cursorWidthCh } = await import("../statusBar");
  expect(cursorWidthCh(120)).toBe("Ln 120, Col 999".length);
});

it("rows are whole pixels at any font size and line height", async () => {
  const { codeLineHeightPx } = await import("../setup");
  expect(codeLineHeightPx(13, 1.6)).toBe(21);
  expect(codeLineHeightPx(12, 1.6)).toBe(19);
  expect(codeLineHeightPx(14, 1.5)).toBe(21);
});
