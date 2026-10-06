import { describe, expect, test } from "bun:test";
import { parseJointMessage } from "@codecast/shared/contracts/jointMessage";
import { armJointSend, composeJointTurn, draftAfterClaim, jointCandidatesOf, jointSendReady, setJointCandidates, takeJointSend } from "./jointSend";

describe("send together", () => {
  test("only an armed submit folds others' drafts in, mine first", () => {
    const sent: string[][] = [];
    setJointCandidates("c1", "Ann", [{ user_id: "u2", from: "Bob", text: "check mobile" }], (s) => sent.push(s.map((c) => c.user_id)));
    expect(jointSendReady("c1")).toBe(true);
    expect(takeJointSend("c1", "fix the header")).toBe("fix the header");
    expect(armJointSend("c1")).toBe(true);
    const out = takeJointSend("c1", "fix the header");
    expect(parseJointMessage(out)).toEqual([{ from: "Ann", body: "fix the header" }, { from: "Bob", body: "check mobile" }]);
    expect(sent).toEqual([["u2"]]);
    expect(takeJointSend("c1", "next")).toBe("next");
    setJointCandidates("c1", "Ann", [], () => {});
    expect(armJointSend("c1")).toBe(false);
  });

  test("an empty draft of mine sends only theirs, as a direct send in their name", () => {
    expect(composeJointTurn("Ann", "", [{ user_id: "u2", from: "Bob", text: "go" }])).toBe('<user-message from="Bob">\ngo\n</user-message>');
  });

  test("candidates are the rows forming words", () => {
    expect(jointCandidatesOf([
      { user_id: "a", user_name: "A", user_color: "", draft_text: "  hi " },
      { user_id: "b", user_name: "B", user_color: "", draft_text: "  " },
    ])).toEqual([{ user_id: "a", from: "A", text: "hi" }]);
  });

  test("a claim takes the sent words out of my draft and keeps what I typed after", () => {
    expect(draftAfterClaim("check mobile", "check mobile")).toBe("");
    expect(draftAfterClaim("check mobile\nand tablets", "check mobile")).toBe("and tablets");
    expect(draftAfterClaim("rewrote it", "check mobile")).toBeNull();
  });
});
