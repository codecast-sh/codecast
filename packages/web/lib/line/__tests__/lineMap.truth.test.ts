// Data truth for a run's visits (line-workspace.md LW2), and for a ref
// carried in the URL.
import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { runVisits, type MapDecision } from "../lineMap";
import { lineRefHref, lineRefOf } from "../lineWorkspaceUrl";
import * as F from "./lineFixtures";

const { HOUR } = F;

describe("loops: a gate round counts only for an answer", () => {
  test("a withdrawn card on the run adds no round", () => {
    const withdrawn: MapDecision = { _id: "dec_w", short_id: "sd-9", status: "withdrawn", blocking: true, task_id: "task_a", workflow_run_id: "run_a", gate_node_id: "decide", created_at: F.runA.created_at + 30 * HOUR, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }] };
    const base = runVisits(F.runA, SHIPPED_LINE, F.decisionsA).map((v) => v.node);
    expect(runVisits(F.runA, SHIPPED_LINE, [...F.decisionsA, withdrawn]).map((v) => v.node)).toEqual(base);
  });
});

describe("a ref from the URL", () => {
  test("survives the router's own decoding: a fingerprint with a percent sign does not throw", () => {
    for (const ref of ["ct-101", "aw:c-42", "load:100%", "  sg-3 "]) {
      const segment = lineRefHref(ref).split("/").pop()!;
      expect(lineRefOf(segment)).toBe(ref.trim());
      // The router may hand the segment over decoded already.
      expect(lineRefOf(decodeURIComponent(segment))).toBe(ref.trim());
    }
  });
});
