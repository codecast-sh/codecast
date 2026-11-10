import { describe, expect, test } from "bun:test";
import { planInjection, pollAnswerText, type InjectionAction } from "./claudeWrapper.js";

const keys = (actions: InjectionAction[]) => actions.flatMap(a => a.op === "key" ? [a.key] : []);
const pastes = (actions: InjectionAction[]) => actions.flatMap(a => a.op === "paste" ? [a.text] : []);
// Keys and pastes in send order, without the waits between them.
const sent = (actions: InjectionAction[]) => actions.flatMap(a => a.op === "sleep" ? [] : [a.op === "key" ? `key:${a.key}` : `paste:${a.text}`]);

describe("planInjection", () => {
  test("a text-only poll answer declines the menu once and types the text, not the JSON", () => {
    const content = JSON.stringify({ __cc_poll: true, text: "use the staging db" });
    const plan = planInjection(content);
    expect(plan.poll).toBe(true);
    expect(sent(plan.actions)).toEqual(["key:Escape", "paste:use the staging db", "key:Enter"]);
    expect(pastes(plan.actions).join("")).not.toContain("__cc_poll");
  });

  test("a multi-line text answer is flattened so no newline submits early", () => {
    const plan = planInjection(JSON.stringify({ __cc_poll: true, text: "first\nsecond" }));
    expect(pastes(plan.actions)).toEqual(["first  ·  second"]);
  });

  test("structured keys are pressed in order with no Escape", () => {
    const plan = planInjection(JSON.stringify({ __cc_poll: true, keys: ["2", "1", "Enter"] }));
    expect(plan.poll).toBe(true);
    expect(sent(plan.actions)).toEqual(["key:2", "key:1", "key:Enter"]);
  });

  test("structured steps are pressed in order", () => {
    const plan = planInjection(JSON.stringify({ __cc_poll: true, steps: [{ key: "1" }, { key: "Tab" }, { key: "2" }] }));
    expect(sent(plan.actions)).toEqual(["key:1", "key:Tab", "key:2"]);
  });

  test("keys plus text press the keys, then type the text into the opened field", () => {
    const plan = planInjection(JSON.stringify({ __cc_poll: true, keys: ["4"], text: "tighten the plan" }));
    expect(sent(plan.actions)).toEqual(["key:4", "paste:tighten the plan", "key:Enter"]);
  });

  test("text embedded in steps declines once and presses none of the option keys", () => {
    const plan = planInjection(JSON.stringify({
      __cc_poll: true,
      steps: [{ key: "2" }, { key: "1", text: "my own answer" }, { key: "1" }],
    }));
    expect(keys(plan.actions)).toEqual(["Escape", "Enter"]);
    expect(pastes(plan.actions)).toEqual(["my own answer"]);
  });

  test("an ordinary message clears the composer, pastes and submits", () => {
    const plan = planInjection("hello there");
    expect(plan.poll).toBe(false);
    expect(sent(plan.actions)).toEqual(["key:Escape", "key:C-u", "paste:hello there", "key:Enter"]);
  });

  test("JSON that is not a poll is pasted as written", () => {
    const content = JSON.stringify({ text: "not a poll" });
    const plan = planInjection(content);
    expect(plan.poll).toBe(false);
    expect(pastes(plan.actions)).toEqual([content]);
  });
});

describe("pollAnswerText", () => {
  test("gives a poll's free text, and null for key-only polls and ordinary messages", () => {
    expect(pollAnswerText(JSON.stringify({ __cc_poll: true, text: "free answer" }))).toBe("free answer");
    expect(pollAnswerText(JSON.stringify({ __cc_poll: true, keys: ["1"] }))).toBeNull();
    expect(pollAnswerText("plain")).toBeNull();
  });
});
