import { describe, expect, test } from "bun:test";
import { parseSideQuestion, SIDE_QUESTION_COMMAND, withSideQuestionCommand } from "../builtinCommands";
import { resolveSessionSkills } from "../sessionSkills";
import { SIDE_ANSWER_STALL_MS, sideAnswerErrorText, sideAnswerView, sideRefusalText } from "../sideAnswers";
import { sideAnswerStub } from "../../store/sideAnswerTypes";

describe("parseSideQuestion", () => {
  test("takes the question after /btw, multi-line included", () => {
    expect(parseSideQuestion("/btw what did it change in auth?")).toBe("what did it change in auth?");
    expect(parseSideQuestion("  /btw   why\nthis way? ")).toBe("why\nthis way?");
  });
  test("a bare /btw opens the panel with no question", () => {
    expect(parseSideQuestion("/btw")).toBe("");
    expect(parseSideQuestion("/btw   ")).toBe("");
  });
  test("anything else is for the agent", () => {
    expect(parseSideQuestion("/btwx hello")).toBeNull();
    expect(parseSideQuestion("by the way /btw hello")).toBeNull();
    expect(parseSideQuestion("/compact")).toBeNull();
    expect(parseSideQuestion("btw hello")).toBeNull();
  });
});

describe("the composer's slash list", () => {
  test("where /btw is a side question, codecast's command replaces the agent's, once", () => {
    const skills = withSideQuestionCommand(resolveSessionSkills({ agentType: "claude_code" }));
    expect(skills.filter((s) => s.name === "btw")).toEqual([SIDE_QUESTION_COMMAND]);
    expect(withSideQuestionCommand(resolveSessionSkills({ agentType: "codex" })).some((s) => s.name === "btw")).toBe(true);
  });
  test("elsewhere the agent's list is untouched", () => {
    const skills = resolveSessionSkills({ agentType: "claude_code" });
    expect(skills.find((s) => s.name === "btw")?.description).not.toBe(SIDE_QUESTION_COMMAND.description);
  });
});

describe("sideRefusalText", () => {
  test("an older backend without the action reads as not available", () => {
    expect(sideRefusalText("[CONVEX M(dispatch:dispatch)] [Request ID: 1] Server Error\nUncaught Error: Unknown dispatch action\n    at handler (x)")).toBe("Side answers are not available here yet.");
  });
  test("the server's own refusal is kept", () => {
    expect(sideRefusalText("You do not have access to read this session")).toBe("You do not have access to read this session");
  });
});

describe("sideAnswerView", () => {
  const now = 1_800_000_000_000;
  const stub = sideAnswerStub({ conversationId: "c1", question: " Why? ", clientId: "btw:1", now });
  test("a fresh stub is pending, with its question trimmed", () => {
    expect(stub.question).toBe("Why?");
    expect(sideAnswerView(stub, now + 1000)).toEqual({ kind: "pending" });
  });
  test("a pending row stops claiming an answer is coming after the stall bound", () => {
    expect(sideAnswerView(stub, now + SIDE_ANSWER_STALL_MS + 1).kind).toBe("failed");
  });
  test("an answered row shows its answer and citations", () => {
    const view = sideAnswerView({ ...stub, status: "answered", answer: "Because (msg 3).", citations: [{ line: 3, message_id: "m3" }] }, now);
    expect(view).toEqual({ kind: "answered", answer: "Because (msg 3).", citations: [{ line: 3, message_id: "m3" }] });
  });
  test("a failed row shows the reason in the panel's words, the server's own when it gave one", () => {
    expect(sideAnswerView({ ...stub, status: "failed", error_code: "FORBIDDEN" }, now)).toEqual({ kind: "failed", message: "You do not have access to read this session." });
    expect(sideAnswerView({ ...stub, status: "failed", error_code: "FORBIDDEN", error_message: "This team's sessions are not sent to Anthropic" }, now))
      .toEqual({ kind: "failed", message: "This team's sessions are not sent to Anthropic" });
  });
});

describe("sideAnswerErrorText", () => {
  test("maps coded refusals to the panel's words", () => {
    expect(sideAnswerErrorText("RATE_LIMITED", "Too many questions this hour; retry in 12 min")).toBe("You have asked a lot this hour. Try again in 12 min");
    expect(sideAnswerErrorText("INVALID", "The question is 2400 characters; keep it under 2000")).toBe("The question is 2400 characters; keep it under 2000");
    expect(sideAnswerErrorText("MODEL_FAILED", "The model did not answer (credit balance is too low)")).toContain("credit balance");
    expect(sideAnswerErrorText(undefined, undefined)).toBe("Could not answer just now. Try again in a moment.");
  });
});
