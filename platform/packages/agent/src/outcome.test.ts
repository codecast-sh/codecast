import { describe, expect, it } from "bun:test";
import {
  CUT_OFF_TEXT,
  WAITING_TEXT,
  declineText,
  notRunText,
  refusalText,
  startedText,
  stoppedText,
  toolResultOutcome,
  unavailableText,
  unrecordedText,
} from "./outcome";

describe("toolResultOutcome", () => {
  it("reads every refusal the run writes as declined", () => {
    expect(toolResultOutcome(declineText("replace_doc"))).toBe("declined");
    expect(toolResultOutcome(declineText("send_email", "not to Dana. Ask me first."))).toBe("declined");
    expect(toolResultOutcome(refusalText("send_email"))).toBe("declined");
  });

  it("reads every call that never ran as not_run", () => {
    for (const text of [
      startedText("create_event"),
      stoppedText("search_web"),
      unrecordedText("send_email", "write conflict (retry)"),
      unavailableText("old_tool"),
      CUT_OFF_TEXT,
      notRunText("the person's plan had no usage left to run it"),
    ]) {
      expect(toolResultOutcome(text)).toBe("not_run");
    }
  });

  it("leaves real results, tool errors and free-text reasons alone", () => {
    expect(toolResultOutcome("Sent.")).toBeNull();
    expect(toolResultOutcome("Whisk refused: the mailbox is not connected.")).toBeNull();
    expect(toolResultOutcome("Your plan has no room left this month.")).toBeNull();
    expect(toolResultOutcome(WAITING_TEXT)).toBeNull();
    // A tool that quotes the words mid-sentence is not the engine speaking.
    expect(toolResultOutcome("Note body: The person declined x. It did not run.")).toBeNull();
  });
});
