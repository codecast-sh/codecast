import { describe, expect, test } from "bun:test";
import { changeSays, reviewGates, reviewMove, sendBackNote } from "../fixReview";
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

describe("changeSays", () => {
  test("the newest behaviour change, without its prefix or task ref", () => {
    expect(changeSays([
      { subject: "test(needs): feeTerms agreed on a call must save (fails until ct-57567 is fixed)" },
      { subject: "fix(needs): save fee terms the contact agreed to when we proposed them" },
      { subject: "fix(needs): fee terms put to a contact save only when they agreed" },
      { subject: "test(prompts): regenerate replay fidelity fixtures after rebase onto main" },
    ])).toEqual({ line: "Fee terms put to a contact save only when they agreed", more: 1 });
    expect(changeSays([{ subject: "fix(followup-playbook): provider outage failures no longer count toward the cold nudge retry cap (ct-58682)" }])?.line)
      .toBe("Provider outage failures no longer count toward the cold nudge retry cap");
  });

  test("nothing but tests and reverts says nothing", () => {
    expect(changeSays([{ subject: "test: a" }, { subject: "revert(x): b" }])).toBeNull();
    expect(changeSays([])).toBeNull();
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
