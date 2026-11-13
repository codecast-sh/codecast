// Tracking: tasks and plans, pull requests, triggers, workflows,
// orchestration and org roles ("tracking" in ../shots-desktop.json), plus the
// main docs page's tasks, plan, triggers and integrations images.
import type { Shot } from "../manifest";
import { PLANS } from "../../lib/acmeWorld/world";
import { TRIGGER_IDS, SUMMARY_RUNS } from "../../lib/acmeWorld/triggers";
import { PR_RETRY, REPO } from "../../lib/acmeWorld/pullRequests";

const PLAN = `/plans/${PLANS(0)[0].short_id}`;
/** The plan page's work section under its document: progress, tabs, the tab's content. */
const PLAN_PANEL = { selector: "[data-cc-shell] .max-w-5xl .mt-16", pad: 16 };
const PLAN_VIEWPORT = { width: 1100, height: 2600 };
const tab = (label: string) => [{ wait: "button", text: label }, { click: "button", text: label }, { sleep: 800 }];
const PR = `/pr/${REPO}/${PR_RETRY.number}`;

export const TRACKING: Shot[] = [
  /* ── Main docs page ──────────────────────────────────────────────────── */
  {
    name: "app/tasks",
    route: "/tasks",
    viewport: { width: 1100, height: 700 },
    frame: "window",
    out: "public/docs/app/tasks.webp",
  },
  {
    name: "app/plan",
    route: PLAN,
    viewport: { width: 1100, height: 760 },
    frame: "window",
    out: "public/docs/app/plan.webp",
  },
  {
    name: "app/triggers",
    route: "/triggers",
    viewport: { width: 1200, height: 800 },
    frame: "window",
    out: "public/docs/app/triggers.webp",
  },

  /* ── Tasks and plans ─────────────────────────────────────────────────── */
  {
    name: "tasks-and-plans/plan",
    route: PLAN,
    viewport: PLAN_VIEWPORT,
    steps: tab("Overview"),
    crop: PLAN_PANEL,
    frame: "element",
    out: "public/documentation/tasks-and-plans/plan.webp",
  },
  {
    name: "tasks-and-plans/board",
    route: "/tasks?view=kanban",
    viewport: { width: 1840, height: 900 },
    frame: "window",
    out: "public/documentation/tasks-and-plans/board.webp",
  },
  {
    name: "tasks-and-plans/task",
    route: "/tasks/ct-4181",
    viewport: { width: 1200, height: 1700 },
    frame: "window",
    out: "public/documentation/tasks-and-plans/task.webp",
  },

  /* ── Orchestration ───────────────────────────────────────────────────── */
  {
    name: "orchestration/plan",
    route: PLAN,
    viewport: PLAN_VIEWPORT,
    steps: tab("Orchestration"),
    crop: PLAN_PANEL,
    frame: "element",
    out: "public/documentation/orchestration/plan.webp",
  },
  {
    name: "orchestration/graph",
    route: PLAN,
    viewport: PLAN_VIEWPORT,
    steps: tab("Graph"),
    crop: PLAN_PANEL,
    frame: "element",
    out: "public/documentation/orchestration/graph.webp",
  },

  /* ── Pull requests ───────────────────────────────────────────────────── */
  {
    name: "shots/pull-request",
    route: PR,
    viewport: { width: 1280, height: 860 },
    frame: "window",
    out: "public/documentation/shots/pull-request.webp",
  },

  /* ── Triggers ────────────────────────────────────────────────────────── */
  {
    name: "triggers/list",
    route: "/triggers",
    viewport: { width: 1280, height: 860 },
    frame: "window",
    out: "public/documentation/triggers/list.webp",
  },
  {
    name: "triggers/trigger",
    route: `/triggers/${TRIGGER_IDS.summary}`,
    viewport: { width: 1200, height: 860 },
    frame: "window",
    out: "public/documentation/triggers/trigger.webp",
  },
  {
    name: "triggers/run",
    route: `/conversation/${SUMMARY_RUNS[0]._id}`,
    viewport: { width: 1100, height: 800 },
    frame: "window",
    out: "public/documentation/triggers/run.webp",
  },
];
