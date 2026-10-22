import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_FLOWS_SNAPSHOT_PATH, renderShippedFlowsModule, shippedFlowsSnapshot } from "./shippedFlows";

describe("the web's snapshot of the shipped pool", () => {
  test("matches the templates (regenerate: bun packages/cli/scripts/gen-shipped-flows.ts)", () => {
    const file = path.resolve(import.meta.dir, "../../../..", SHIPPED_FLOWS_SNAPSHOT_PATH);
    expect(fs.readFileSync(file, "utf-8")).toBe(renderShippedFlowsModule());
  });

  test("carries each flow's kind and its segments, and no station's words", () => {
    const change = shippedFlowsSnapshot().find((f) => f.slug === "change")!;
    expect(change.kind).toBe("line");
    expect(change.uses).toEqual(["check", "review", "decide", "ship"]);
    expect(change.nodes.some((n) => "prompt" in n || "script" in n)).toBe(false);
  });
});
