import { describe, expect, test } from "bun:test";
import { fixHolder, reviewGates, reviewMove, sendBackNote } from "../fixReview";
import { branchStanding } from "../mergeFixLedger";

const nodes = (s: string) => s.split(" ").map((x) => { const [node_id, status] = x.split(":"); return { node_id, status }; });

describe("reviewGates", () => {
  test("the first failed gate of the last build is red; the ones after it did not run then", () => {
    // ct-58682: Verify failed on the last build; Test, Eval and Review are an earlier round's records.
    const g = reviewGates(nodes("implement:failed verify:failed green:completed eval:completed review:completed"), { step: "verify", words: "Verify: typecheck red" });
    expect(g.map((x) => `${x.name}:${x.state}`)).toEqual(["Verify:red", "Test:skipped", "Eval:skipped", "Review:skipped"]);
    expect(g[0].words).toBe("typecheck red");
  });

  test("gates before the red one passed", () => {
    // ct-57567: Eval left red.
    const g = reviewGates(nodes("implement:failed verify:completed green:completed eval:failed"));
    expect(g.map((x) => `${x.name}:${x.state}`)).toEqual(["Verify:pass", "Test:pass", "Eval:red"]);
  });

  test("a review with no card after it asked for changes", () => {
    const g = reviewGates(nodes("implement:failed verify:completed green:completed eval:completed review:completed"));
    expect(g.at(-1)).toMatchObject({ name: "Review", state: "changes" });
    expect(reviewGates(nodes("verify:completed green:completed review:completed card_draft:completed")).at(-1)?.state).toBe("pass");
  });
});

describe("fixHolder", () => {
  const ran = [
    { node_id: "prove", status: "completed", label: "Prove", session: { _id: "s1" } },
    { node_id: "red", status: "completed" },
    { node_id: "implement", status: "failed", label: "Implement", session: { _id: "s2" } },
    { node_id: "eval", status: "failed" },
  ];
  test("the step the run ended at, when it ran a session", () => {
    expect(fixHolder(ran, "implement")).toEqual({ step: "implement", label: "Implement", sessionId: "s2", preparing: false });
  });
  test("else the step at work, else the last that ran a session", () => {
    expect(fixHolder(ran, "eval")?.sessionId).toBe("s2");
    expect(fixHolder([...ran, { node_id: "card_write", status: "running", session: { _id: "s3" } }], null)).toMatchObject({ step: "card_write", sessionId: "s3", preparing: true });
  });
  test("a run that ran no session has nobody to open", () => {
    expect(fixHolder([{ node_id: "red", status: "completed" }])).toBeNull();
    expect(fixHolder(null)).toBeNull();
  });
});

describe("reviewMove", () => {
  const behind = branchStanding({ base: "main", behind: 98, on_both: ["a.ts", "b.ts"] });
  test("a red gate sends it back, naming the gate and the standing", () => {
    const m = reviewMove(reviewGates(nodes("verify:completed green:completed eval:failed"), { step: "eval", words: "Evals failed" }), behind);
    expect(m.act).toBe("sendback");
    expect(m.why).toEqual(["Eval red: Evals failed", "main moved 98 commits, 2 of its files changed there too"]);
    expect(sendBackNote(m, "main")).toContain("Rebase the branch onto main first");
  });

  test("green but sharing moved files: rebuild on main; green and clear: approve", () => {
    const green = reviewGates(nodes("verify:completed green:completed review:completed card_draft:completed"));
    expect(reviewMove(green, behind).act).toBe("rebuild");
    expect(reviewMove(green, branchStanding({ base: "main", behind: 3, on_both: [] })).act).toBe("approve");
  });
});

test("a red gate whose words only say it failed adds none", () => {
  expect(reviewGates([{ node_id: "verify", status: "failed" }], { step: "verify", words: "Verify failed" })[0].words).toBeNull();
});
