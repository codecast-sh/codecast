import { describe, expect, test } from "bun:test";
import { notePreview, numericColumns } from "./HostedMadeLine";

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

describe("numericColumns", () => {
  test("a column of quantities is figures; the text columns are not", () => {
    const rows = [["Item", "Quantity", "Notes"], ["Tent with rainfly", "1", "Shelter; October nights"], ["Sleeping bag (20F)", "2", "Warm enough"]];
    expect([...numericColumns(rows)]).toEqual([1]);
  });

  test("prices and ranges count as figures, a header alone decides nothing", () => {
    expect([...numericColumns([["Model", "Price"], ["Roborock Q7", "$299"], ["eufy L35", "~$250"]])]).toEqual([1]);
    expect(numericColumns([["Only", "A header"]]).size).toBe(0);
  });
});
