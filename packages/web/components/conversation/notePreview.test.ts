import { describe, expect, test } from "bun:test";
import { notePreview } from "./HostedMadeLine";

describe("notePreview", () => {
  test("a note that leads with a table shows its head and first rows, separator skipped", () => {
    const content = "# 3-Day Camping Trip Packing List\n\n| Item | Qty | Packed |\n| --- | --- | --- |\n| Tent | 1 | [ ] |\n| **Stove** | 1 | [ ] |\n| Lantern | 2 | [ ] |\n| Rope | 1 | [ ] |";
    expect(notePreview(content, "3-Day Camping Trip Packing List")).toEqual({
      kind: "table",
      rows: [["Item", "Qty", "Packed"], ["Tent", "1", "[ ]"], ["Stove", "1", "[ ]"], ["Lantern", "2", "[ ]"]],
    });
  });

  test("otherwise its first three lines, list marks dropped", () => {
    expect(notePreview("- [ ] passport\n- charger\n1. snacks\n- book", "Packing")).toEqual({ kind: "lines", lines: ["passport", "charger", "snacks"] });
  });

  test("an empty note has no preview", () => {
    expect(notePreview("", "x")).toBeNull();
    expect(notePreview("# Only a heading", "Only a heading")).toBeNull();
  });
});
