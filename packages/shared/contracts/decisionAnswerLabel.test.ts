import { describe, expect, test } from "bun:test";
import { decisionAnswerLabel } from "./machineMessages";

// The one line the asking agent acts on. The server's finalizeAnswer and the
// web's optimistic answerDecision both build it here, so a multi, rank or form
// answer reads the same whichever path delivered it.
const row = { options: [{ label: "A" }, { label: "B" }, { label: "C" }] };

describe("decisionAnswerLabel", () => {
  test("single: the chosen option's label", () => {
    expect(decisionAnswerLabel(row, { answer_index: 1 })).toBe("B");
    expect(decisionAnswerLabel(row, {})).toBeUndefined();
  });
  test("a typed answer wins over any index", () => {
    expect(decisionAnswerLabel(row, { answer_index: 1, answer_text: "neither" })).toBe("neither");
  });
  test("multi: labels joined by a comma", () => {
    expect(decisionAnswerLabel({ ...row, kind: "multi" }, { answer_json: [0, 2] })).toBe("A, C");
  });
  test("rank: labels joined by a chevron, in the given order", () => {
    expect(decisionAnswerLabel({ ...row, kind: "rank" }, { answer_json: [2, 0, 1] })).toBe("C > A > B");
  });
  test("form: key=value pairs", () => {
    expect(decisionAnswerLabel({ ...row, kind: "form" }, { answer_json: { region: "eu", count: 3 } })).toBe("region=eu; count=3");
  });
  test("an index past the options still names the slot", () => {
    expect(decisionAnswerLabel({ ...row, kind: "multi" }, { answer_json: [7] })).toBe("option 8");
  });
});
