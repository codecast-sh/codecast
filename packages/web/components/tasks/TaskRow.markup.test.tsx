// TaskRow and KanbanCard markup, frozen across their move out of the tasks
// page (heroFly/ARCHITECTURE.md section 3 item 9). The snapshot was written
// against the rows while they lived in app/tasks/page.tsx; the clock and the
// zone are pinned so the age column and dates render the same on every run.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import type { ItemRowState } from "../ListRowShell";
import { TaskRow, KanbanCard } from "./TaskRow";

process.env.TZ = "UTC";
const NOW = Date.UTC(2026, 8, 30, 18, 0);
Date.now = () => NOW;
// KanbanCard's age label reads `new Date()`, which the Date.now stub does not
// reach, so the bare constructor is pinned too.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
} as DateConstructor;
const MIN = 60_000;

const noop = () => {};
const state = (over: Partial<ItemRowState> = {}): ItemRowState => ({
  isFocused: false, isSelected: false, isEditing: false,
  onClick: noop, onSelect: noop, onContextMenu: noop, onEditDone: noop, onTitleCommit: noop, onOpenPalette: noop,
  ...over,
});

const base: TaskItem = {
  _id: "hero-t1",
  short_id: "ct-hero1",
  title: "Retry webhooks with backoff",
  task_type: "task",
  status: "in_progress",
  priority: "high",
  source: "human",
  created_at: NOW - 3 * 60 * MIN,
  updated_at: NOW - 25 * MIN,
};

const tasks: { name: string; task: TaskItem; extra?: Record<string, unknown> }[] = [
  { name: "plain", task: base },
  {
    name: "rich",
    task: {
      ...base,
      _id: "hero-t2",
      short_id: "ct-hero2",
      status: "open",
      priority: "urgent",
      source: "agent",
      source_agent_type: "claude_code",
      labels: ["backend", "infra", "billing"],
      assignee_info: { name: "Ada Lovelace" },
      origin_session: { conversation_id: "hero-c1", session_id: "s1", title: "Auth race" },
      session_count: 3,
      duplicate_of: "ct-hero9",
      blocked_by: ["ct-hero3"],
      execution_status: "done_with_concerns" as any,
      plan: { _id: "hero-pl1", title: "Launch week" } as any,
      updated_at: NOW - 3 * 86_400_000,
    },
    extra: { indent: 2, progress: { total: 4, done: 1, inProgress: 2 }, hiddenDescendantCount: 1, onToggleCollapse: noop, parentChip: { id: "hero-t0", short_id: "ct-hero0", title: "Parent" } },
  },
  { name: "meeting, triage", task: { ...base, _id: "hero-t3", source: "meeting", priority: "low", status: "done", updated_at: NOW - 5 * 60 * MIN }, extra: { triageMode: true, onTriage: noop, progress: { total: 2, done: 2, inProgress: 0 } } },
  { name: "insight, bot, editing", task: { ...base, _id: "hero-t4", source: "insight", priority: "none", session_count: 1 }, extra: { state: state({ isEditing: true, isFocused: true }) } },
];

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

for (const { name, task, extra } of tasks) {
  test(`TaskRow: ${name}`, () => {
    const { state: s, ...rest } = (extra ?? {}) as any;
    expect(wrap(<TaskRow task={task} state={s ?? state()} onFilterLabel={noop} {...rest} />)).toMatchSnapshot();
  });
  test(`KanbanCard: ${name}`, () => {
    const chip = (extra as any)?.parentChip ?? null;
    expect(wrap(<KanbanCard task={task} onFilterLabel={noop} onClick={noop} onContextMenu={noop} isDragging={name === "plain"} parentChip={chip} />)).toMatchSnapshot();
  });
}
