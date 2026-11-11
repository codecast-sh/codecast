import { expect, test } from "bun:test";
import { segmentsOf } from "./messageSegments";

test("plain text is one segment", () => {
  expect(segmentsOf("  fix the build  ")).toEqual([{ kind: "text", text: "fix the build" }]);
});

test("a paste folds to a chip that counts its lines; typed text around it stays", () => {
  const msg = 'look at this\n<pasted_content id="1">\nline one\n\nline two\n</pasted_content>\nwhy?';
  expect(segmentsOf(msg)).toEqual([
    { kind: "text", text: "look at this\n" },
    { kind: "paste", lines: 2 },
    { kind: "text", text: "\nwhy?" },
  ]);
});

test("a paste cut off by the snippet still folds", () => {
  expect(segmentsOf("see <pasted_content>\na\nb")).toEqual([{ kind: "text", text: "see " }, { kind: "paste", lines: 2 }]);
});

test("image markers become chips", () => {
  expect(segmentsOf("[Image 1] why is this blank")).toEqual([
    { kind: "image", label: "image 1" },
    { kind: "text", text: " why is this blank" },
  ]);
});
