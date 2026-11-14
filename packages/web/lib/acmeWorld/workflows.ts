// Acme's workflows: Alex's "review" workflow (typecheck, an agent review, an
// Approve gate that either ships or sends the change back to the check) and
// one run of it on the retry queue task, paused at Approve. The workflows
// page, the run page and its graph read these through the workflow feeds.
// Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { MIN, PEOPLE, SESSIONS, TEAM_ID, WORKSPACE, cid } from "./world";

export const REVIEW_WORKFLOW_ID = cid("wfreview");
export const REVIEW_RUN_ID = cid("wfrunreview1");

const node = (id: string, label: string, shape: string, type: string, extra: Record<string, unknown> = {}) => ({ id, label, shape, type, ...extra });

export const WORKFLOWS = (now: number) => [
  {
    _id: REVIEW_WORKFLOW_ID,
    _creationTime: now - 9 * 24 * 60 * MIN,
    user_id: PEOPLE.me._id,
    team_id: TEAM_ID,
    workspace: WORKSPACE,
    name: "review",
    slug: "review",
    label: "Review",
    goal: "Check the change, have an agent review it, and ship it once a person approves",
    nodes: [
      node("start", "Start", "Mdiamond", "start"),
      node("check", "Typecheck", "parallelogram", "command", { script: "bun run typecheck && bun test" }),
      node("review", "Review", "box", "agent", { prompt: "Review the diff for correctness and missed cases. List what you would change and why." }),
      node("approve", "Approve", "hexagon", "human", { prompt: "Ship this change, or send it back?" }),
      node("exit", "Ship", "Msquare", "exit"),
    ],
    edges: [
      { from: "start", to: "check" },
      { from: "check", to: "review" },
      { from: "review", to: "approve" },
      { from: "approve", to: "exit", label: "Approve" },
      { from: "approve", to: "check", label: "Revise" },
    ],
    created_at: now - 9 * 24 * 60 * MIN,
    updated_at: now - 2 * 24 * 60 * MIN,
  },
];

export const WORKFLOW_RUNS = (now: number) => {
  const started = now - 14 * MIN;
  return [
    {
      _id: REVIEW_RUN_ID,
      _creationTime: started,
      user_id: PEOPLE.me._id,
      workflow_id: REVIEW_WORKFLOW_ID,
      workflow_name: "review",
      task_id: "hero-t1",
      task_short_id: "ct-4182",
      task_title: "Retry queue for failed webhooks",
      status: "paused",
      current_node_id: "approve",
      node_statuses: [
        { node_id: "start", status: "completed", started_at: started, completed_at: started },
        { node_id: "check", status: "completed", outcome: "success", started_at: started, completed_at: started + 3 * MIN, label: "Typecheck", phase: "Check", result_preview: "0 type errors; 16 pass, 0 fail" },
        { node_id: "review", status: "completed", outcome: "success", session_id: `${SESSIONS.lead._id}-sess`, started_at: started + 3 * MIN, completed_at: started + 11 * MIN, label: "Review", phase: "Review", tokens: 48_200, result_preview: "No blocking issues. One suggestion: cap the jitter at 20% of the delay." },
        { node_id: "approve", status: "running", started_at: started + 11 * MIN, label: "Approve", phase: "Decide" },
      ],
      project_path: "/Users/alex/src/acme-api",
      primary_conversation_id: SESSIONS.lead._id,
      primary_session_id: `${SESSIONS.lead._id}-sess`,
      gate_node_id: "approve",
      gate_prompt: "Ship this change, or send it back? The check passed and the review found nothing blocking.",
      gate_choices: [
        { key: "A", label: "Approve", target: "exit" },
        { key: "R", label: "Revise", target: "check" },
      ],
      phases: [{ title: "Check" }, { title: "Review" }, { title: "Decide" }],
      total_tokens: 48_200,
      agent_count: 1,
      run_kind: "workflow",
      workspace: WORKSPACE,
      team_id: TEAM_ID,
      created_at: started,
      updated_at: started + 11 * MIN,
    },
  ];
};

export const WORKFLOWS_PART: AcmePart = {
  name: "workflows",
  answers: {
    "workflows:webList": () => WORKFLOWS(Date.now()),
    "workflows:webGet": (a) => WORKFLOWS(Date.now()).find((w) => w._id === a?.id) ?? null,
    "workflow_runs:get": (a) => WORKFLOW_RUNS(Date.now()).find((r) => r._id === a?.id) ?? null,
    "workflow_runs:listForWorkflow": (a) => WORKFLOW_RUNS(Date.now()).filter((r) => r.workflow_id === a?.workflow_id),
  },
};
