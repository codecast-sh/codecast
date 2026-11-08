import { describe, expect, test } from "bun:test";
import {
  buildPollPayload,
  parseTypedPollAnswers,
  pollCardAnswers,
  pollClosedLabel,
  typedPollAnswerTexts,
  type PollQuestion,
} from "../pollPayload";

// The poll from session jx79zqj (2026-11-07): the first question answered with
// free text, the second with an option, so the app declined the menu and typed
// both answers as one message. The card read "Closed without an answer".
const questions: PollQuestion[] = [
  {
    question: "What happens to that portal shortlist?",
    header: "Shortlist",
    options: [{ label: "Remove it too (Recommended)" }, { label: "Keep the page, drop links" }, { label: "Keep page and links" }],
  },
  {
    question: "How should I handle them?",
    header: "Overlap",
    options: [{ label: "Tell them, I proceed (Recommended)" }, { label: "Wait for jx7969z first" }],
  },
];
const custom = "the point is to only suggest people that are actively engaged with us. it doesn't mean we need to remove all the UI";
const rejection =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
// What the daemon types: the payload's text with newlines flattened (pollDeclineText).
const typed = `Shortlist: ${custom}  ·  Overlap: Tell them, I proceed`;

describe("typed poll answers", () => {
  test("the typed form round-trips the app's own payload", () => {
    const payload = JSON.parse(
      buildPollPayload(questions, { 0: [{ key: "4", label: custom, text: custom }], 1: [{ key: "1", label: "Tell them, I proceed" }] })
    );
    const flattened = payload.text.replace(/\r?\n+/g, "  ·  ");
    expect(flattened).toBe(typed);
    expect(parseTypedPollAnswers(questions, flattened)).toEqual({
      [questions[0].question]: custom,
      [questions[1].question]: "Tell them, I proceed",
    });
  });

  test("the message after a declined question carries its answers to the card", () => {
    const texts = typedPollAnswerTexts([
      { role: "assistant", content: "" },
      { role: "user", content: "", tool_results: [{ tool_use_id: "ask1", content: rejection }] },
      { role: "user", content: "[Request interrupted by user for tool use]" },
      { role: "user", content: typed },
      { role: "assistant", content: "On it." },
    ]);
    expect(texts).toEqual({ ask1: typed });

    const result = { tool_use_id: "ask1", content: rejection, typed_answer: texts.ask1 };
    const answers = pollCardAnswers(questions, undefined, result);
    expect(answers[questions[1].question]).toBe("Tell them, I proceed");
    expect(pollClosedLabel(result, answers)).toBeNull();
  });

  test("a decline the agent spoke after, or that was never typed, stays unanswered", () => {
    expect(
      typedPollAnswerTexts([
        { role: "user", content: "", tool_results: [{ tool_use_id: "ask1", content: rejection }] },
        { role: "assistant", content: "Waiting." },
        { role: "user", content: "something else" },
      ])
    ).toEqual({});
    const result = { tool_use_id: "ask1", content: rejection };
    expect(pollClosedLabel(result, pollCardAnswers(questions, undefined, result))).toBe("Closed without an answer");
  });

  test("a typed message naming no question lights nothing on a multi-question card", () => {
    expect(parseTypedPollAnswers(questions, "never mind, do it your way")).toEqual({});
  });
});
