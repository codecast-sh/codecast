import { describe, expect, test } from "bun:test";
import { parseWorkflowSource } from "./parser";
import { gatePayload } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { splitReviewNote } from "./reviewNote";

describe("the change card's words come from the approving note", () => {
  test("the first line asks, the rest is the document", () => {
    expect(splitReviewNote("Ship X?\n\nX now works.\nnit a.ts:1 y -> rejected\n")).toEqual({ question: "Ship X?", body: "X now works.\nnit a.ts:1 y -> rejected" });
    expect(splitReviewNote("Ship X?")).toEqual({ question: "Ship X?", body: "" });
  });

  test("decide.cast asks the note's question and shows the rest", () => {
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.decide);
    const payload = gatePayload(graph.nodes.get("decide")!, graph, { review_question: "Ship the fix that tags Samvit again?", review_body: "His reminders tag him again." });
    expect(payload.prompt.split("\n")[0]).toBe("Ship the fix that tags Samvit again?");
    expect(payload.doc_md).toBe("His reminders tag him again.");
  });
});
