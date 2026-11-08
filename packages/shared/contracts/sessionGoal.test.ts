import { describe, expect, test } from "bun:test";
import { isMachineDeliveredMessage } from "./machineMessages";
import {
  GOAL_MAX_ROUNDS,
  buildGoalJudgePrompt,
  formatGoalMessage,
  goalObjectiveProblem,
  isGoalMessage,
  parseGoalMessage,
  parseGoalVerdict,
  renderGoalEvidence,
  stepGoal,
  usedToolsSinceLastGoalMessage,
} from "./sessionGoal";

const goal = { objective: "Make `bun test src/a.test.ts` pass", rounds: 0, max_rounds: GOAL_MAX_ROUNDS, stalls: 0, max_stalls: 3, reason: undefined as string | undefined };

describe("goal frame", () => {
  test("round-trips every field and reads as machine-delivered", () => {
    const text = formatGoalMessage({ kind: "continue", round: 3, of: 50, objective: 'Ship "it"\nwith <tags>', reason: 'Tests "fail"', next_step: "Fix the import" });
    expect(isGoalMessage(text)).toBe(true);
    expect(isMachineDeliveredMessage(text)).toBe(true);
    expect(parseGoalMessage(text)).toEqual({ kind: "continue", round: 3, of: 50, objective: 'Ship "it"\nwith <tags>', reason: 'Tests "fail"', next_step: "Fix the import" });
  });
  test("a truncated preview still parses its head", () => {
    const text = formatGoalMessage({ kind: "start", round: 0, of: 50, objective: "x" }).slice(0, 60);
    expect(parseGoalMessage(text)?.kind).toBe("start");
  });
  test("other text is not a goal message", () => {
    expect(parseGoalMessage("<codecast-goal kind=\"nope\">x</codecast-goal>")).toBeNull();
    expect(isGoalMessage("set a goal")).toBe(false);
  });
});

describe("objective", () => {
  test("empty and oversized objectives are refused", () => {
    expect(goalObjectiveProblem("  ")).toMatch(/needs an objective/);
    expect(goalObjectiveProblem("x".repeat(5000))).toMatch(/limited/);
    expect(goalObjectiveProblem("fix it")).toBeNull();
  });
});

describe("evidence", () => {
  const start = { role: "user", content: formatGoalMessage({ kind: "start", round: 0, of: 50, objective: "o" }) };
  test("labels who produced each line and keeps the newest under the budget", () => {
    const msgs = [
      start,
      { role: "assistant", content: "Running the tests.", tool_calls: [{ id: "1", name: "Bash", input: '{"command":"bun test"}' }] },
      { role: "user", content: "", tool_results: [{ tool_use_id: "1", content: "3 pass, 0 fail" }] },
      { role: "assistant", content: "All green." },
    ];
    const text = renderGoalEvidence(msgs);
    expect(text).toContain("[codecast goal loop] The person set the goal.");
    expect(text).toContain("[tool call: Bash]");
    expect(text).toContain("[tool result]\n3 pass, 0 fail");
    expect(text).toContain("[agent says]\nAll green.");
    const small = renderGoalEvidence([...Array(50)].map((_, i) => ({ role: "assistant", content: `line ${i} ${"x".repeat(100)}` })), 1000);
    expect(small).toContain("line 49");
    expect(small).not.toContain("line 0 ");
    expect(small).toMatch(/earlier entries cut/);
  });
  test("tool use counts only after the newest goal message", () => {
    const used = [start, { role: "assistant", content: "", tool_calls: [{ name: "Read" }] }];
    expect(usedToolsSinceLastGoalMessage(used)).toBe(true);
    expect(usedToolsSinceLastGoalMessage([...used, { role: "user", content: formatGoalMessage({ kind: "continue", round: 1, of: 50, objective: "o" }) }, { role: "assistant", content: "Done!" }])).toBe(false);
  });
  test("the prompt carries the objective and the transcript", () => {
    const p = buildGoalJudgePrompt("Make it pass", "[agent says]\nok");
    expect(p).toContain("<untrusted_objective>\nMake it pass\n</untrusted_objective>");
    expect(p).toContain("[agent says]\nok");
  });
});

describe("verdict", () => {
  test("parses the four verdicts and drops a next step off anything but continue", () => {
    expect(parseGoalVerdict({ verdict: "Continue", reason: " r ", next_step: "n" })).toEqual({ verdict: "continue", reason: "r", next_step: "n" });
    expect(parseGoalVerdict({ verdict: "done", reason: "r", next_step: "n" })).toEqual({ verdict: "done", reason: "r" });
    expect(parseGoalVerdict({ verdict: "wait" })).toBeNull();
    expect(parseGoalVerdict(null)).toBeNull();
  });
});

describe("one round", () => {
  test("continue delivers the next round", () => {
    const s = stepGoal(goal, { verdict: "continue", reason: "Two tests fail", next_step: "Fix parse()" }, true);
    expect(s.status).toBe("active");
    if (s.status !== "active") return;
    expect(s.rounds).toBe(1);
    expect(s.stalls).toBe(0);
    expect(s.deliver).toMatchObject({ kind: "continue", round: 1, of: 50, next_step: "Fix parse()" });
  });
  test("done, blocked and paused stop the loop", () => {
    expect(stepGoal(goal, { verdict: "done", reason: "3 pass" }, true).status).toBe("done");
    expect(stepGoal(goal, { verdict: "blocked", reason: "Needs the API key" }, true).status).toBe("blocked");
    expect(stepGoal(goal, { verdict: "paused", reason: "" }, true)).toMatchObject({ status: "paused", reason: "Paused" });
  });
  test("the same gap again, or no tool run, counts toward the stall cap", () => {
    const g = { ...goal, reason: "Two tests fail.", stalls: 1 };
    expect(stepGoal(g, { verdict: "continue", reason: "two tests FAIL" }, true)).toMatchObject({ status: "active", stalls: 2 });
    expect(stepGoal({ ...g, stalls: 2 }, { verdict: "continue", reason: "Two tests fail" }, true)).toMatchObject({ status: "paused", stalls: 3 });
    expect(stepGoal({ ...goal, stalls: 2 }, { verdict: "continue", reason: "new gap" }, false).status).toBe("paused");
    expect(stepGoal({ ...goal, stalls: 2 }, { verdict: "continue", reason: "new gap" }, true)).toMatchObject({ status: "active", stalls: 0 });
  });
  test("the round cap pauses", () => {
    expect(stepGoal({ ...goal, rounds: 50 }, { verdict: "continue", reason: "more" }, true)).toMatchObject({ status: "paused", reason: "Reached the limit of 50 rounds" });
  });
});

describe("the /goal command", () => {
  const { parseGoalCommand } = require("./sessionGoal");
  test("reads verbs, objectives and nothing else", () => {
    expect(parseGoalCommand("/goal")).toEqual({ op: "show" });
    expect(parseGoalCommand(" /goal Pause ")).toEqual({ op: "pause" });
    expect(parseGoalCommand('/goal "make tests pass"')).toEqual({ op: "set", objective: "make tests pass" });
    expect(parseGoalCommand("/goal fix the build\nand ship it")).toEqual({ op: "set", objective: "fix the build\nand ship it" });
    expect(parseGoalCommand("/goals")).toBeNull();
    expect(parseGoalCommand("set a /goal")).toBeNull();
  });
});
