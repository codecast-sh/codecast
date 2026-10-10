// The AgentWatch graph (Union's outreach/line/agentwatch.cast at 468147358d,
// 2026-10-07) as its workflows row holds it: the real stations and edges,
// with stand-in prompts that keep the real shape (shared sections, step refs).
// Regenerate from the .cast file with the parser; never hand edit.
import type { LineGraphSource } from "../lineModel";

export const agentwatchGraph: LineGraphSource = {
  name: "agentwatch",
  source: "digraph agentwatch {\n  dissolve [prompt=\"@agentwatch/dissolve.md\"]\n  investigate [prompt=\"@agentwatch/investigate.md\"]\n  refine [prompt=\"@agentwatch/refine.md\"]\n  prove [prompt=\"@agentwatch/prove.md\"]\n  propose [prompt=\"@agentwatch/propose.md\"]\n  build [prompt=\"@agentwatch/build.md\"]\n  review [prompt=\"@agentwatch/review.md\"]\n  card_write [prompt=\"@agentwatch/card.md\"]\n}\n",
  nodes: [
 {
  "id": "start",
  "label": "Start",
  "shape": "Mdiamond",
  "type": "start"
 },
 {
  "id": "exit",
  "label": "Exit",
  "shape": "Msquare",
  "type": "exit"
 },
 {
  "id": "shared",
  "label": "Shared text",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts shared"
 },
 {
  "id": "bind",
  "label": "Bind",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts bind"
 },
 {
  "id": "dissolve",
  "label": "Dissolve",
  "shape": "box",
  "type": "agent",
  "prompt": "You are the first look at one AgentWatch cluster.\n\n$shared.json.rulings\n\n$shared.json.voice"
 },
 {
  "id": "investigate",
  "label": "Investigate",
  "shape": "box",
  "type": "agent",
  "prompt": "You find the mechanism behind one AgentWatch cluster.\n\n$shared.json.rulings\n\n$shared.json.principles",
  "max_visits": 2
 },
 {
  "id": "stamp",
  "label": "Stamp",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts stamp"
 },
 {
  "id": "refine",
  "label": "Refine",
  "shape": "box",
  "type": "agent",
  "prompt": "You do the Refine step."
 },
 {
  "id": "prove",
  "label": "Prove",
  "shape": "box",
  "type": "agent",
  "prompt": "You do the Prove step.",
  "max_visits": 2
 },
 {
  "id": "red",
  "label": "Red",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts red"
 },
 {
  "id": "propose",
  "label": "Propose",
  "shape": "box",
  "type": "agent",
  "prompt": "You do the Propose step.",
  "max_visits": 3
 },
 {
  "id": "park_proposal",
  "label": "Park proposal",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts park_proposal"
 },
 {
  "id": "proposal_gate",
  "label": "Proposal",
  "shape": "hexagon",
  "type": "human",
  "prompt": "$propose.json.question\n\n$shared.json.rulings"
 },
 {
  "id": "approve",
  "label": "Approve",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts approve"
 },
 {
  "id": "revise_proposal",
  "label": "Revise proposal",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts revise_proposal"
 },
 {
  "id": "build",
  "label": "Build",
  "shape": "box",
  "type": "agent",
  "prompt": "You do the Build step.",
  "max_visits": 3
 },
 {
  "id": "verify",
  "label": "Verify",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts verify"
 },
 {
  "id": "green",
  "label": "Green",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts green"
 },
 {
  "id": "eval_scope",
  "label": "Eval scope",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts eval_scope"
 },
 {
  "id": "eval",
  "label": "Eval",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts eval"
 },
 {
  "id": "review",
  "label": "Review",
  "shape": "box",
  "type": "agent",
  "prompt": "You do the Review step."
 },
 {
  "id": "card_draft",
  "label": "Card draft",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts card_draft"
 },
 {
  "id": "card_write",
  "label": "Card words",
  "shape": "tab",
  "type": "prompt",
  "prompt": "You do the Card words step.",
  "max_visits": 2
 },
 {
  "id": "card",
  "label": "Card",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts card"
 },
 {
  "id": "park_built",
  "label": "Park build",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts park_built"
 },
 {
  "id": "decide",
  "label": "Decide",
  "shape": "hexagon",
  "type": "human",
  "prompt": "Ship the fix for $investigate.json.cause? $task_title\n\n$shared.json.rulings"
 },
 {
  "id": "ship",
  "label": "Ship",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts ship"
 },
 {
  "id": "revise_build",
  "label": "Revise build",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts revise_build"
 },
 {
  "id": "drop",
  "label": "Drop",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts drop"
 },
 {
  "id": "merge",
  "label": "Merge",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts merge"
 },
 {
  "id": "watch",
  "label": "Watch",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts watch"
 },
 {
  "id": "released_at_bind",
  "label": "Released",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts released_at_bind"
 },
 {
  "id": "dissolved_at_dissolve",
  "label": "Dissolved",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts dissolved_at_dissolve"
 },
 {
  "id": "dissolved_at_investigate",
  "label": "Dissolved",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts dissolved_at_investigate"
 },
 {
  "id": "dissolved_at_prove",
  "label": "Dissolved",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts dissolved_at_prove"
 },
 {
  "id": "dissolved_at_propose",
  "label": "Dissolved",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts dissolved_at_propose"
 },
 {
  "id": "dissolved_at_stamp",
  "label": "Owned elsewhere",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts dissolved_at_stamp"
 },
 {
  "id": "failed_at_investigate",
  "label": "Failed",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts failed_at_investigate"
 },
 {
  "id": "failed_at_prove",
  "label": "Failed",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts failed_at_prove"
 },
 {
  "id": "failed_at_build",
  "label": "Failed",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts failed_at_build"
 },
 {
  "id": "failed_at_review",
  "label": "Rejected in review",
  "shape": "parallelogram",
  "type": "command",
  "script": "bun backend/scripts/line.ts failed_at_review"
 }
],
  edges: [
 {
  "from": "start",
  "to": "shared"
 },
 {
  "from": "shared",
  "to": "bind"
 },
 {
  "from": "bind",
  "to": "dissolve",
  "condition": "outcome = success"
 },
 {
  "from": "bind",
  "to": "released_at_bind",
  "label": "claim refused",
  "condition": "outcome = failure"
 },
 {
  "from": "dissolve",
  "to": "dissolved_at_dissolve",
  "condition": "dissolve.json.outcome = dissolved"
 },
 {
  "from": "dissolve",
  "to": "investigate",
  "condition": "dissolve.json.outcome = open"
 },
 {
  "from": "investigate",
  "to": "stamp",
  "condition": "investigate.json.outcome = mechanism"
 },
 {
  "from": "investigate",
  "to": "dissolved_at_investigate",
  "condition": "investigate.json.outcome = dissolved"
 },
 {
  "from": "investigate",
  "to": "failed_at_investigate",
  "condition": "investigate.json.outcome = failed or investigate.json.outcome = judge_defect"
 },
 {
  "from": "stamp",
  "to": "refine",
  "condition": "outcome = success"
 },
 {
  "from": "stamp",
  "to": "dissolved_at_stamp",
  "label": "cause owned by another task",
  "condition": "outcome = failure"
 },
 {
  "from": "refine",
  "to": "prove",
  "condition": "refine.json.outcome = refined"
 },
 {
  "from": "refine",
  "to": "investigate",
  "label": "wrong cause",
  "condition": "refine.json.outcome = wrong_cause"
 },
 {
  "from": "prove",
  "to": "red",
  "condition": "prove.json.outcome = red or prove.json.outcome = infeasible"
 },
 {
  "from": "prove",
  "to": "dissolved_at_prove",
  "condition": "prove.json.outcome = dissolved"
 },
 {
  "from": "prove",
  "to": "failed_at_prove",
  "condition": "prove.json.outcome = not_reproduced"
 },
 {
  "from": "red",
  "to": "propose",
  "condition": "red.json.red = true or prove.json.outcome = infeasible"
 },
 {
  "from": "red",
  "to": "prove",
  "label": "no miss shown",
  "condition": "red.json.red != true and prove.json.outcome = red"
 },
 {
  "from": "propose",
  "to": "park_proposal",
  "condition": "propose.json.outcome = proposed"
 },
 {
  "from": "propose",
  "to": "dissolved_at_propose",
  "condition": "propose.json.outcome = dissolved"
 },
 {
  "from": "park_proposal",
  "to": "proposal_gate",
  "condition": "outcome = success"
 },
 {
  "from": "proposal_gate",
  "to": "approve",
  "label": "[A] Approve :: Build this strategy on the attempt's branch"
 },
 {
  "from": "proposal_gate",
  "to": "revise_proposal",
  "label": "[R] Revise :: Your note goes back to the proposal"
 },
 {
  "from": "proposal_gate",
  "to": "drop",
  "label": "[D] Drop :: Nothing is built; the attempt closes"
 },
 {
  "from": "approve",
  "to": "build",
  "condition": "outcome = success"
 },
 {
  "from": "revise_proposal",
  "to": "propose",
  "condition": "outcome = success"
 },
 {
  "from": "build",
  "to": "verify",
  "condition": "build.json.outcome = built"
 },
 {
  "from": "build",
  "to": "propose",
  "label": "strategy cannot work",
  "condition": "build.json.outcome = strategy_fails"
 },
 {
  "from": "build",
  "to": "failed_at_build",
  "condition": "build.json.outcome = failed"
 },
 {
  "from": "verify",
  "to": "green",
  "condition": "outcome = success"
 },
 {
  "from": "verify",
  "to": "build",
  "label": "checks failed",
  "condition": "outcome = failure"
 },
 {
  "from": "green",
  "to": "eval_scope",
  "condition": "outcome = success or prove.json.outcome = infeasible"
 },
 {
  "from": "green",
  "to": "build",
  "label": "still red",
  "condition": "outcome = failure and prove.json.outcome != infeasible"
 },
 {
  "from": "eval_scope",
  "to": "eval",
  "condition": "outcome = failure or eval_scope.json.scoped = true"
 },
 {
  "from": "eval_scope",
  "to": "review",
  "condition": "outcome = success and eval_scope.json.scoped != true"
 },
 {
  "from": "eval",
  "to": "review",
  "condition": "outcome = success"
 },
 {
  "from": "eval",
  "to": "build",
  "label": "eval failed",
  "condition": "outcome = failure"
 },
 {
  "from": "review",
  "to": "card_draft",
  "condition": "review_verdict = approve"
 },
 {
  "from": "review",
  "to": "build",
  "label": "changes",
  "condition": "review_verdict = changes"
 },
 {
  "from": "review",
  "to": "failed_at_review",
  "condition": "review_verdict = reject"
 },
 {
  "from": "card_draft",
  "to": "card_write"
 },
 {
  "from": "card_write",
  "to": "card"
 },
 {
  "from": "card",
  "to": "park_built",
  "condition": "outcome = success"
 },
 {
  "from": "card",
  "to": "card_write",
  "label": "card refused",
  "condition": "outcome = failure"
 },
 {
  "from": "park_built",
  "to": "decide",
  "condition": "outcome = success"
 },
 {
  "from": "decide",
  "to": "ship",
  "label": "[S] Ship :: Approve the fix; it ships once main carries the branch"
 },
 {
  "from": "decide",
  "to": "revise_build",
  "label": "[R] Revise :: Your note goes back to the build"
 },
 {
  "from": "decide",
  "to": "drop",
  "label": "[D] Drop :: The fix is not wanted; the attempt closes"
 },
 {
  "from": "revise_build",
  "to": "build",
  "condition": "outcome = success"
 },
 {
  "from": "ship",
  "to": "merge",
  "condition": "outcome = success"
 },
 {
  "from": "merge",
  "to": "watch"
 },
 {
  "from": "watch",
  "to": "exit"
 },
 {
  "from": "drop",
  "to": "exit"
 },
 {
  "from": "released_at_bind",
  "to": "exit"
 },
 {
  "from": "dissolved_at_dissolve",
  "to": "exit"
 },
 {
  "from": "dissolved_at_investigate",
  "to": "exit"
 },
 {
  "from": "dissolved_at_prove",
  "to": "exit"
 },
 {
  "from": "dissolved_at_propose",
  "to": "exit"
 },
 {
  "from": "dissolved_at_stamp",
  "to": "exit"
 },
 {
  "from": "failed_at_investigate",
  "to": "exit"
 },
 {
  "from": "failed_at_prove",
  "to": "exit"
 },
 {
  "from": "failed_at_build",
  "to": "exit"
 },
 {
  "from": "failed_at_review",
  "to": "exit"
 }
],
};
