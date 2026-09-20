import { describe, expect, test } from "bun:test";
import { orgProposalRowFromSpec } from "./orgPreviewSpec";

const change = (handle: string) => ({ change: { kind: "role", name: handle, handle, tenure: { kind: "standing" }, reports_to: "me" }, rationale: "why" });

describe("orgProposalRowFromSpec", () => {
  test("a spec becomes the open proposal the page paints, with its asks over its rows", () => {
    const row = orgProposalRowFromSpec({ title: "T", summary_md: "S", mode: "review", changes: [change("calling"), change("broker")], asks: [{ title: "Both", why: "w", effect: "e", seqs: [1, 2] }] }, "team-1", 5);
    expect(row?.changes.map((c) => [c.seq, c.status])).toEqual([[1, "proposed"], [2, "proposed"]]);
    expect(row?.asks).toEqual([{ title: "Both", why: "w", effect: "e", seqs: [1, 2] }]);
    expect(row?.status).toBe("open");
  });

  test("a spec the post would refuse paints nothing", () => {
    expect(orgProposalRowFromSpec({ title: "T", summary_md: "S", mode: "review", changes: [change("calling"), change("broker")], asks: [{ title: "x", why: "w", effect: "e", seqs: [1] }] })).toBeNull();
    expect(orgProposalRowFromSpec("not a spec")).toBeNull();
  });
});
