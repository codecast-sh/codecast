// Every tour, in the order the Tours panel lists them. The org tours teach
// the product as it works today (docs/architecture/org-staffing.md,
// org-hire.md): roles look after areas, the Chief of Staff reviews the whole
// and proposes, a proposal is cards you accept, edit or skip, triggers wake a
// role and are controlled on its page, the health panel is the loop, hiring
// starts in the template gallery, and reports-to is whose inbox.
//
// Copy rules (tours/registry.test.ts): a title is at most three words, a body
// is one to three short sentences, and nothing in a step is a short id, a
// threshold or a word from the capacity model.
import type { TourDef } from "./types";

const ORG_ROUTE = { href: "/org", match: (p: string) => p === "/org" || p === "/org/" };
const ROLE_ROUTE = { href: "/org", match: (p: string) => /^\/org\/[^/]+/.test(p) };

export const TOURS: TourDef[] = [
  {
    id: "org-page",
    title: "The org page",
    teaches: "What the chart shows, who the Chief of Staff is, and how a proposal becomes a change.",
    area: "org",
    route: ORG_ROUTE,
    legacy: { ui: ["org_nux_seen"] },
    steps: [
      {
        id: "chart",
        target: '[data-org-node="me"]',
        title: "Who reports to whom",
        body: "You are at the top. Your roles and sessions hang under you. Drag a card to move it.",
      },
      {
        id: "chief",
        target: '[data-org-node="chief"]',
        title: "The Chief of Staff",
        body: "It watches the whole org. Each week it reviews the work and proposes changes. Nothing changes until you accept.",
        optional: true,
      },
      {
        id: "role",
        target: '[data-org-node="role"]',
        title: "A role",
        body: "A role looks after one area. Its sessions report to it, not to you. Hover to see its area; double click to open its page.",
        optional: true,
      },
      {
        id: "proposals",
        target: '[data-org-health-open]',
        title: "Proposals",
        body: "A proposal arrives as dashed cards on the chart. Each card is one change. You accept, edit or skip it; skipped is skipped for good.",
        action: { label: "Open the proposal", click: '[data-org-health-open]', when: '[data-org-node="ghost"]' },
      },
      {
        id: "health",
        target: '[data-org-health-open]',
        title: "Health",
        body: "Health is the loop: what needs you, how each area is doing, and the Chief's read of the company.",
        action: { label: "Open Health", click: '[data-org-health-open][aria-pressed="false"]', when: '[data-org-health-open][aria-pressed="false"]' },
      },
      {
        id: "hire",
        target: '[data-org-hire-gallery], [data-org-guide="hire"]',
        title: "Hiring",
        body: "Hire picks a ready-made role from the gallery. Add a role writes one yourself. Either way the sessions in its area report to it.",
      },
    ],
  },
  {
    id: "org-role",
    title: "A role's page",
    teaches: "What a role's page holds: its card, its triggers, pause and retire, and how to ask it something.",
    area: "org",
    route: ROLE_ROUTE,
    steps: [
      {
        id: "card",
        target: "[data-scope-head]",
        title: "The role",
        body: "Its face, its name and its state. The state uses the inbox's words: working, needs you, dormant, done.",
      },
      {
        id: "reports",
        target: "[data-scope-reports-to]",
        title: "Reports to",
        body: "Whose inbox gets what this role cannot settle. Change it by dragging the card on the chart.",
        optional: true,
      },
      {
        id: "triggers",
        target: '[data-scope-tab="triggers"]',
        title: "Triggers",
        body: "What wakes the role: its regular check and any event it watches. Pause one, run it now, or change its cadence here.",
        prepare: { click: '[data-scope-panel-toggle="closed"]', until: "[data-scope-panel]" },
        action: { label: "Open Triggers", click: '[data-scope-tab="triggers"]' },
        optional: true,
      },
      {
        id: "pause",
        target: "[data-scope-actions]",
        title: "Pause or retire",
        body: "Pause stops the role and keeps everything. Retire removes it; its sessions report to you again.",
        optional: true,
      },
      {
        id: "ask",
        target: "[data-scope-conversation]",
        title: "Ask",
        body: "Talk to the role here. This thread is also where it raises what it cannot settle.",
      },
    ],
  },
  {
    id: "org-health",
    title: "The health panel",
    teaches: "The loop the org runs on: what needs you, how each area is doing, and the Chief's read.",
    area: "org",
    route: ORG_ROUTE,
    steps: [
      {
        id: "needs-you",
        target: "[data-needs-you]",
        title: "Needs you",
        body: "Only what you must act on now: a decision routed to you, a role waiting on you, a proposal still open. Empty means nothing does.",
        prepare: { click: '[data-org-health-open][aria-pressed="false"]', until: "[data-health-page]" },
      },
      {
        id: "areas",
        target: "[data-flow-rows]",
        title: "Areas",
        body: "One row per role: its face, one status word, its latest line. Open a row for its goals, waiting sessions, its check and Ask.",
        prepare: { click: '[data-org-health-open][aria-pressed="false"]', until: "[data-health-page]" },
      },
      {
        id: "status",
        target: "[data-area-status]",
        title: "The status word",
        body: "Read from the work itself: waiting on you, stuck, overloaded, quiet, or on track.",
        optional: true,
      },
      {
        id: "chief",
        target: '[data-chief-column="open"]',
        title: "The Chief's read",
        body: "Its latest line on the company, its newest proposal, and the next review. Talk to it here to change the structure.",
        prepare: { click: '[data-chief-column="closed"] button', until: '[data-chief-column="open"]' },
        optional: true,
      },
    ],
  },
  {
    id: "org-hire",
    title: "Hiring from the gallery",
    teaches: "How a ready-made role is hired: the gallery, what a card asks for, and where the hire lands.",
    area: "org",
    route: ORG_ROUTE,
    steps: [
      {
        id: "gallery",
        target: "[data-template-gallery]",
        title: "The gallery",
        body: "Each card is a ready-made role: its face, what it does, what it asks of you, and its routines.",
        prepare: { click: "[data-org-hire-gallery]", until: "[data-template-gallery]" },
        insideModal: true,
      },
      {
        id: "card",
        target: "[data-template-card]",
        title: "A card",
        body: "It lists what it needs: answers, a secret kept on your machine, a step only you can do. Hire shows when the workspace can take it.",
        optional: true,
        insideModal: true,
      },
      {
        id: "blocked",
        target: '[data-hireable="false"]',
        title: "Not yet",
        body: "A card you cannot hire yet says why in its own words.",
        optional: true,
        insideModal: true,
      },
      {
        id: "after",
        target: "[data-template-gallery]",
        title: "After the pick",
        body: "Pick a card and answer its questions. The role appears on the chart, and its page lists the last steps only you can do.",
        insideModal: true,
      },
    ],
  },
  {
    id: "org-proposal",
    title: "Deciding a proposal",
    teaches: "How to read a proposal and decide each change: accept, edit or skip.",
    area: "org",
    route: ORG_ROUTE,
    steps: [
      {
        id: "tree",
        target: "[data-proposal-tree]",
        title: "The change",
        body: "The tree is who would report to whom after the change. Dashed is new; everything else stays.",
        optional: true,
      },
      {
        id: "asks",
        target: "[data-ask-state]",
        title: "One ask at a time",
        body: "Each ask is one change: a role to hire, a session to move. Accept it, edit it, or skip it.",
        optional: true,
      },
      {
        id: "thread",
        target: "[data-thread-layout]",
        title: "Ask why",
        body: "The proposal is a conversation. Ask the Chief why; it answers with evidence you can open.",
        optional: true,
      },
    ],
  },
  {
    id: "inbox",
    title: "The inbox",
    teaches: "Cards arrive, the inbox sorts them by who acts next, and one key clears each.",
    area: "inbox",
    route: { href: "/inbox", match: (p: string) => p === "/" || p.startsWith("/inbox") },
    kind: "modal",
    legacy: { tips: ["nux-tour"] },
    steps: [],
  },
  {
    id: "session",
    title: "A session",
    teaches: "The header of a session: its state, who owns it, where it runs, and how to steer it.",
    area: "session",
    route: null,
    steps: [
      {
        id: "head",
        target: "[data-sv-convhead]",
        title: "One session",
        body: "The header is the session: its title, its state, the agent and model, and where it runs.",
      },
      {
        id: "state",
        target: "[data-cc-conv-status]",
        title: "The state",
        body: "Who acts next. Needs input is you. Working and dormant are the agent. Done is yours to read and clear.",
        optional: true,
      },
      {
        id: "facts",
        target: "[data-cc-facts]",
        title: "The facts",
        body: "Agent and model, branch, the task or plan it is bound to, its age. Hover one for the detail.",
        optional: true,
      },
      {
        id: "actions",
        target: "[data-cc-conv-actions]",
        title: "Owner and machine",
        body: "Who owns the session is whose inbox it sits in. The machine pill says where it runs; pick another to move it.",
        optional: true,
      },
      {
        id: "composer",
        target: "[data-composer-field]",
        title: "Steer it",
        body: "Type here to answer or redirect it. The send menu holds the variants: queue, interrupt, send to another agent.",
        optional: true,
      },
    ],
  },
  {
    id: "tasks",
    title: "Tasks and plans",
    teaches: "Where work is tracked: the task list, its filters, a task's page, and the plans that group tasks.",
    area: "work",
    route: { href: "/tasks", match: (p: string) => p.startsWith("/tasks") },
    steps: [
      {
        id: "tabs",
        target: '[data-tour="tasks-tabs"]',
        title: "Active, All, Done",
        body: "Active is the live work. All adds the backlog and the finished. Done is what shipped.",
        optional: true,
      },
      {
        id: "toolbar",
        target: '[data-tour="tasks-toolbar"]',
        title: "Group and filter",
        body: "Group by status, assignee or project. Filter to a label or a person. The view is saved for you.",
        optional: true,
      },
      {
        id: "row",
        target: '[data-tour="tasks-list"] [data-index="0"]',
        title: "A task",
        body: "One row is one task: its status, who answers for it, and the sessions that worked it. Open it for the whole story.",
        optional: true,
      },
      {
        id: "plans",
        target: '[data-tour="nav-plans"]',
        title: "Plans",
        body: "A plan groups tasks toward one goal and shows how far along it is. Sessions bind to a plan while they work on it.",
        optional: true,
      },
    ],
  },
  {
    id: "triggers",
    title: "Triggers",
    teaches: "What a trigger is, how to read one, and how to pause, run or cancel it.",
    area: "triggers",
    route: { href: "/triggers", match: (p: string) => p.startsWith("/triggers") },
    steps: [
      {
        id: "what",
        target: '[data-tour="triggers-list"]',
        title: "Follow-up work",
        body: "A trigger runs work later: once, on a schedule, or when something happens. Each row is one trigger and where it runs.",
        optional: true,
      },
      {
        id: "row",
        target: '[data-tour="triggers-list"] [data-trigger-row]',
        title: "One trigger",
        body: "Its prompt, its cadence, its last run and the next. Open it for every run and every change to it.",
        optional: true,
      },
      {
        id: "controls",
        target: '[data-tour="triggers-list"] [data-trigger-row] [data-trigger-controls]',
        title: "Pause, run, cancel",
        body: "Pause keeps it without firing. Run fires it now. Cancel ends it; its runs stay readable.",
        optional: true,
      },
      {
        id: "new",
        target: '[data-tour="triggers-new"]',
        title: "A new one",
        body: "Write what should happen and when. The run reports back here when it finishes.",
        optional: true,
      },
    ],
  },
];

export function tourById(id: string): TourDef | undefined {
  return TOURS.find((t) => t.id === id);
}
