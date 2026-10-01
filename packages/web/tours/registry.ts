// Every tour, in the order the Tours panel lists them. The org tours teach
// the product as it works today (docs/architecture/org-staffing.md,
// org-hire.md): roles look after areas, the Head of People reviews the whole
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
    teaches: "What the chart shows, who the Head of People is, and how a proposal becomes a change.",
    area: "org",
    route: ORG_ROUTE,
    legacy: { ui: ["org_nux_seen"] },
    steps: [
      {
        id: "chart",
        target: '[data-org-node="me"]',
        title: "Who reports to whom",
        body: "People at the top, roles under them, and every session under whoever it reports to. Drag a card to move it.",
      },
      {
        id: "head",
        target: '[data-org-node="head"]',
        title: "The Head of People",
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
        target: '[data-org-node="ghost"], [data-org-health-open]',
        title: "Proposals",
        body: "A proposal arrives as dashed cards on the chart, one card per change. Accept, edit or skip each one right on the card; nothing changes until you do.",
      },
      {
        id: "health",
        target: '[data-org-health-open]',
        title: "Health",
        body: "Health is the loop: what needs you, how each role's week went, and the Head of People to talk it over with.",
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
        body: "Its face, its name, and where things stand in its own words. A state pill appears when it is working or waiting on you.",
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
    teaches: "The loop the org runs on: what needs you, each role's week, and the Head of People to talk it over with.",
    area: "org",
    route: ORG_ROUTE,
    steps: [
      {
        id: "needs-you",
        target: "[data-needs-you]",
        title: "Needs you",
        body: "Only what you must act on now: a decision routed to you, a role waiting on you, a proposal still open. When it is empty, nothing needs you.",
        prepare: { click: '[data-org-health-open][aria-pressed="false"]', until: "[data-health-page]" },
      },
      {
        id: "map",
        target: "[data-health-map]",
        title: "Each role's week",
        body: "Each card is a role's week: how much work reached it against how much it closed. Click a card for what is stuck and what you can change.",
        prepare: { click: '[data-org-health-open][aria-pressed="false"]', until: "[data-health-page]" },
      },
      {
        id: "signals",
        target: "[data-week-signal]",
        title: "What needs a person",
        body: "A chip on a card is read from the work itself: waiting on you, at its limit, stuck, or little getting closed.",
        optional: true,
      },
      {
        id: "head",
        target: '[data-head-column="open"]',
        title: "Talk to the Head of People",
        body: "The Head of People watches the whole org. Ask it about anything on this page, or tell it what to change; it answers with a proposal.",
        prepare: { click: '[data-head-column="closed"]', until: '[data-head-column="open"]' },
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
        id: "chart",
        target: '[data-org-node="ghost"], [data-proposal-tree]',
        title: "What would change",
        body: "Dashed cards are what the proposal would add or move. Everything solid stays as it is.",
        optional: true,
      },
      {
        id: "asks",
        target: "[data-ask-state]",
        title: "Each ask",
        body: "An ask is one decision, with what happens if you accept. Accept it or skip it; nothing else changes.",
        optional: true,
      },
      {
        id: "thread",
        target: "[data-thread-layout]",
        title: "Ask why",
        body: "The proposal is a conversation with the Head of People. Ask why, or say what you would change; it revises the proposal.",
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
    route: { href: "/inbox", match: (p: string) => p === "/" || p.startsWith("/inbox") || p.startsWith("/conversation") },
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
        body: "Who acts next: needs input is you, working and dormant are the agent, done is yours to read and clear.",
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
        target: "[data-list-tabs]",
        title: "Active, All, Done",
        body: "Active is the live work. All adds the backlog and what was dropped. Done is what finished.",
        optional: true,
      },
      {
        id: "toolbar",
        target: "[data-list-toolbar]",
        title: "Group and filter",
        body: "Group by status, assignee or project. Filter to a label or a person. Save the view to keep it.",
        optional: true,
      },
      {
        id: "row",
        target: '[data-index="1"], [data-index="0"]',
        title: "A task",
        body: "One row is one task: its status, who answers for it, and the sessions that worked on it. Open it for the whole story.",
        optional: true,
      },
      {
        id: "plans",
        target: null,
        title: "Plans",
        body: "A plan groups tasks toward one goal and shows how far along it is. A session binds to a plan while it works on it. Open Plans from the command palette.",
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
        target: "[data-trigger-home]",
        title: "Work that runs later",
        body: "A trigger runs an agent later: once, on a schedule, or when something happens. They are grouped by the session they run in.",
        optional: true,
      },
      {
        id: "row",
        target: "[data-schedrow]",
        title: "One trigger",
        body: "What it does, when it fires next, and how the last run went. Click it for every run and every change made to it.",
        optional: true,
      },
      {
        id: "controls",
        target: "[data-schedrow]",
        title: "Run, pause, edit",
        body: "Hover a row to run it now, edit it or delete it. Right click for pause and the rest.",
        optional: true,
      },
      {
        id: "new",
        target: '[data-tour="triggers-new"]',
        title: "A new one",
        body: "Write what should happen and when. A role's own triggers are also on its page in the org.",
      },
    ],
  },
];

export function tourById(id: string): TourDef | undefined {
  return TOURS.find((t) => t.id === id);
}
