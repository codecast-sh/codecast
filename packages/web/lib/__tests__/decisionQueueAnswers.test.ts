import { describe, expect, test } from "bun:test";
import { APPROVAL_ANSWERS } from "@codecast/shared/contracts/assistant";
import { DECLINE_HINT_MS, answeredLabel, answeredLine, answerSaid, hostedDeclinedSince, questionAsStatement } from "../decisionQueue";

const row = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  conversation_id: "c1",
  status: "answered",
  answer_index: 2,
  resolved_at: 2_000,
  options: [{ label: APPROVAL_ANSWERS.approve }, { label: APPROVAL_ANSWERS.always }, { label: APPROVAL_ANSWERS.decline }],
  question: 'Set up the routine "Take vitamins"?',
  ...over,
}) as any;

describe("an answered approval said back", () => {
  test("leads with the answer and reads the question as a statement", () => {
    const d = row();
    expect(answeredLine(answeredLabel(d)!, d.question)).toBe("You said no to the routine \u201cTake vitamins\u201d");
    expect(answeredLine(APPROVAL_ANSWERS.approve, 'Save the note "Packing list"?')).toBe("You said yes to the note \u201cPacking list\u201d");
    expect(answeredLine(APPROVAL_ANSWERS.approve, "Open a page on simplyprint.io?")).toBe("You said yes: open a page on simplyprint.io");
    // Nothing named after the verb: the answer and the question, one colon.
    expect(answeredLine(APPROVAL_ANSWERS.decline, "Delete 3 emails?")).toBe("You said no: delete 3 emails");
    expect(answerSaid(APPROVAL_ANSWERS.approve)).toBe("You said yes");
  });

  test("keeps a capital that names something", () => {
    expect(questionAsStatement("SMS Sam about Friday?")).toBe("SMS Sam about Friday");
  });

  test("an open row has no answer", () => {
    expect(answeredLabel(row({ status: "pending", answer_index: undefined }))).toBeUndefined();
  });

  test("a no since the last message invites a change", () => {
    const decisions = { d1: row() };
    expect(hostedDeclinedSince(decisions, "c1", 1_000)).toBe(true);
    expect(hostedDeclinedSince(decisions, "c1", 3_000)).toBe(false);
    expect(hostedDeclinedSince({ d1: row({ answer_index: 0 }) }, "c1", 1_000)).toBe(false);
  });

  // "Tell me what to change" 42 minutes after a no read as a pending ask.
  test("the invitation to change lasts only DECLINE_HINT_MS when given the time", () => {
    const decisions = { d1: row() };
    const at = decisions.d1.resolved_at!;
    expect(hostedDeclinedSince(decisions, "c1", 1_000, at + DECLINE_HINT_MS - 1)).toBe(true);
    expect(hostedDeclinedSince(decisions, "c1", 1_000, at + DECLINE_HINT_MS)).toBe(false);
  });
});
