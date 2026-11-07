import { describe, expect, test } from "bun:test";
import { askAnswerFromPoll, planAnswerFromPoll } from "./pollAnswer.js";
import { parsePollMessage } from "../pollMessage.js";

// Payloads exactly as the web builds them (packages/web/lib/pollPayload.ts).
const poll = (o: object) => parsePollMessage(JSON.stringify({ __cc_poll: true, ...o }))!;
const one = { questions: [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }] };
const two = {
  questions: [
    { question: "Which color?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Which sizes?", multiSelect: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] },
  ],
};

describe("askAnswerFromPoll", () => {
  test("one single-select question", () => {
    expect(askAnswerFromPoll(one, poll({ keys: ["2"], display: "Blue" }))).toEqual({ behavior: "allow", updatedInput: { ...one, answers: { "Which color?": "Blue" } } });
  });
  test("a single-select question then a multiSelect one, submitted", () => {
    const a = askAnswerFromPoll(two, poll({ keys: ["1", "1", "3", "Right", "Enter"], multi: true }));
    expect(a).toEqual({ behavior: "allow", updatedInput: { ...two, answers: { "Which color?": "Red", "Which sizes?": "S, L" } } });
  });
  test("free text declines the menu and carries the words", () => {
    const a = askAnswerFromPoll(one, poll({ text: "green, actually", display: "green, actually" }));
    expect(a?.behavior).toBe("deny");
    expect(a && "message" in a ? a.message : "").toContain("green, actually");
  });
  test("keys that pick nothing answer nothing", () => {
    expect(askAnswerFromPoll(one, poll({ keys: ["9"] }))).toBeNull();
  });
});

describe("planAnswerFromPoll", () => {
  test("start, with or without clearing context", () => {
    expect(planAnswerFromPoll(poll({ keys: ["1"] }))).toEqual({ behavior: "allow" });
    expect(planAnswerFromPoll(poll({ keys: ["3"] }))).toEqual({ behavior: "allow" });
  });
  test("request changes carries the feedback", () => {
    const a = planAnswerFromPoll(poll({ keys: ["4"], text: "split step 2" }));
    expect(a).toEqual({ behavior: "deny", message: "The user wants changes to the plan: split step 2" });
  });
});
