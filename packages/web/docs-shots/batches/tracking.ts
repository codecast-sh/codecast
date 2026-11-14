// Tracking: tasks and plans, pull requests, triggers, workflows,
// orchestration and org roles ("tracking" in ../shots-desktop.json), plus the
// main docs page's tasks, plan, triggers and integrations images.
import type { Shot } from "../manifest";
import { PLANS } from "../../lib/acmeWorld/world";
import { TRIGGER_IDS, SUMMARY_RUNS } from "../../lib/acmeWorld/triggers";
import { PR_RETRY, REPO } from "../../lib/acmeWorld/pullRequests";
import { REVIEW_RUN_ID } from "../../lib/acmeWorld/workflows";

const PLAN = `/plans/${PLANS(0)[0].short_id}`;
/** The plan page's work section under its document: progress, tabs, the tab's content. */
const PLAN_SECTION = "[data-cc-shell] .max-w-5xl .mt-16";
const PLAN_PANEL = { selector: PLAN_SECTION, pad: 16 };
const PLAN_VIEWPORT = { width: 1400, height: 1500 };
/** Open a plan tab, then bring the work section to the top of the page's scroller. */
const tab = (label: string) => [
  { wait: "button", text: label },
  { click: "button", text: label },
  { sleep: 800 },
  { js: `document.querySelector(${JSON.stringify(PLAN_SECTION)}).scrollIntoView({ block: "start" })` },
  { sleep: 400 },
];
const PR = `/pr/${REPO}/${PR_RETRY.number}`;
/** Agent features with one feature's How it works open. */
const feature = (slug: string, doc: string): Shot => ({
  name: `${doc}/feature`,
  route: `/agent-features?feature=${slug}`,
  viewport: { width: 1280, height: 900 },
  steps: [{ wait: "[role=dialog] h2" }, { sleep: 800 }],
  frame: "window",
  out: `public/documentation/${doc}/feature.webp`,
});

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
    viewport: { width: 2100, height: 900 },
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
    ready: "header.pr-band",
    viewport: { width: 1280, height: 860 },
    frame: "window",
    out: "public/documentation/shots/pull-request.webp",
  },

  /* ── Triggers ────────────────────────────────────────────────────────── */
  {
    name: "triggers/list",
    route: "/triggers",
    // The pointer off the rows, so none shows its hover actions.
    steps: [{ hover: "button", text: "New trigger" }, { sleep: 400 }],
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
    steps: [{ wait: "li, p", text: "Posted in #eng" }, { sleep: 600 }],
    viewport: { width: 1100, height: 800 },
    frame: "window",
    out: "public/documentation/triggers/run.webp",
  },

  {
    name: "pull-requests/header",
    route: PR,
    viewport: { width: 1280, height: 860 },
    crop: { selector: "header.pr-band", pad: 0 },
    frame: "element",
    out: "public/documentation/pull-requests/header.webp",
  },
  {
    name: "pull-requests/review",
    route: `${PR}/files`,
    viewport: { width: 1400, height: 900 },
    steps: [
      { wait: "button", text: "Finish review" },
      { click: "button", text: "Finish review" },
      { wait: "textarea[placeholder='Anything else for the author?']" },
      { click: "textarea[placeholder='Anything else for the author?']" },
      { type: "Two small things on the retry path, then it's good to go." },
      { click: "[role=radio]", text: "Request changes" },
      { sleep: 600 },
    ],
    frame: "window",
    out: "public/documentation/pull-requests/review.webp",
  },
  feature("pr", "pull-requests"),

  /* ── Feature cards ───────────────────────────────────────────────────── */
  feature("tasks", "tasks-and-plans"),
  feature("orchestration", "orchestration"),
  feature("triggers", "triggers"),
  feature("workflows", "workflows"),

  /* ── New trigger ─────────────────────────────────────────────────────── */
  {
    name: "triggers/new",
    route: "/triggers",
    viewport: { width: 1280, height: 900 },
    steps: [
      { wait: "button", text: "New trigger" },
      { click: "button", text: "New trigger" },
      { wait: "textarea[placeholder^='What should the agent do']" },
      { click: "textarea[placeholder^='What should the agent do']" },
      { type: "Summarize open webhook PRs and what merged yesterday" },
      { click: "button", text: "every…" },
      { wait: "input[aria-invalid]" },
      // Empty the duration field the way a select-all would, then type the cadence.
      { js: "(() => { const i = document.querySelector('input[aria-invalid]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()" },
      { click: "input[aria-invalid]" },
      { type: "1d" },
      { click: "label", text: "read-only" },
      { click: "input[placeholder='Optional path']" },
      { type: "~/src/acme-api" },
      { hover: "button", text: "Set trigger" },
      { sleep: 600 },
    ],
    frame: "window",
    out: "public/documentation/triggers/new.webp",
  },

  /* ── Workflows ───────────────────────────────────────────────────────── */
  {
    name: "workflows/gate",
    route: `/workflows/runs/${REVIEW_RUN_ID}`,
    viewport: { width: 1280, height: 900 },
    frame: "window",
    out: "public/documentation/workflows/gate.webp",
  },
  {
    name: "workflows/graph",
    route: `/workflows/runs/${REVIEW_RUN_ID}`,
    viewport: { width: 1280, height: 1200 },
    steps: [{ wait: "button", text: "graph" }, { click: "button", text: "graph" }, { sleep: 1200 }],
    frame: "window",
    out: "public/documentation/workflows/graph.webp",
  },
  {
    name: "workflows/start",
    route: "/routines",
    viewport: { width: 1280, height: 860 },
    steps: [
      { js: "localStorage.setItem('wf_last_project_path', '/Users/alex/src/acme-api')" },
      { wait: "button", text: "Run" },
      { js: "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run').click()" },
      { sleep: 800 },
    ],
    frame: "window",
    out: "public/documentation/workflows/start.webp",
  },

  /* ── Integrations ────────────────────────────────────────────────────── */
  {
    name: "app/integrations",
    route: "/settings/integrations",
    viewport: { width: 1200, height: 900 },
    frame: "window",
    out: "public/docs/app/integrations.webp",
  },
  {
    name: "pull-requests/issues",
    route: "/settings/integrations",
    viewport: { width: 1200, height: 1100 },
    frame: "window",
    out: "public/documentation/pull-requests/issues.webp",
  },

  /* ── Org roles ───────────────────────────────────────────────────────── */
  {
    name: "org-roles/hire-head-of-people",
    route: "/org",
    viewport: { width: 1440, height: 900 },
    steps: [
      // The chart before anyone was hired: the same tree with no roles on it.
      { wait: "[data-cc-shell]" },
      { js: "(() => { const s = __inboxStore.getState(); s.syncTable('orgTree', { ...s.orgTree, roles: [], anchors: [] }); })()" },
      { wait: "[data-org-panel-hire]" },
      { sleep: 800 },
    ],
    frame: "window",
    out: "public/documentation/org-roles/hire-head-of-people.webp",
  },
  {
    name: "org-roles/role",
    route: "/org/rl-hooks",
    viewport: { width: 1440, height: 900 },
    frame: "window",
    out: "public/documentation/org-roles/role.webp",
  },
  {
    name: "org-roles/proposal",
    route: "/org?proposal=op-41",
    viewport: { width: 1440, height: 1000 },
    steps: [{ wait: "button", text: "Accept" }, { sleep: 800 }],
    frame: "window",
    out: "public/documentation/org-roles/proposal.webp",
  },
];
