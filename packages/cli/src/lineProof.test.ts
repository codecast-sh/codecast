// A line cause's proof is checked against the run records, never taken on a
// comment (line-map.md LX6). The runs here are shaped like ct-57458's: two
// runs whose prove station failed with no outgoing edge, one that went on.
import { describe, expect, test } from "bun:test";
import { checkLineProof, parseLineProof, type RecordedRun } from "./lineProof";

const RUNS: RecordedRun[] = [
  { _id: "th70qzy94nqkgp9dvz1yygd4t58fspgc", status: "failed", fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)", node_statuses: [{ node_id: "ground", status: "completed", outcome: "success" }, { node_id: "prove", status: "failed" }] },
  { _id: "th7f0c6865350cbqxbqj1yv5j18fvbw5", status: "completed", node_statuses: [{ node_id: "prove", status: "completed", outcome: "success" }, { node_id: "red", status: "completed", outcome: "success" }] },
];
const runsOf = async (task: string) => (task === "ct-57458" ? RUNS : []);
const claim = (over: Record<string, string>) => ({ task: "ct-57458", run: "th70qzy", station: "prove", status: "failed", ...over });

describe("checkLineProof", () => {
  test("holds when every claim matches its recorded run, by id prefix", async () => {
    const r = await checkLineProof({ runs: [claim({ fail_reason: "No outgoing edge from prove" })] }, runsOf);
    expect(r.ok).toBe(true);
    expect(r.why).toContain("1 recorded run shows it");
  });

  test("a claimed status the record does not hold fails", async () => {
    const r = await checkLineProof({ runs: [claim({ run: "th7f0c6" })] }, runsOf);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("prove is recorded completed, not failed");
  });

  test("a fail reason the run never gave fails", async () => {
    const r = await checkLineProof({ runs: [claim({ fail_reason: "timed out" })] }, runsOf);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("does not say \"timed out\"");
  });

  test("an unknown run, a station the run never reached, or another task's run fails", async () => {
    expect((await checkLineProof({ runs: [claim({ run: "th7nope" })] }, runsOf)).ok).toBe(false);
    expect((await checkLineProof({ runs: [claim({ run: "th7f0c6", station: "implement", status: "completed" })] }, runsOf)).why).toContain("never reached implement");
    expect((await checkLineProof({ runs: [claim({ task: "ct-1" })] }, runsOf)).ok).toBe(false);
  });

  test("one bad claim among good ones fails the proof", async () => {
    const r = await checkLineProof({ runs: [claim({}), claim({ run: "th7f0c6" })] }, runsOf);
    expect(r.ok).toBe(false);
    expect(r.why).toStartWith("1 of 2 claims");
  });
});

describe("parseLineProof", () => {
  test("a proof with no runs, or a claim that names nothing checkable, is refused", () => {
    expect(parseLineProof({})).toEqual({ error: expect.stringContaining("names no runs") });
    expect(parseLineProof({ runs: [] })).toEqual({ error: expect.stringContaining("names no runs") });
    expect(parseLineProof({ runs: [{ task: "ct-1", run: "th7a" }] })).toEqual({ error: "runs[0] has no station" });
    expect(parseLineProof({ runs: [{ task: "ct-1", run: "th7a", station: "prove", shows: "it broke" }] })).toEqual({ error: expect.stringContaining("says nothing the record can confirm") });
  });
});
