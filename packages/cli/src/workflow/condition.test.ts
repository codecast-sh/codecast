import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { evalCondition, conditionError, extractJsonOutput, lookupContextVar } from "./condition.js";
import { parseWorkflowFile } from "./parser.js";
import { recordNodeOutput, expandScriptVars, expandPromptVars } from "./runner.js";

describe("evalCondition: every condition the shipped workflows use", () => {
  const INTENT_CLEAR = "outcome = success and read.json.ship = true and read.json.in_scope = true and read.json.session and read.json.quote and read.json.line > 0";
  const INTENT_DECLINED = "outcome = success and read.json.why and (read.json.ship != true or read.json.in_scope != true)";
  const INTENT_CLEAR_CARD = "outcome = success and read.json.ship = true and read.json.in_scope = true and read.json.card and read.json.quote";
  // Each row: a condition string found in templates/, packages/cli/workflows
  // or the repo's workflows/, a context, and what the old evaluator returned.
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["outcome = success", { outcome: "success" }, true],
    ["outcome = success", { outcome: "failure" }, false],
    ["outcome = failure", { outcome: "failure" }, true],
    ["outcome = failure", { outcome: "success" }, false],
    ["outcome=success", { outcome: "success" }, true],
    ["outcome=success", { outcome: "failure" }, false],
    ["outcome=failure", { outcome: "failure" }, true],
    ["outcome=failure", {}, false],
    ["handoff = done", { handoff: "done" }, true],
    ["handoff = done", { handoff: "none" }, false],
    ["review_verdict = approve", { review_verdict: "approve" }, true],
    ["review_verdict = approve", { review_verdict: "none" }, false],
    ["review_verdict = changes", { review_verdict: "changes" }, true],
    ["review_verdict = changes", { review_verdict: "approve" }, false],
    ["review_verdict = reject", { review_verdict: "reject" }, true],
    ["review_verdict = reject", {}, false],
    // plan-autopilot: never evaluable before (no `context.ready_tasks` key)
    ["context.ready_tasks > 0", { ready_tasks: "3" }, true],
    ["context.ready_tasks > 0", { ready_tasks: "0" }, false],
    ["context.ready_tasks = 0", { ready_tasks: "0" }, true],
    ["context.ready_tasks = 0", { ready_tasks: "2" }, false],
    ["context.ready_tasks > 0", {}, false],
    ["context.ready_tasks = 0", {}, false],
    // line.cast (the-line-end-to-end.md LE5 to LE11): routing on the ground
    // fields and node JSON; templates.test.ts walks each station's table.
    ["readiness != ready or goal_ref = none or not goal_ref", { readiness: "ready", goal_ref: "" }, true],
    ["readiness != ready or goal_ref = none or not goal_ref", { readiness: "ready", goal_ref: "in-3:x" }, false],
    ["readiness = ready and goal_ref and goal_ref != none and risk = plan", { readiness: "ready", goal_ref: "in-3:x", risk: "plan" }, true],
    ["readiness = ready and goal_ref and goal_ref != none and risk = plan", { readiness: "ready", goal_ref: "none", risk: "plan" }, false],
    ["readiness = ready and goal_ref and goal_ref != none and risk != plan", { readiness: "ready", goal_ref: "in-3:x", risk: "low" }, true],
    ["readiness = ready and goal_ref and goal_ref != none and risk != plan", { readiness: "needs_context", goal_ref: "in-3:x", risk: "low" }, false],
    // judge.cast's high-risk exit, with $above at its default of 50.
    ["outcome = success and judge.json.risk >= 50", { outcome: "success", "judge.json": '{"risk":70}' }, true],
    ["outcome = success and judge.json.risk >= 50", { outcome: "success", "judge.json": '{"risk":30}' }, false],
    ["outcome = success and judge.json.risk >= 50", { outcome: "failure", "judge.json": '{"risk":70}' }, false],
    ["outcome = success and judge.json.risk < 50", { outcome: "success", "judge.json": '{"risk":30}' }, true],
    ["outcome = success and judge.json.risk < 50", { outcome: "success", "judge.json": '{"risk":70}' }, false],
    ["prove.json.reproduced = true", { "prove.json": '{"reproduced":true}' }, true],
    ["prove.json.reproduced = true", {}, false],
    ["prove.json.reproduced = false", { "prove.json": '{"reproduced":false}' }, true],
    ["prove.json.reproduced = false", {}, false],
    // No proof at all, whatever the hand said: never a dead end (ct-57659).
    ["prove.json.reproduced != true and prove.json.reproduced != false", {}, true],
    ["prove.json.reproduced != true and prove.json.reproduced != false", { "prove.json": '{"reproduced":false}' }, false],
    ["prove_line.json.reproduced != true and prove_line.json.reproduced != false", {}, true],
    ["prove_line.json.reproduced != true and prove_line.json.reproduced != false", { "prove_line.json": '{"reproduced":true}' }, false],
    ["red.json.red = true", { "red.json": '{"red":true}' }, true],
    ["red.json.red = true", { "red.json": '{"red":false}' }, false],
    ["red.json.red != true", {}, true],
    ["red.json.red != true", { "red.json": '{"red":true}' }, false],
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "code" }, true],
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "line" }, false],
    ["outcome = success and (category = prompt or category = line)", { outcome: "success", category: "line" }, true],
    ["outcome = success and (category = prompt or category = line)", { outcome: "failure", category: "prompt" }, false],
    // A profile command is a direct context key; absent from the profile it is empty.
    ["outcome = success and not line.commands.ship", { outcome: "success", "line.commands.ship": "" }, true],
    ["outcome = success and not line.commands.ship", { outcome: "success", "line.commands.ship": "bun ship.ts" }, false],
    ["outcome = success and line.commands.ship", { outcome: "success", "line.commands.ship": "bun ship.ts" }, true],
    ["outcome = success and line.commands.ship", { outcome: "success", "line.commands.ship": "" }, false],
    // A change to the line itself (category line) is scored by eval like a prompt.
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "code" }, true],
    ["outcome = success and category != prompt and category != line", { outcome: "success", category: "line" }, false],
    ["outcome = success and (category = prompt or category = line)", { outcome: "success", category: "line" }, true],
    ["outcome = success and (category = prompt or category = line)", { outcome: "success", category: "code" }, false],
    // A change to the line skips the code stations (prove, implement) for its own path.
    ["category != line", { category: "code" }, true],
    ["category != line", { category: "line" }, false],
    ["category = line", { category: "line" }, true],
    ["category = line", { category: "code" }, false],
    ["outcome = failure and category != line", { outcome: "failure", category: "code" }, true],
    ["outcome = failure and category != line", { outcome: "failure", category: "line" }, false],
    ["outcome = failure and category = line", { outcome: "failure", category: "line" }, true],
    ["outcome = failure and category = line", { outcome: "success", category: "line" }, false],
    ["outcome = failure and eval.exit_code = 1 and category != line", { outcome: "failure", "eval.exit_code": "1", category: "code" }, true],
    ["outcome = failure and eval.exit_code = 1 and category != line", { outcome: "failure", "eval.exit_code": "1", category: "line" }, false],
    ["outcome = failure and eval.exit_code = 1 and category = line", { outcome: "failure", "eval.exit_code": "1", category: "line" }, true],
    ["outcome = failure and eval.exit_code = 1 and category = line", { outcome: "failure", "eval.exit_code": "2", category: "line" }, false],
    ["outcome = failure and rebase.exit_code = 1 and category != line", { outcome: "failure", "rebase.exit_code": "1", category: "code" }, true],
    ["outcome = failure and rebase.exit_code = 1 and category != line", { outcome: "failure", "rebase.exit_code": "1", category: "line" }, false],
    ["outcome = failure and rebase.exit_code = 1 and category = line", { outcome: "failure", "rebase.exit_code": "1", category: "line" }, true],
    ["outcome = failure and rebase.exit_code = 1 and category = line", { outcome: "failure", "rebase.exit_code": "1", category: "code" }, false],
    ["outcome = success and category != prompt", { outcome: "success", category: "code" }, true],
    ["outcome = success and category != prompt", { outcome: "success", category: "prompt" }, false],
    ["outcome = success and category = prompt", { outcome: "success", category: "prompt" }, true],
    ["outcome = success and category = prompt", { outcome: "success", category: "code" }, false],
    ["red.json.red = true and category != line", { "red.json": '{"red":true}', category: "code" }, true],
    ["red.json.red = true and category != line", { "red.json": '{"red":true}', category: "line" }, false],
    ["red.json.red = true and category = line", { "red.json": '{"red":true}', category: "line" }, true],
    ["red.json.red = true and category = line", { "red.json": '{"red":false}', category: "line" }, false],
    ["red.json.red != true and category != line", { category: "code" }, true],
    ["red.json.red != true and category != line", { "red.json": '{"red":true}', category: "code" }, false],
    ["red.json.red != true and category = line", { category: "line" }, true],
    ["red.json.red != true and category = line", { category: "code" }, false],
    ["review_verdict = changes and category != line", { review_verdict: "changes", category: "code" }, true],
    ["review_verdict = changes and category != line", { review_verdict: "changes", category: "line" }, false],
    ["review_verdict = changes and category = line", { review_verdict: "changes", category: "line" }, true],
    ["review_verdict = changes and category = line", { review_verdict: "approve", category: "line" }, false],
    ["prove_line.json.reproduced = true", { "prove_line.json": '{"reproduced":true}' }, true],
    ["prove_line.json.reproduced = true", { "prove_line.json": '{"reproduced":false}' }, false],
    ["prove_line.json.reproduced = false", { "prove_line.json": '{"reproduced":false}' }, true],
    ["prove_line.json.reproduced = false", {}, false],
    ["handoff = needs_context or handoff = blocked", { handoff: "blocked" }, true],
    ["handoff = needs_context or handoff = blocked", { handoff: "needs_context" }, true],
    ["handoff = needs_context or handoff = blocked", { handoff: "done" }, false],
    // The eval station: exit 1 is a failed verdict, anything else could not score.
    ["outcome = failure and eval.exit_code = 1", { outcome: "failure", "eval.exit_code": "1" }, true],
    ["outcome = failure and eval.exit_code = 1", { outcome: "failure", "eval.exit_code": "2" }, false],
    ["outcome = failure and eval.exit_code != 1", { outcome: "failure", "eval.exit_code": "2" }, true],
    ["outcome = failure and eval.exit_code != 1", { outcome: "failure", "eval.exit_code": "1" }, false],
    // The rebase station (rebase.sh): landed when nothing of the change is left on the branch.
    ["outcome = success and rebase.json.landed != true", { outcome: "success", "rebase.json": '{"landed":false}' }, true],
    ["outcome = success and rebase.json.landed != true", { outcome: "success", "rebase.json": '{"landed":true}' }, false],
    ["outcome = success and rebase.json.landed = true", { outcome: "success", "rebase.json": '{"landed":true}' }, true],
    ["outcome = success and rebase.json.landed = true", { outcome: "success", "rebase.json": '{"landed":false}' }, false],
    ["outcome = failure and rebase.exit_code = 1", { outcome: "failure", "rebase.exit_code": "1" }, true],
    ["outcome = failure and rebase.exit_code = 1", { outcome: "failure", "rebase.exit_code": "2" }, false],
    ["outcome = failure and rebase.exit_code != 1", { outcome: "failure", "rebase.exit_code": "2" }, true],
    ["outcome = failure and rebase.exit_code != 1", { outcome: "failure", "rebase.exit_code": "1" }, false],
    // A planner that pinned blocked stops the run; a blocked handoff left on the task by an earlier run does not.
    ["handoff = blocked and station_blocked = plan", { handoff: "blocked", station_blocked: "plan" }, true],
    ["handoff = blocked and station_blocked = plan", { handoff: "blocked" }, false],
    ["outcome = failure and ship.exit_code = 3", { outcome: "failure", "ship.exit_code": "3" }, true],
    ["outcome = failure and ship.exit_code = 3", { outcome: "failure", "ship.exit_code": "1" }, false],
    ["outcome = failure and ship.exit_code = 3", { outcome: "success", "ship.exit_code": "3" }, false],
    ["outcome = failure and gauge.exit_code = 5", { outcome: "failure", "gauge.exit_code": "5" }, true],
    ["outcome = failure and gauge.exit_code = 5", { outcome: "failure", "gauge.exit_code": "3" }, false],
    ["outcome = failure and gauge.exit_code != 5", { outcome: "failure", "gauge.exit_code": "4" }, true],
    ["outcome = failure and gauge.exit_code != 5", { outcome: "failure", "gauge.exit_code": "5" }, false],
    ["outcome = failure and guard.exit_code = 6", { outcome: "failure", "guard.exit_code": "6" }, true],
    ["outcome = failure and guard.exit_code = 6", { outcome: "failure", "guard.exit_code": "1" }, false],
    ["outcome = failure and guard.exit_code != 6", { outcome: "failure", "guard.exit_code": "1" }, true],
    ["outcome = failure and guard.exit_code != 6", { outcome: "failure", "guard.exit_code": "6" }, false],
    ["mode.json.mode = line", { "mode.json.mode": "line" }, true],
    ["mode.json.mode = line", { "mode.json.mode": "experiment" }, false],
    ["mode.json.mode != line", { "mode.json.mode": "experiment" }, true],
    ["mode.json.mode != line", { "mode.json.mode": "line" }, false],
    ["outcome = failure and ship.exit_code != 3", { outcome: "failure", "ship.exit_code": "1" }, true],
    ["outcome = failure and ship.exit_code != 3", { outcome: "failure", "ship.exit_code": "3" }, false],
    // line.cast: exit 7 is CI red, back to the builder for three rounds a run (ship.sh counts them in its JSON).
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds <= 3 and category != line", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":3}', category: "code" }, true],
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds <= 3 and category != line", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":4}', category: "code" }, false],
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds <= 3 and category = line", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":1}', category: "line" }, true],
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds <= 3 and category = line", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":1}', category: "code" }, false],
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds > 3", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":4}' }, true],
    ["outcome = failure and ship.exit_code = 7 and ship.json.ci_red_rounds > 3", { outcome: "failure", "ship.exit_code": "7", "ship.json": '{"ci_red_rounds":3}' }, false],
    ["outcome = failure and ship.exit_code != 3 and ship.exit_code != 7", { outcome: "failure", "ship.exit_code": "1" }, true],
    ["outcome = failure and ship.exit_code != 3 and ship.exit_code != 7", { outcome: "failure", "ship.exit_code": "7" }, false],
    // line.cast: once Decide was answered Ship, an approved fix round goes to rebase; before it (or after a Revise), to the card.
    ["review_verdict = approve and human.gate.selected = S", { review_verdict: "approve", "human.gate.selected": "S" }, true],
    ["review_verdict = approve and human.gate.selected = S", { review_verdict: "approve" }, false],
    ["review_verdict = approve and human.gate.selected = S", { review_verdict: "approve", "human.gate.selected": "R" }, false],
    ["review_verdict = approve and human.gate.selected = S", { review_verdict: "changes", "human.gate.selected": "S" }, false],
    ["review_verdict = approve and human.gate.selected != S", { review_verdict: "approve" }, true],
    ["review_verdict = approve and human.gate.selected != S", { review_verdict: "approve", "human.gate.selected": "R" }, true],
    ["review_verdict = approve and human.gate.selected != S", { review_verdict: "approve", "human.gate.selected": "S" }, false],
    ["review_verdict = approve and human.gate.selected != S", { review_verdict: "reject" }, false],
    // check.cast: exit 2 from verify means the check could not judge, not that it failed; with no check command named,
    // neither route is taken (the no-check stop is).
    ["outcome = failure and verify.exit_code != 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "1", "line.commands.check": "make check" }, true],
    ["outcome = failure and verify.exit_code != 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "2", "line.commands.check": "make check" }, false],
    ["outcome = failure and verify.exit_code != 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "1", "line.commands.check": "" }, false],
    ["outcome = failure and verify.exit_code = 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "2", "line.commands.check": "make check" }, true],
    ["outcome = failure and verify.exit_code = 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "1", "line.commands.check": "make check" }, false],
    ["outcome = failure and verify.exit_code = 2 and line.commands.check", { outcome: "failure", "verify.exit_code": "2", "line.commands.check": "" }, false],
    // The ship segment inside a flow (flows.md FL3): its stations read under the node's name.
    ["outcome = success and ship__rebase.json.landed != true", { outcome: "success", "ship__rebase.json.landed": "false" }, true],
    ["outcome = success and ship__rebase.json.landed = true", { outcome: "success", "ship__rebase.json.landed": "true" }, true],
    ["outcome = failure and ship__rebase.exit_code = 1", { outcome: "failure", "ship__rebase.exit_code": "1" }, true],
    ["outcome = failure and ship__rebase.exit_code != 1", { outcome: "failure", "ship__rebase.exit_code": "1" }, false],
    ["outcome = failure and ship__ship.exit_code = 3", { outcome: "failure", "ship__ship.exit_code": "3" }, true],
    ["outcome = failure and ship__ship.exit_code != 3", { outcome: "failure", "ship__ship.exit_code": "3" }, false],
    // A segment's stop the change flows route back to the session (flows.md FL4): each stop exit step says which exit it is.
    ["outcome = failure and decide__revise.json.exit = revise", { outcome: "failure", "decide__revise.json.exit": "revise" }, true],
    ["outcome = failure and decide__revise.json.exit = dropped", { outcome: "failure", "decide__revise.json.exit": "revise" }, false],
    ["outcome = failure and decide__dropped.json.exit = revise", { outcome: "failure", "decide__dropped.json.exit": "dropped" }, false],
    ["outcome = failure and decide__dropped.json.exit = dropped", { outcome: "failure", "decide__dropped.json.exit": "dropped" }, true],
    ["outcome = failure and review__changes.json.exit = changes", { outcome: "failure", "review__changes.json.exit": "changes" }, true],
    ["outcome = failure and review__changes.json.exit = rejected", { outcome: "failure", "review__changes.json.exit": "changes" }, false],
    ["outcome = failure and review__rejected.json.exit = changes", { outcome: "failure", "review__rejected.json.exit": "rejected" }, false],
    ["outcome = failure and review__rejected.json.exit = rejected", { outcome: "failure", "review__rejected.json.exit": "rejected" }, true],
    ["outcome = failure and ship__conflict.json.exit = conflict", { outcome: "failure", "ship__conflict.json.exit": "conflict" }, true],
    ["outcome = failure and ship__conflict.json.exit = unshipped", { outcome: "failure", "ship__conflict.json.exit": "conflict" }, false],
    ["outcome = failure and ship__unshipped.json.exit = conflict", { outcome: "failure", "ship__unshipped.json.exit": "unshipped" }, false],
    ["outcome = failure and ship__unshipped.json.exit = unshipped", { outcome: "failure", "ship__unshipped.json.exit": "unshipped" }, true],
    // The check segment imported into a flow: its exits read through each stop node.
    ["outcome = failure and check__verify.exit_code != 2", { outcome: "failure", "check__verify.exit_code": "1" }, true],
    ["outcome = failure and check__verify.exit_code = 2", { outcome: "failure", "check__verify.exit_code": "2" }, true],
    ["outcome = failure and check__failed.json.exit != unjudged", { outcome: "failure", "check__failed.json.exit": "failed" }, true],
    ["outcome = failure and check__failed.json.exit = unjudged", { outcome: "failure", "check__failed.json.exit": "failed" }, false],
    ["outcome = failure and check__unjudged.json.exit != unjudged", { outcome: "failure", "check__unjudged.json.exit": "unjudged" }, false],
    ["outcome = failure and check__unjudged.json.exit = unjudged", { outcome: "failure", "check__unjudged.json.exit": "unjudged" }, true],
    // The deploy segment's wait (deploys.md): exit 4 merged nothing, exit 5 is stuck past a deadline, anything else failed.
    ["outcome = failure and wait.exit_code = 4", { outcome: "failure", "wait.exit_code": "4" }, true],
    ["outcome = failure and wait.exit_code = 4", { outcome: "failure", "wait.exit_code": "1" }, false],
    ["outcome = failure and wait.exit_code = 5", { outcome: "failure", "wait.exit_code": "5" }, true],
    ["outcome = failure and wait.exit_code = 5", { outcome: "failure", "wait.exit_code": "4" }, false],
    ["outcome = failure and wait.exit_code != 4 and wait.exit_code != 5", { outcome: "failure", "wait.exit_code": "1" }, true],
    ["outcome = failure and wait.exit_code != 4 and wait.exit_code != 5", { outcome: "failure", "wait.exit_code": "5" }, false],
    ["outcome = failure and deploy__wait.exit_code = 4", { outcome: "failure", "deploy__wait.exit_code": "4" }, true],
    ["outcome = failure and deploy__wait.exit_code = 4", { outcome: "failure", "deploy__wait.exit_code": "5" }, false],
    ["outcome = failure and deploy__wait.exit_code = 5", { outcome: "failure", "deploy__wait.exit_code": "5" }, true],
    ["outcome = failure and deploy__wait.exit_code = 5", { outcome: "success", "deploy__wait.exit_code": "5" }, false],
    ["outcome = failure and deploy__wait.exit_code != 4 and deploy__wait.exit_code != 5", { outcome: "failure", "deploy__wait.exit_code": "1" }, true],
    ["outcome = failure and deploy__wait.exit_code != 4 and deploy__wait.exit_code != 5", { outcome: "failure", "deploy__wait.exit_code": "4" }, false],
    // The change flow (flows.md FL4): Verdicts names the next station, and each station's exit code routes it.
    ["verdicts.json.next = new_round and moved.visits < 3", { "verdicts.json.next": "new_round", "moved.visits": "2" }, true],
    ["verdicts.json.next = new_round and moved.visits < 3", { "verdicts.json.next": "new_round", "moved.visits": "3" }, false],
    ["verdicts.json.next = new_round", { "verdicts.json.next": "new_round" }, true],
    ["verdicts.json.next = new_round", { "verdicts.json.next": "merge" }, false],
    ["verdicts.json.next = merge", { "verdicts.json.next": "merge" }, true],
    ["verdicts.json.next = merge", { "verdicts.json.next": "brief" }, false],
    ["verdicts.json.next = rejected", { "verdicts.json.next": "rejected" }, true],
    ["verdicts.json.next = rejected", { "verdicts.json.next": "merge" }, false],
    ["verdicts.json.next = rerun_ci", { "verdicts.json.next": "rerun_ci" }, true],
    ["verdicts.json.next = rerun_ci", { "verdicts.json.next": "rerun_review" }, false],
    ["verdicts.json.next = rerun_review", { "verdicts.json.next": "rerun_review" }, true],
    ["verdicts.json.next = rerun_review", { "verdicts.json.next": "rerun_ci" }, false],
    ["verdicts.json.next = no_ci", { "verdicts.json.next": "no_ci" }, true],
    ["verdicts.json.next = no_ci", { "verdicts.json.next": "merge" }, false],
    ["verdicts.json.next = wait_main and wait_main.visits < 2", { "verdicts.json.next": "wait_main", "wait_main.visits": "1" }, true],
    ["verdicts.json.next = wait_main and wait_main.visits < 2", { "verdicts.json.next": "wait_main", "wait_main.visits": "2" }, false],
    ["verdicts.json.next = wait_main", { "verdicts.json.next": "wait_main" }, true],
    ["verdicts.json.next = wait_main", { "verdicts.json.next": "brief" }, false],
    ["verdicts.json.next = decide and change_conversation", { "verdicts.json.next": "decide", change_conversation: "conv_1" }, true],
    ["verdicts.json.next = decide and change_conversation", { "verdicts.json.next": "decide", change_conversation: "" }, false],
    ["verdicts.json.next = decide", { "verdicts.json.next": "decide" }, true],
    ["verdicts.json.next = decide", { "verdicts.json.next": "merge" }, false],
    ["(verdicts.json.next = brief or verdicts.json.next = conflict) and not change_conversation", { "verdicts.json.next": "conflict", change_conversation: "" }, true],
    ["(verdicts.json.next = brief or verdicts.json.next = conflict) and not change_conversation", { "verdicts.json.next": "brief", change_conversation: "conv_1" }, false],
    ["verdicts.json.next = conflict", { "verdicts.json.next": "conflict" }, true],
    ["verdicts.json.next = conflict", { "verdicts.json.next": "brief" }, false],
    ["verdicts.json.next = brief", { "verdicts.json.next": "brief" }, true],
    // The change flow's Review runs only when the PR station carried no ship from the server for this head.
    ["not pr.json.reviewed.verdict", { "pr.json.reviewed.verdict": "ship" }, false],
    ["not pr.json.reviewed.verdict", {}, true],
    // Only a brief that asks for a code change spends a fix round; the rest go round free.
    ["verdicts.json.next = brief and verdicts.json.fix = true", { "verdicts.json.next": "brief", "verdicts.json.fix": "true" }, true],
    ["verdicts.json.next = brief and verdicts.json.fix = true", { "verdicts.json.next": "brief", "verdicts.json.fix": "false" }, false],
    ["verdicts.json.next = brief", { "verdicts.json.next": "conflict" }, false],
    ["outcome = success and merge.json.sha", { outcome: "success", "merge.json.sha": "5ca1ab1e" }, true],
    ["outcome = success and merge.json.sha", { outcome: "success", "merge.json.sha": "" }, false],
    ["outcome = failure and merge.exit_code = 1 and (merge.output contains \" conflicts with \" or merge.output contains \"rebuild the change on\") and change_conversation", { outcome: "failure", "merge.exit_code": "1", "merge.output": "a.txt conflicts with main", change_conversation: "conv_1" }, true],
    ["outcome = failure and merge.exit_code = 1 and (merge.output contains \" conflicts with \" or merge.output contains \"rebuild the change on\") and change_conversation", { outcome: "failure", "merge.exit_code": "1", "merge.output": "station crashed", change_conversation: "conv_1" }, false],
    ["outcome = failure and merge.exit_code = 3 and retest.visits < 3", { outcome: "failure", "merge.exit_code": "3", "retest.visits": "0" }, true],
    ["outcome = failure and merge.exit_code = 3 and retest.visits < 3", { outcome: "failure", "merge.exit_code": "3", "retest.visits": "3" }, false],
    ["outcome = failure and merge.exit_code = 3", { outcome: "failure", "merge.exit_code": "3" }, true],
    ["outcome = failure and merge.exit_code = 3", { outcome: "failure", "merge.exit_code": "2" }, false],
    ["outcome = failure and retest.exit_code = 4", { outcome: "failure", "retest.exit_code": "4" }, true],
    ["outcome = failure and retest.exit_code = 4", { outcome: "failure", "retest.exit_code": "1" }, false],
    ["outcome = failure and onto_main.exit_code = 4", { outcome: "failure", "onto_main.exit_code": "4" }, true],
    ["outcome = failure and onto_main.exit_code = 4", { outcome: "failure", "onto_main.exit_code": "1" }, false],
    // personal.cast (flows.md FL4): Round, Find check once a run, the round's nonce on the review, Land's exit codes, Deploy's pin.
    ["outcome = success and find_check.visits = 0", { outcome: "success" }, true],
    ["outcome = success and find_check.visits = 0", { outcome: "success", "find_check.visits": "1" }, false],
    ["outcome = failure and round.exit_code = 1 and change_conversation", { outcome: "failure", "round.exit_code": "1", change_conversation: "conv_1" }, true],
    ["outcome = failure and round.exit_code = 1 and change_conversation", { outcome: "failure", "round.exit_code": "1", change_conversation: "" }, false],
    ["outcome = failure and round.exit_code = 1", { outcome: "failure", "round.exit_code": "1" }, true],
    ["outcome = failure and round.exit_code = 1", { outcome: "failure", "round.exit_code": "2" }, false],
    ["outcome = failure and round.exit_code = 4", { outcome: "failure", "round.exit_code": "4" }, true],
    ["outcome = failure and round.exit_code = 4", { outcome: "failure", "round.exit_code": "1" }, false],
    ["outcome = success and (find_check.json.outcome = found or find_check.json.outcome = skipped)", { outcome: "success", "find_check.json": JSON.stringify({ outcome: "skipped", note: "no check documented" }) }, true],
    ["outcome = success and (find_check.json.outcome = found or find_check.json.outcome = skipped)", { outcome: "success", "find_check.json": JSON.stringify({ outcome: "found", commands: ["bun test"] }) }, true],
    ["outcome = success and (find_check.json.outcome = found or find_check.json.outcome = skipped)", { outcome: "success" }, false],
    ["check.outcome = failure", { "check.outcome": "failure" }, true],
    ["check.outcome = failure", { "check.outcome": "success" }, false],
    ...((): Array<[string, Record<string, string>, boolean]> => {
      const round = JSON.stringify({ round: "n2", head_sha: "5ca1ab1e", verdicts_at: 2 });
      const at = (review: Record<string, unknown> | null, check: Record<string, unknown> | null, more: Record<string, string> = {}) => ({
        "round.json": round, ...(review ? { "review.json": JSON.stringify(review) } : {}), ...(check ? { "check.json": JSON.stringify(check) } : {}), ...more,
      });
      const again = "(review.outcome = failure or review.json.round != round.json.round or (review.json.verdict != ship and review.json.verdict != changes and review.json.verdict != rejected)) and verdicts.visits <= round.json.verdicts_at";
      const reject = "review.json.round = round.json.round and review.json.verdict = rejected";
      const land = "review.json.round = round.json.round and review.json.verdict = ship and (check.json.outcome = pass or check.json.outcome = skipped)";
      const brief = "(check.json.outcome = fail or (review.json.round = round.json.round and review.json.verdict = changes)) and change_conversation";
      const found = "check.json.outcome = fail or (review.json.round = round.json.round and review.json.verdict = changes)";
      return [
        [again, at({ round: "n1", verdict: "ship" }, null, { "verdicts.visits": "1" }), true],
        [again, at({ round: "n2", verdict: "maybe" }, null, { "verdicts.visits": "1" }), true],
        [again, at(null, null, { "review.outcome": "failure", "verdicts.visits": "2" }), true],
        [again, at({ round: "n1", verdict: "ship" }, null, { "verdicts.visits": "3" }), false],
        [again, at({ round: "n2", verdict: "changes" }, null, { "verdicts.visits": "1" }), false],
        [reject, at({ round: "n2", verdict: "rejected" }, null), true],
        [reject, at({ round: "n1", verdict: "rejected" }, null), false],
        [land, at({ round: "n2", verdict: "ship" }, { outcome: "pass" }), true],
        [land, at({ round: "n2", verdict: "ship" }, { outcome: "skipped" }), true],
        [land, at({ round: "n2", verdict: "ship" }, { outcome: "fail" }), false],
        [land, at({ round: "n1", verdict: "ship" }, { outcome: "pass" }), false],
        [brief, at({ round: "n2", verdict: "ship" }, { outcome: "fail" }, { change_conversation: "conv_1" }), true],
        [brief, at({ round: "n2", verdict: "changes" }, { outcome: "pass" }, { change_conversation: "conv_1" }), true],
        [brief, at({ round: "n2", verdict: "changes" }, { outcome: "pass" }, { change_conversation: "" }), false],
        [brief, at({ round: "n1", verdict: "changes" }, { outcome: "pass" }, { change_conversation: "conv_1" }), false],
        [found, at({ round: "n2", verdict: "changes" }, { outcome: "pass" }), true],
        [found, at({ round: "n2", verdict: "ship" }, { outcome: "fail" }), true],
        [found, at({ round: "n2", verdict: "ship" }, { outcome: "pass" }), false],
      ];
    })(),
    ["outcome = success or land.exit_code = 5", { outcome: "failure", "land.exit_code": "5" }, true],
    ["outcome = success or land.exit_code = 5", { outcome: "failure", "land.exit_code": "3" }, false],
    ["outcome = failure and land.exit_code = 3 and land.json.moves < 4", { outcome: "failure", "land.exit_code": "3", "land.json": JSON.stringify({ moves: 3 }) }, true],
    ["outcome = failure and land.exit_code = 3 and land.json.moves < 4", { outcome: "failure", "land.exit_code": "3", "land.json": JSON.stringify({ moves: 4 }) }, false],
    ["outcome = failure and land.exit_code = 3", { outcome: "failure", "land.exit_code": "3" }, true],
    ["outcome = failure and land.exit_code = 3", { outcome: "failure", "land.exit_code": "4" }, false],
    ["outcome = failure and land.exit_code = 4", { outcome: "failure", "land.exit_code": "4" }, true],
    ["outcome = failure and land.exit_code = 4", { outcome: "failure", "land.exit_code": "6" }, false],
    ["outcome = failure and land.exit_code = 6", { outcome: "failure", "land.exit_code": "6" }, true],
    ["outcome = failure and land.exit_code = 6", { outcome: "success", "land.exit_code": "6" }, false],
    // Land cut off before it pinned any JSON of its own.
    ["outcome = failure and not land.json.outcome", { outcome: "failure" }, true],
    ["outcome = failure and not land.json.outcome", { outcome: "failure", "land.json": JSON.stringify({ outcome: "refused", note: "push refused" }) }, false],
    ["land.json.note", { "land.json": JSON.stringify({ outcome: "refused", note: "push refused" }) }, true],
    ["land.json.note", { "land.json": JSON.stringify({ outcome: "refused", note: "" }) }, false],
    ["land.exit_code = 5", { "land.exit_code": "5" }, true],
    ["land.exit_code = 5", { "land.exit_code": "0" }, false],
    ["landed.json.outcome = moved", { "landed.json": JSON.stringify({ outcome: "moved", note: "a newer commit is on top" }) }, true],
    ["landed.json.outcome = moved", { "landed.json": JSON.stringify({ outcome: "on_top" }) }, false],
    ...((): Array<[string, Record<string, string>, boolean]> => {
      const pin = (deploy: Record<string, unknown>, outcome = "success") => ({ outcome, "landed.json": JSON.stringify({ sha: "5ca1ab1e" }), "deploy.json": JSON.stringify(deploy) });
      const left = "outcome = success and deploy.json.left_for_you and deploy.json.left_for_you != null and (deploy.json.outcome = live or deploy.json.outcome = unverified or deploy.json.outcome = skipped)";
      const live = "outcome = success and deploy.json.outcome = live and deploy.json.sha = landed.json.sha and deploy.json.seen_live and deploy.json.seen_live != null";
      const liveAfterLeft = "deploy.json.outcome = live and deploy.json.sha = landed.json.sha and deploy.json.seen_live and deploy.json.seen_live != null";
      const unverified = "outcome = success and (deploy.json.outcome = live or deploy.json.outcome = unverified)";
      const unverifiedAfterLeft = "deploy.json.outcome = live or deploy.json.outcome = unverified";
      const seen = { outcome: "live", sha: "5ca1ab1e", seen_live: "GET /version says 5ca1ab1e" };
      return [
        [left, pin({ outcome: "skipped", left_for_you: "Approve the release in the store" }), true],
        [left, pin({ outcome: "live", left_for_you: "Flip the flag" }), true],
        // A JSON null reads as the text "null", which alone is truthy: the `!= null` clause is what refuses it.
        [left, pin({ outcome: "live", left_for_you: null }), false],
        [left, pin({ outcome: "failed", left_for_you: "Fix the token" }), false],
        [live, pin(seen), true],
        [live, pin({ ...seen, sha: "0ddba11" }), false],
        [live, pin({ ...seen, seen_live: null }), false],
        [live, pin({ outcome: "live", sha: "5ca1ab1e" }), false],
        [liveAfterLeft, pin(seen, "failure"), true],
        [liveAfterLeft, pin({ ...seen, seen_live: "" }), false],
        [unverified, pin({ outcome: "unverified" }), true],
        [unverified, pin({ outcome: "live" }), true],
        [unverified, pin({ outcome: "skipped" }), false],
        [unverifiedAfterLeft, pin({ outcome: "unverified" }), true],
        [unverifiedAfterLeft, pin({ outcome: "failed" }), false],
        ["outcome = success and deploy.json.outcome = skipped", pin({ outcome: "skipped" }), true],
        ["outcome = success and deploy.json.outcome = skipped", pin({ outcome: "live" }), false],
        ["outcome = success and deploy.json.outcome = failed and change_conversation", { ...pin({ outcome: "failed" }), change_conversation: "conv_1" }, true],
        ["outcome = success and deploy.json.outcome = failed and change_conversation", { ...pin({ outcome: "failed" }), change_conversation: "" }, false],
        ["outcome = success and deploy.json.outcome = failed", pin({ outcome: "failed" }), true],
        ["outcome = success and deploy.json.outcome = failed", pin({ outcome: "failed" }, "failure"), false],
      ];
    })(),
    ["outcome = failure and last_error contains \"Could not freeze\"", { outcome: "failure", last_error: "Could not freeze the change: index.lock exists" }, true],
    ["outcome = failure and last_error contains \"Could not freeze\"", { outcome: "failure", last_error: "the session timed out" }, false],
    ["change_landed", { change_landed: "true" }, true],
    ["change_landed", { change_landed: "" }, false],
    ["outcome = success and after_fix.json.next = deploy", { outcome: "success", "after_fix.json": JSON.stringify({ next: "deploy" }) }, true],
    ["outcome = success and after_fix.json.next = deploy", { outcome: "success", "after_fix.json": JSON.stringify({ next: "round" }) }, false],
    ["outcome = success and after_fix.json.next = round", { outcome: "success", "after_fix.json": JSON.stringify({ next: "round" }) }, true],
    ["outcome = success and after_fix.json.next = round", { outcome: "failure", "after_fix.json": JSON.stringify({ next: "round" }) }, false],
    ["outcome = success and after_fix.json.next = unpushed", { outcome: "success", "after_fix.json": JSON.stringify({ next: "unpushed", note: "committed, not pushed" }) }, true],
    ["outcome = success and after_fix.json.next = unpushed", { outcome: "success", "after_fix.json": JSON.stringify({ next: "moved" }) }, false],
    ["outcome = success and after_fix.json.next = moved", { outcome: "success", "after_fix.json": JSON.stringify({ next: "moved" }) }, true],
    ["outcome = success and after_fix.json.next = moved", { outcome: "success", "after_fix.json": JSON.stringify({ next: "deploy" }) }, false],
    ["outcome = success and committed.json.next = unpushed", { outcome: "success", "committed.json": JSON.stringify({ next: "unpushed" }) }, true],
    ["outcome = success and committed.json.next = unpushed", { outcome: "success" }, false],
    ["outcome = success and landcut.json.outcome = landed", { outcome: "success", "landcut.json": JSON.stringify({ outcome: "landed", sha: "5ca1ab1e" }) }, true],
    ["outcome = success and landcut.json.outcome = landed", { outcome: "success", "landcut.json": JSON.stringify({ outcome: "unknown", sha: "5ca1ab1e" }) }, false],
    ["outcome = success and landcut.json.outcome = unknown", { outcome: "success", "landcut.json": JSON.stringify({ outcome: "unknown", sha: "5ca1ab1e" }) }, true],
    ["outcome = success and landcut.json.outcome = unknown", { outcome: "failure", "landcut.json": JSON.stringify({ outcome: "unknown" }) }, false],
    // change.cast's direct path (startFacts.ts): a repository that lands straight on its default branch.
    ["ship_mode = direct", { ship_mode: "direct" }, true],
    ["ship_mode = direct", { ship_mode: "pr" }, false],
    ["ship_mode = direct", {}, false],
    ["review_verdict = changes and change_conversation", { review_verdict: "changes", change_conversation: "conv_1" }, true],
    ["review_verdict = changes and change_conversation", { review_verdict: "changes", change_conversation: "" }, false],
    ["outcome = failure and direct_check__failed.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__failed.json": '{"exit":"failed"}', change_conversation: "conv_1" }, true],
    ["outcome = failure and direct_check__failed.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__failed.json": '{"exit":"failed"}', change_conversation: "" }, false],
    // The check's other stops leave by the same routes, and never reach the session's fix.
    ["outcome = failure and direct_check__unjudged.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__unjudged.json": '{"exit":"unjudged"}', change_conversation: "conv_1" }, false],
    ["outcome = failure and direct_check__unjudged.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__unjudged.json": '{"exit":"failed"}', change_conversation: "conv_1" }, true],
    ["outcome = failure and direct_check__nocheck.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__nocheck.json": '{"exit":"nocheck"}', change_conversation: "conv_1" }, false],
    ["outcome = failure and direct_check__nocheck.json.exit = failed and change_conversation", { outcome: "failure", "direct_check__nocheck.json": '{"exit":"failed"}', change_conversation: "conv_1" }, true],
    // check.cast: a repository that names no check command stops there, whatever the shell said.
    ["outcome = failure and not line.commands.check", { outcome: "failure", "line.commands.check": "" }, true],
    ["outcome = failure and not line.commands.check", { outcome: "failure", "line.commands.check": "make check" }, false],
    ["outcome = failure and not line.commands.check", { outcome: "success", "line.commands.check": "" }, false],
    ["outcome = failure and direct_check__verify.exit_code != 2 and line.commands.check", { outcome: "failure", "direct_check__verify.exit_code": "1", "line.commands.check": "make check" }, true],
    ["outcome = failure and direct_check__verify.exit_code != 2 and line.commands.check", { outcome: "failure", "direct_check__verify.exit_code": "2", "line.commands.check": "make check" }, false],
    ["outcome = failure and direct_check__verify.exit_code = 2 and line.commands.check", { outcome: "failure", "direct_check__verify.exit_code": "2", "line.commands.check": "make check" }, true],
    ["outcome = failure and direct_check__verify.exit_code = 2 and line.commands.check", { outcome: "failure", "direct_check__verify.exit_code": "2", "line.commands.check": "" }, false],
    // Land (the ship segment): a rebase conflict goes to the session; a ship command's exit 7 is CI red after landing.
    ["outcome = failure and land__conflict.json.exit = conflict and change_conversation", { outcome: "failure", "land__conflict.json": '{"exit":"conflict"}', change_conversation: "conv_1" }, true],
    ["outcome = failure and land__conflict.json.exit = conflict and change_conversation", { outcome: "failure", "land__conflict.json": '{"exit":"conflict"}', change_conversation: "" }, false],
    ["outcome = failure and land__conflict.json.exit = unshipped and land__ship.exit_code = 7 and change_conversation", { outcome: "failure", "land__conflict.json": '{"exit":"conflict"}', "land__ship.exit_code": "7", change_conversation: "conv_1" }, false],
    ["outcome = failure and land__conflict.json.exit = unshipped and land__ship.exit_code = 7 and change_conversation", { outcome: "failure", "land__conflict.json": '{"exit":"unshipped"}', "land__ship.exit_code": "7", change_conversation: "conv_1" }, true],
    ["outcome = failure and land__unshipped.json.exit = conflict and change_conversation", { outcome: "failure", "land__unshipped.json": '{"exit":"unshipped"}', change_conversation: "conv_1" }, false],
    ["outcome = failure and land__unshipped.json.exit = conflict and change_conversation", { outcome: "failure", "land__unshipped.json": '{"exit":"conflict"}', change_conversation: "conv_1" }, true],
    ["outcome = failure and land__unshipped.json.exit = unshipped and land__ship.exit_code = 7 and change_conversation", { outcome: "failure", "land__unshipped.json": '{"exit":"unshipped"}', "land__ship.exit_code": "7", change_conversation: "conv_1" }, true],
    ["outcome = failure and land__unshipped.json.exit = unshipped and land__ship.exit_code = 7 and change_conversation", { outcome: "failure", "land__unshipped.json": '{"exit":"unshipped"}', "land__ship.exit_code": "1", change_conversation: "conv_1" }, false],
    ["outcome = success and land__rebase.json.landed != true", { outcome: "success", "land__rebase.json": '{"landed":false}' }, true],
    ["outcome = success and land__rebase.json.landed != true", { outcome: "success", "land__rebase.json": '{"landed":true}' }, false],
    ["outcome = success and land__rebase.json.landed = true", { outcome: "success", "land__rebase.json": '{"landed":true}' }, true],
    ["outcome = success and land__rebase.json.landed = true", { outcome: "success", "land__rebase.json": '{"landed":false}' }, false],
    ["outcome = failure and land__rebase.exit_code = 1", { outcome: "failure", "land__rebase.exit_code": "1" }, true],
    ["outcome = failure and land__rebase.exit_code = 1", { outcome: "failure", "land__rebase.exit_code": "2" }, false],
    ["outcome = failure and land__rebase.exit_code != 1", { outcome: "failure", "land__rebase.exit_code": "2" }, true],
    ["outcome = failure and land__rebase.exit_code != 1", { outcome: "failure", "land__rebase.exit_code": "1" }, false],
    ["outcome = failure and land__ship.exit_code = 3", { outcome: "failure", "land__ship.exit_code": "3" }, true],
    ["outcome = failure and land__ship.exit_code = 3", { outcome: "failure", "land__ship.exit_code": "7" }, false],
    ["outcome = failure and land__ship.exit_code != 3", { outcome: "failure", "land__ship.exit_code": "7" }, true],
    ["outcome = failure and land__ship.exit_code != 3", { outcome: "failure", "land__ship.exit_code": "3" }, false],
    ["outcome = failure and direct_deploy__wait.exit_code = 4", { outcome: "failure", "direct_deploy__wait.exit_code": "4" }, true],
    ["outcome = failure and direct_deploy__wait.exit_code = 4", { outcome: "failure", "direct_deploy__wait.exit_code": "5" }, false],
    ["outcome = failure and direct_deploy__wait.exit_code = 5", { outcome: "failure", "direct_deploy__wait.exit_code": "5" }, true],
    ["outcome = failure and direct_deploy__wait.exit_code = 5", { outcome: "failure", "direct_deploy__wait.exit_code": "4" }, false],
    ["outcome = failure and direct_deploy__wait.exit_code != 4 and direct_deploy__wait.exit_code != 5", { outcome: "failure", "direct_deploy__wait.exit_code": "1" }, true],
    ["outcome = failure and direct_deploy__wait.exit_code != 4 and direct_deploy__wait.exit_code != 5", { outcome: "failure", "direct_deploy__wait.exit_code": "5" }, false],
    // intent.cast (flows.md FL4): only a read that ships, in scope, citing a session, a line and a quote, goes on to Verify.
    ...[INTENT_CLEAR].flatMap((cond): Array<[string, Record<string, string>, boolean]> => {
      const read = "read.json";
      const answer = (over: Record<string, unknown>) => ({ outcome: "success", [read]: JSON.stringify({ ship: true, in_scope: true, session: "jx7b0m0", line: 115, quote: "ship it", ...over }) });
      return [
        [cond, answer({}), true],
        [cond, answer({ ship: false }), false],
        [cond, answer({ in_scope: false }), false],
        [cond, answer({ quote: "" }), false],
        [cond, answer({ quote: undefined }), false],
        [cond, answer({ session: "" }), false],
        [cond, answer({ line: 0 }), false],
        [cond, { outcome: "success" }, false],
        [cond, { ...answer({}), outcome: "failure" }, false],
      ];
    }),
    // intent.cast: a read the model answered no to says its why on the task; any other answer that cannot clear is unusable.
    ...[INTENT_DECLINED].flatMap((cond): Array<[string, Record<string, string>, boolean]> => {
      const read = "read.json";
      const answer = (over: Record<string, unknown>) => ({ outcome: "success", [read]: JSON.stringify({ ship: true, in_scope: true, session: "jx7b0m0", line: 115, quote: "ship it", why: "they said ship", ...over }) });
      return [
        [cond, answer({ ship: false }), true],
        [cond, answer({ in_scope: false }), true],
        [cond, answer({}), false],
        [cond, answer({ ship: false, why: "" }), false],
        [cond, { outcome: "success" }, false],
      ];
    }),
    // intent.cast: an answer citing a card goes to Verify card; one with no card does not.
    ...[INTENT_CLEAR_CARD].flatMap((cond): Array<[string, Record<string, string>, boolean]> => {
      const read = "read.json";
      const answer = (over: Record<string, unknown>) => ({ outcome: "success", [read]: JSON.stringify({ ship: true, in_scope: true, session: "", line: 0, card: "sd-4235", quote: "Ship both together", ...over }) });
      return [
        [cond, answer({}), true],
        [cond, answer({ card: "" }), false],
        [cond, answer({ card: undefined }), false],
        [cond, answer({ quote: "" }), false],
        [cond, answer({ ship: false }), false],
        [cond, answer({ in_scope: false }), false],
      ];
    }),
  ];
  for (const [cond, ctx, want] of cases) {
    test(`${cond} with ${JSON.stringify(ctx)} -> ${want}`, () => {
      expect(evalCondition(cond, ctx)).toBe(want);
    });
  }

  test("the list above covers every condition in the shipped workflow files", () => {
    const root = path.resolve(import.meta.dir, "../../../..");
    const dirs = ["packages/cli/src/workflow/templates", "packages/cli/workflows", "workflows"].map(d => path.join(root, d));
    const files: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".cast")) files.push(p);
      }
    };
    dirs.forEach(walk);
    expect(files.length).toBeGreaterThan(0);
    const covered = new Set(cases.map(c => c[0]));
    for (const f of files) {
      const g = parseWorkflowFile(f);
      for (const e of g.edges) {
        if (!e.condition) continue;
        expect({ file: path.basename(path.dirname(f)), condition: e.condition, covered: covered.has(e.condition) })
          .toEqual({ file: path.basename(path.dirname(f)), condition: e.condition, covered: true });
        expect(conditionError(e.condition)).toBeNull();
      }
    }
  });
});

describe("evalCondition: the language", () => {
  const ctx = { outcome: "success", count: "10", small: "9", name: "feature/login", flag: "true", off: "false", empty: "" };

  test("== and != (with and without spaces)", () => {
    expect(evalCondition("outcome == success", ctx)).toBe(true);
    expect(evalCondition("outcome != success", ctx)).toBe(false);
    expect(evalCondition("outcome!=failure", ctx)).toBe(true);
  });

  test("numeric comparison when both sides are numbers, string otherwise", () => {
    expect(evalCondition("count > small", ctx)).toBe(true); // 10 > 9, not "10" > "9"
    expect(evalCondition("count >= 10", ctx)).toBe(true);
    expect(evalCondition("count <= 9", ctx)).toBe(false);
    expect(evalCondition("count < 11", ctx)).toBe(true);
    expect(evalCondition("count = 10.0", ctx)).toBe(true);
    expect(evalCondition("'b' > 'a'", ctx)).toBe(false); // ordering needs numbers
    expect(evalCondition("outcome > 0", ctx)).toBe(false);
  });

  test("touches: a path with brackets names that file or folder, not a character class (ct-102468)", () => {
    const files = { change_files: "packages/mobile/app/task/[id].tsx app/[owner]/page.tsx" };
    expect(evalCondition('change_files touches "packages/mobile/app/task/[id].tsx"', files)).toBe(true);
    expect(evalCondition('change_files touches "app/[owner]/"', files)).toBe(true);
    expect(evalCondition('change_files touches "app/[owner]"', files)).toBe(true);
    expect(evalCondition('change_files touches "app/[other]/"', files)).toBe(false);
    expect(evalCondition('change_files touches "packages/mobile/app/task/[a-z]*.tsx"', { change_files: "packages/mobile/app/task/x.tsx" })).toBe(true);
  });

  test("touches: a changed path matches a glob (a station's when=)", () => {
    const files = { ...ctx, change_files: "landing/index.html packages/web/app.tsx README.md" };
    expect(evalCondition('change_files touches "landing/**"', files)).toBe(true);
    expect(evalCondition('change_files touches "backend/**, docs/*.md"', files)).toBe(false);
    expect(evalCondition('change_files touches "backend/**, *.md"', files)).toBe(true);
    expect(evalCondition('change_files touches "packages/web/"', files)).toBe(true);
    expect(evalCondition('change_files touches "packages/web"', files)).toBe(true);
    expect(evalCondition('change_files touches "packages/we"', files)).toBe(false);
    expect(evalCondition('not change_files touches "backend/**"', files)).toBe(true);
    expect(evalCondition('(outcome = success) and change_files touches "**/*.tsx"', files)).toBe(true);
    // An empty list is a change whose files nobody read (a branch run before they are filled): unknown, so it runs.
    expect(evalCondition('change_files touches "landing/**"', { ...ctx, change_files: "" })).toBe(true);
    expect(evalCondition('not change_files touches "landing/**"', { ...ctx, change_files: "" })).toBe(false);
    expect(evalCondition('change_files touches "{a,b}/**"', { ...ctx, change_files: "b/x.ts" })).toBe(true);
    expect(evalCondition('change_files touches "{a,b}/**, docs/"', { ...ctx, change_files: "c/x.ts" })).toBe(false);
    // No change files known: the gated station runs rather than passing unseen.
    expect(evalCondition('change_files touches "landing/**"', ctx)).toBe(true);
    expect(evalCondition('not change_files touches "landing/**"', ctx)).toBe(false);
    expect(conditionError('change_files touches "a/**"')).toBeNull();
  });

  test("a station that has not run in this attempt counts 0 visits", () => {
    expect(evalCondition("propose.visits < 3", ctx)).toBe(true);
    expect(evalCondition("propose.visits >= 3", ctx)).toBe(false);
    expect(evalCondition("propose.visits >= 3", { ...ctx, "propose.visits": "3" })).toBe(true);
    expect(evalCondition("context.propose.visits = 0", ctx)).toBe(true);
  });

  test("contains, quoted strings and literals", () => {
    expect(evalCondition("name contains login", ctx)).toBe(true);
    expect(evalCondition("name CONTAINS 'feature/'", ctx)).toBe(true);
    expect(evalCondition("name contains signup", ctx)).toBe(false);
    expect(evalCondition("'outcome' = outcome", ctx)).toBe(false); // quoted is never a lookup
    expect(evalCondition('"two words" = "two words"', ctx)).toBe(true);
  });

  test("and / or / not, symbolic forms, precedence and parentheses", () => {
    expect(evalCondition("outcome = success and count > 5", ctx)).toBe(true);
    expect(evalCondition("outcome = failure or count > 5", ctx)).toBe(true);
    expect(evalCondition("outcome = failure || count > 50", ctx)).toBe(false);
    expect(evalCondition("not outcome = failure", ctx)).toBe(true);
    expect(evalCondition("!(outcome = success)", ctx)).toBe(false);
    expect(evalCondition("outcome = failure or outcome = success and count > 50", ctx)).toBe(false);
    expect(evalCondition("(outcome = failure or outcome = success) && count > 5", ctx)).toBe(true);
  });

  test("a lone operand is true for a set, non-empty, non-false value", () => {
    expect(evalCondition("flag", ctx)).toBe(true);
    expect(evalCondition("off", ctx)).toBe(false);
    expect(evalCondition("empty", ctx)).toBe(false);
    expect(evalCondition("missing", ctx)).toBe(false);
    expect(evalCondition("not missing", ctx)).toBe(true);
  });

  test("malformed conditions never fire and report an error", () => {
    for (const bad of ["", "outcome =", "(outcome = success", "outcome = 'x", "and", "a = b c"]) {
      expect(evalCondition(bad, ctx)).toBe(false);
      expect(conditionError(bad)).not.toBeNull();
    }
  });

  test("no code runs: an expression-looking string is just text", () => {
    (globalThis as any).__pwned = false;
    expect(evalCondition("globalThis.__pwned=true", {})).toBe(false);
    expect((globalThis as any).__pwned).toBe(false);
  });
});

describe("$node.json.<path>", () => {
  test("extractJsonOutput: whole output, or the last fenced json block", () => {
    expect(extractJsonOutput('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonOutput("notes\n```json\n{\"a\":1}\n```\nmore\n```json\n{\"a\":2}\n```\n")).toEqual({ a: 2 });
    expect(extractJsonOutput("plain text")).toBeUndefined();
    // a report whose JSON quotes code (a proposal quoting a prompt block) still parses
    const quoted = { outcome: "proposed", proposal_md: "The cause:\n```ts\nconst x = 1;\n```\nThe fix." };
    expect(extractJsonOutput(`Proposed.\n\n\`\`\`json\n${JSON.stringify(quoted, null, 1)}\n\`\`\`\n`)).toEqual(quoted);
    expect(extractJsonOutput("```json\n{\"a\":1}\n```\nlater\n```json\nnot json\n```")).toEqual({ a: 1 });
    expect(extractJsonOutput("42")).toBeUndefined();
    // a report that ends on the json's closing brace, with no closing fence, routes on its outcome (ct-59565)
    expect(extractJsonOutput('Kept open.\n\n```json\n{\n  "outcome": "open"\n}\n')).toEqual({ outcome: "open" });
  });

  test("recordNodeOutput exposes fields to lookups, conditions, prompts and scripts", () => {
    const ctx: Record<string, string> = {};
    recordNodeOutput(ctx, "scan", JSON.stringify({ summary: { failing: 2, name: "it's" }, items: [{ id: "a" }, { id: "b" }], ok: false }));
    expect(lookupContextVar(ctx, "scan.json.summary.failing")).toBe("2");
    expect(lookupContextVar(ctx, "scan.json.items")).toBe("2"); // arrays read as their length
    expect(lookupContextVar(ctx, "scan.json.items.1.id")).toBe("b");
    expect(lookupContextVar(ctx, "scan.json.ok")).toBe("false");
    expect(lookupContextVar(ctx, "scan.json.nope")).toBeUndefined();
    expect(evalCondition("scan.json.summary.failing > 1 and not scan.json.ok", ctx)).toBe(true);
    expect(expandPromptVars("failing: $scan.json.summary.failing", { name: "g", nodes: new Map(), edges: [] }, ctx)).toBe("failing: 2");
    expect(expandScriptVars("echo $scan.json.summary.name", ctx)).toBe(`echo 'it'\\''s'`);
  });

  test("a later non-JSON output clears the stale json", () => {
    const ctx: Record<string, string> = {};
    recordNodeOutput(ctx, "scan", '{"a":1}');
    recordNodeOutput(ctx, "scan", "now text");
    expect(ctx["scan.json"]).toBeUndefined();
  });

  test("a long output keeps its end, where a failing script says why", () => {
    const ctx: Record<string, string> = {};
    recordNodeOutput(ctx, "eval", `==> Layer 3: rebuilding test schema\n${"[06:03] case passed\n".repeat(600)}6 of 95 gate cases failed`);
    expect(ctx["eval.output"].length).toBeLessThanOrEqual(4000);
    expect(ctx["eval.output"].startsWith("==> Layer 3")).toBe(true);
    expect(ctx["eval.output"].endsWith("6 of 95 gate cases failed")).toBe(true);
  });

  test("script vars: an unresolved dotted tail stays literal", () => {
    expect(expandScriptVars("cp $file.bak", { file: "x" })).toBe("cp 'x'.bak");
    expect(expandScriptVars("echo $nothing.here", {})).toBe("echo $nothing.here");
  });

  test("script vars are quoted for where they land: bare, inside double quotes, inside single quotes", () => {
    const ctx = { default_branch: "main", title: `it's "$x"`, worktree: "line-ct-1" };
    expect(expandScriptVars(`git rev-parse "origin/$default_branch"`, ctx)).toBe(`git rev-parse "origin/main"`);
    expect(expandScriptVars(`echo "$title" $title '$title'`, ctx)).toBe(`echo "it's \\"\\$x\\"" 'it'\\''s "$x"' 'it'\\''s "$x"'`);
    expect(expandScriptVars(`cd "$(cast ws path $worktree)"`, ctx)).toBe(`cd "$(cast ws path 'line-ct-1')"`);
    expect(expandScriptVars(`# the branch's $worktree\necho $worktree`, ctx)).toBe(`# the branch's $worktree\necho 'line-ct-1'`);
    for (const s of [`echo "$title" $title '$title'`, `x="a$(echo "$title")b"; echo "$x"`]) {
      const r = Bun.spawnSync(["bash", "-c", expandScriptVars(s, ctx)]);
      expect(r.stdout.toString()).toBe(s.startsWith("x=") ? `a${ctx.title}b\n` : `${ctx.title} ${ctx.title} ${ctx.title}\n`);
    }
  });
});
