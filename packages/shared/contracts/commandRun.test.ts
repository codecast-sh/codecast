import { expect, test } from "bun:test";
import { RUN_OPTIONS, approvesCommandRun, approvesPersonsAct, clipRunOutput, commandLine, parseRunCommand, runResultText, MAX_RUN_OUTPUT } from "./commandRun";
import { APPROVE_FOR_SESSION } from "./secrets";
import { formatDecisionAnswer, parseDecisionAnswer } from "./decisionAnswers";

test("a pasted command line parses to the argv the machine runs, and prints back the same", () => {
  const line = `! cast role authority @ads --team Union --grant '[{"id":"a","limit":{"usd_per_month":5000}}]'`;
  const parsed = parseRunCommand(line);
  expect(parsed).toEqual({ argv: ["role", "authority", "@ads", "--team", "Union", "--grant", `[{"id":"a","limit":{"usd_per_month":5000}}]`] });
  const printed = commandLine((parsed as { argv: string[] }).argv);
  expect(printed).toBe(`cast role authority @ads --team Union --grant '[{"id":"a","limit":{"usd_per_month":5000}}]'`);
  expect(parseRunCommand(printed)).toEqual(parsed);
});

test("anything but one cast command is refused", () => {
  for (const line of ["", "cast", "cast tasks ls | head", "cast a; cast b", "cast a && cast b", "cast a > out.txt", "cast a 2>&1", "cast decide 'q'", "cast role authority @x --grant -"]) {
    expect("error" in parseRunCommand(line)).toBe(true);
  }
});

test("only Run on a run card, or Approve on an Ask first card, is a person's act", () => {
  const run = { run: { argv: ["x"], state: "waiting" }, options: RUN_OPTIONS };
  expect(approvesCommandRun(run, 0)).toBe(true);
  expect(approvesCommandRun(run, 1)).toBe(false);
  expect(approvesPersonsAct(run, 0)).toBe(true);
  expect(approvesPersonsAct({ options: RUN_OPTIONS }, 0)).toBe(false);
  expect(approvesPersonsAct({ category: "access", options: [{ label: APPROVE_FOR_SESSION }] }, 0)).toBe(true);
});

test("the result rides after the answer's tag, and the answer stays the label", () => {
  const detail = runResultText({ argv: ["role", "authority", "@ads"], state: "failed", exit_code: 1, output: "Error: nope" });
  expect(detail).toContain("exit 1");
  const msg = formatDecisionAnswer({ id: "k1", question: "Grant?", answer: "Run", detail });
  expect(parseDecisionAnswer(msg)).toEqual({ id: "k1", question: "Grant?", answer: "Run", detail });
  // tmux collapsing newlines does not move the answer
  expect(parseDecisionAnswer(msg.replace(/\n/g, " "))?.answer).toBe("Run");
  expect(parseDecisionAnswer(formatDecisionAnswer({ id: "k1", question: "Q", answer: "B" }))).toEqual({ id: "k1", question: "Q", answer: "B" });
});

test("long output keeps its tail", () => {
  const out = clipRunOutput("x".repeat(MAX_RUN_OUTPUT) + "END");
  expect(out.endsWith("END")).toBe(true);
  expect(out.length).toBe(MAX_RUN_OUTPUT + 1);
});
