import { describe, expect, test } from "bun:test";
import { buildFollowThrough, likelyTaskForItem, splitAsk, sweepCallNumbers, taskForItem } from "../followThrough";

describe("followThrough", () => {
  test("only the same words count an ask as filed; a reworded title is a guess", () => {
    const desk = { title: "Meet Cam this afternoon to align on how the desk should be used" };
    const signing = { title: "Fix the mobile build signing today" };
    const pricing = { title: "Redesign the pricing page for teams" };
    const tasks = [desk, signing, pricing, { title: "Check the inbound sign-up thread that went badly" }];
    const reworded = "Jason: Catch up with Cam this afternoon on what he is working on and align on how the desk can and should be used";
    expect(taskForItem(reworded, tasks)).toBeUndefined();
    expect(likelyTaskForItem(reworded, tasks)).toBe(desk);
    // The reviewer's near misses never count as filed, whatever the guess says.
    expect(taskForItem("Ship the mobile build today", tasks)).toBeUndefined();
    expect(taskForItem("Update the pricing page copy for teams", tasks)).toBeUndefined();
    expect(likelyTaskForItem("Ship the mobile build", tasks)).toBeUndefined();
    expect(likelyTaskForItem("Ashot: Check on the handoff/clipboard issue he said he would look into", tasks)).toBeUndefined();
  });

  test("a task made from the item on the call page matches it word for word", () => {
    const made = { title: "Samvit: Look into the Meta account." };
    expect(taskForItem("Samvit: Look into the Meta account", [made])).toBe(made);
  });

  test("splits who an action item was asked of, only when it names someone on the call", () => {
    const names = ["Samvit Ramadurgam", "Cam"];
    expect(splitAsk("Samvit Ramadurgam: Look into the Meta account", names)).toEqual({ who: "Samvit Ramadurgam", text: "Look into the Meta account" });
    expect(splitAsk("Samvit: Look into it", names)).toEqual({ who: "Samvit", text: "Look into it" });
    expect(splitAsk("Note: the pricing page is wrong", names)).toEqual({ text: "Note: the pricing page is wrong" });
    expect(splitAsk("Ship it")).toEqual({ text: "Ship it" });
  });

  test("sweep doc titles name their calls", () => {
    expect(sweepCallNumbers("Call ideas sweep, cl-176 to cl-180 (2026-10-27 and 28)")).toEqual([176, 177, 178, 179, 180]);
    expect(sweepCallNumbers("Call ideas sweep, cl-171, plus cl-170 listener tasks").sort()).toEqual([170, 171]);
    expect(sweepCallNumbers("Nightly sweep cl-3")).toEqual([]);
    expect(sweepCallNumbers("Call ideas sweep, cl-1 to cl-999999999")).toEqual([1, 999999999]);
  });

  test("stages: unfiled ask, filed, working, deciding, done", () => {
    const call = { _id: "c1", short_id: "cl-9", participants: [{ name: "Jo" }, { name: "Al" }], action_items: ["Jo: write the launch post", "Al: fix the funnel stages nesting"] };
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
      ["fix the funnel stages nesting", "guessed"],
    ]);
    expect(fc.items[4].askedOf).toBe("Jo");
    expect(fc.items[5].guess._id).toBe("t1");
    expect(fc.sweepDocs.map((d) => d._id)).toEqual(["d1"]);
  });
});
