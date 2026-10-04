import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_LINE_SNAPSHOT_PATH, renderShippedLineModule, shippedLineSnapshot } from "./shippedLine";

describe("the web's snapshot of the shipped line", () => {
  test("matches the template (regenerate: bun packages/cli/scripts/gen-shipped-line.ts)", () => {
    const file = path.resolve(import.meta.dir, "../../../..", SHIPPED_LINE_SNAPSHOT_PATH);
    expect(fs.readFileSync(file, "utf-8")).toBe(renderShippedLineModule());
  });

  test("names the file each referenced station ships in", () => {
    const snap = shippedLineSnapshot();
    expect(snap.files.ground).toEqual({ prompt: "line/ground.md" });
    expect(snap.files.red).toEqual({ script: "line/red.sh" });
    expect(snap.files.verify).toBeUndefined();
    const ground = snap.nodes.find((n) => n.id === "ground");
    expect(ground?.prompt?.startsWith("@")).toBe(false);
  });
});
