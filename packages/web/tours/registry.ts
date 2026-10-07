// Every tour, in the order the Tours panel lists them. The org tour teaches
// a role's page as it works today (docs/architecture/org-staffing.md): its
// card, the triggers that wake it and are controlled there, pause and retire,
// and reports-to as whose inbox. The org screen itself (S41) has no tour: the
// strip, the conversation and the map are read in that order.
//
// Copy rules (tours/registry.test.ts): a title is at most three words, a body
// is one to three short sentences, and nothing in a step is a short id, a
// threshold or a word from the capacity model.
import type { TourDef } from "./types";

const ROLE_ROUTE = { href: "/org", match: (p: string) => /^\/org\/[^/]+/.test(p) };

export const TOURS: TourDef[] = [
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
