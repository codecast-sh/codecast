// Starter dashboards a person picks from the Docs "+" picker: real blocks
// bound to codecast's own sources, so a new dashboard opens with numbers on
// it, not an empty grid. Each template's words use live tokens, never typed
// numbers, and pass the same checks an agent's writes do.
import type { ArtifactOp, Json } from "./core";
import { newElementKey } from "./spec";

export type DashboardTemplate = { id: string; label: string; ops: () => ArtifactOp[] };

/** A block as written here: plain data, checked as an element when it is applied. */
type Block = { k: string; kind: string } & Record<string, unknown>;

/** Blocks in reading order, keyed fresh each time so two dashboards from one template never share keys. */
function build(make: (key: (name: string) => string) => Block[]): ArtifactOp[] {
  const keys = new Map<string, string>();
  const key = (name: string) => {
    if (!keys.has(name)) keys.set(name, newElementKey("b"));
    return keys.get(name)!;
  };
  return make(key).map((b, i): ArtifactOp => {
    const { k, kind, ...fields } = b;
    return { k, put: { kind, ...(fields as Record<string, Json>), order: i + 1 } };
  });
}

const usage = (days: number, by?: "person") => ({ source: "usage", args: { days, ...(by ? { group_by: by } : {}) } });

export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  {
    id: "agent-spend",
    label: "Agent spend",
    ops: () =>
      build((k) => [
        { k: k("spend"), kind: "kpi", title: "Agent spend", query: usage(30), field: "spend", agg: "sum", format: "usd", compare: "halves", good: "down" },
        { k: k("tokens"), kind: "kpi", title: "Tokens", query: usage(30), field: "tokens", agg: "sum", format: "compact", compare: "halves" },
        { k: k("top"), kind: "kpi", title: "Top spender", query: usage(30, "person"), field: "spend", agg: "top", label: "person" },
        { k: k("note"), kind: "text", text: `Agent spend is {${k("spend")}.trend} on {${k("spend")}.vs}.` },
        { k: k("daily"), kind: "chart", title: "Spend per day", chart: "stacked", query: usage(30, "person"), x: "day", y: "spend", series: "person", format: "usd", span: 8 },
        { k: k("who"), kind: "chart", title: "Who spends", chart: "hbar", query: usage(30, "person"), x: "person", y: "spend", format: "usd", span: 4 },
      ]),
  },
  {
    id: "delivery",
    label: "Delivery",
    ops: () =>
      build((k) => [
        { k: k("done"), kind: "kpi", title: "Tasks finished", query: { source: "tasks", args: { view: "done_per_day", days: 30, board: "all" } }, field: "done", agg: "sum", compare: "halves", good: "up" },
        { k: k("merged"), kind: "kpi", title: "PRs merged", query: { source: "prs", args: { days: 30 } }, field: "merged", agg: "sum", compare: "halves", good: "up" },
        { k: k("note"), kind: "text", text: `Finished tasks are {${k("done")}.trend} and merged PRs are {${k("merged")}.trend} on {${k("merged")}.vs}.` },
        { k: k("done_chart"), kind: "chart", title: "Finished per day", chart: "bar", query: { source: "tasks", args: { view: "done_per_day", days: 30, board: "all" } }, x: "day", y: "done", span: 6 },
        { k: k("prs"), kind: "chart", title: "Pull requests", chart: "line", query: { source: "prs", args: { days: 30 } }, x: "day", y: "opened,merged", span: 6 },
        { k: k("status"), kind: "table", title: "Open work by status", query: { source: "tasks", args: { view: "status", days: 30, board: "all" } }, sort: "-tasks" },
      ]),
  },
  {
    id: "team-activity",
    label: "Team activity",
    ops: () =>
      build((k) => [
        { k: k("sessions"), kind: "kpi", title: "Sessions", query: { source: "sessions", args: { days: 30, group_by: "person" } }, field: "sessions", agg: "sum", compare: "halves", good: "up" },
        { k: k("spend"), kind: "kpi", title: "Agent spend", query: usage(30), field: "spend", agg: "sum", format: "usd", compare: "halves", good: "down" },
        { k: k("note"), kind: "text", text: `Sessions are {${k("sessions")}.trend} on {${k("sessions")}.vs}, with spend {${k("spend")}.trend}.` },
        { k: k("per_day"), kind: "chart", title: "Sessions per day", chart: "stacked", query: { source: "sessions", args: { days: 30, group_by: "person" } }, x: "day", y: "sessions", series: "person", span: 12 },
        { k: k("people"), kind: "table", title: "Sessions by person", query: { source: "sessions", args: { days: 30, group_by: "person" } }, group: "person", sort: "-sessions" },
      ]),
  },
];
