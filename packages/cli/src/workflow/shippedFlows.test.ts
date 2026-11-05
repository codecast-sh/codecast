import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { SHIPPED_FLOWS_SNAPSHOT_PATH, SHIPPED_FLOW_STATIONS_SNAPSHOT_PATH, renderShippedFlowsModule, renderShippedFlowStationsModule, shippedFlowStationsSnapshot, shippedFlowsSnapshot } from "./shippedFlows";

describe("the web's snapshot of the shipped pool", () => {
  test("matches the templates (regenerate: bun packages/cli/scripts/gen-shipped-flows.ts)", () => {
    const file = path.resolve(import.meta.dir, "../../../..", SHIPPED_FLOWS_SNAPSHOT_PATH);
    expect(fs.readFileSync(file, "utf-8")).toBe(renderShippedFlowsModule());
  });

  test("the stations snapshot matches the templates (same regenerate)", () => {
    const file = path.resolve(import.meta.dir, "../../../..", SHIPPED_FLOW_STATIONS_SNAPSHOT_PATH);
    expect(fs.readFileSync(file, "utf-8")).toBe(renderShippedFlowStationsModule());
  });

  test("carries each station's words once, by the expanded node id the graph draws", () => {
    const { texts, flows } = shippedFlowStationsSnapshot();
    expect(new Set(texts).size).toBe(texts.length);
    const graph = shippedFlowsSnapshot().find((f) => f.slug === "change")!;
    const reviewer = graph.nodes.find((n) => n.segment === "review" && n.type !== "exit" && flows.change[n.id as string]?.prompt !== undefined)!;
    expect(texts[flows.change[reviewer.id as string].prompt as number]).toContain("review");
    expect(flows.review.review.backend).toBe("session");
  });

  test("carries each flow's kind and its segments, and no station's words", () => {
    const change = shippedFlowsSnapshot().find((f) => f.slug === "change")!;
    expect(change.kind).toBe("line");
    expect(change.uses).toEqual(["check", "review", "decide", "ship", "deploy"]);
    expect(change.nodes.some((n) => "prompt" in n || "script" in n)).toBe(false);
  });
});
