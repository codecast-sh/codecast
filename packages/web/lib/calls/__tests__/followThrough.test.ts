import { describe, expect, test } from "bun:test";
import { buildFollowThrough, sameAsk, splitAsk, sweepCallNumbers } from "../followThrough";

describe("followThrough", () => {
  test("an action item finds the task the listener reworded from it", () => {
    expect(
      sameAsk(
        "Catch up with Cam this afternoon on what he is working on and align on how the desk can and should be used",
        "Meet Cam this afternoon to align on how the desk should be used",
      ),
    ).toBe(true);
    expect(sameAsk("Check on the handoff/clipboard issue he said he would look into", "Check the inbound sign-up thread that went badly")).toBe(false);
  });

  test("splits who an action item was asked of", () => {
    expect(splitAsk("Samvit Ramadurgam: Look into the Meta account")).toEqual({ who: "Samvit Ramadurgam", text: "Look into the Meta account" });
    expect(splitAsk("Ship it")).toEqual({ text: "Ship it" });
  });

  test("sweep doc titles name their calls", () => {
    expect(sweepCallNumbers("Call ideas sweep, cl-176 to cl-180 (2026-10-27 and 28)")).toEqual([176, 177, 178, 179, 180]);
    expect(sweepCallNumbers("Call ideas sweep, cl-171, plus cl-170 listener tasks").sort()).toEqual([170, 171]);
    expect(sweepCallNumbers("Nightly sweep cl-3")).toEqual([]);
  });

  test("stages: unfiled ask, filed, working, deciding, done", () => {
    const call = { _id: "c1", short_id: "cl-9", action_items: ["Jo: write the launch post", "Al: fix the funnel stages nesting"] };
    const tasks = [
      { _id: "t1", from_call: "c1", title: "Fix the funnel: stages are not nested", status: "open", created_from_conversation: "s0", conversation_ids: ["s0"] },
      { _id: "t2", from_call: "c1", title: "Revenue map", status: "open", conversation_ids: ["s1"] },
      { _id: "t3", from_call: "c1", title: "Confidence score", status: "in_review" },
      { _id: "t4", from_call: "c1", title: "Settle up", status: "done" },
    ];
    const decisions = [{ task_id: "t3", status: "pending", short_id: "sd-1" }];
    const [fc] = buildFollowThrough([call], tasks, decisions, [{ _id: "d1", title: "Call ideas sweep, cl-8 to cl-9" }]);
    expect(fc.items.map((i) => [i.title, i.stage])).toEqual([
      ["Fix the funnel: stages are not nested", "filed"],
      ["Revenue map", "working"],
      ["Confidence score", "deciding"],
      ["Settle up", "done"],
      ["write the launch post", "unfiled"],
    ]);
    expect(fc.items[4].askedOf).toBe("Jo");
    expect(fc.sweepDocs.map((d) => d._id)).toEqual(["d1"]);
  });
});
