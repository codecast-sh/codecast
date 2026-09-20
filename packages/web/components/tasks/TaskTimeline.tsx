"use client";
/**
 * The task page's Activity section: everything that happened to one task, told
 * oldest first on the same rail the project Timeline uses (timeline/Rail).
 *
 * Four sources merge here. `history` is the server's audit trail (who created
 * the task, every status, assignee and field change). Comments are the
 * narration. Linked sessions mark when work actually started, and external
 * events bring commits, pull requests and issue activity. The filter lets a
 * reader drop the long comment bodies and read the bare trail of changes,
 * which is what "who did what, when" needs.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, History, ListPlus, MessageSquare, Pencil, Terminal, UserRound } from "lucide-react";
import { SegmentedToggle } from "../SegmentedToggle";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { CollapsibleBody } from "../CollapsibleBody";
import { ExternalEventRow } from "../feed/ExternalEventRow";
import { externalEventRowToExternalEvent, type ExternalEventRecord } from "../../lib/externalEvents";
import { groupByDay, RailBare, RailDay, RailRow, StatusWord } from "../timeline/Rail";
import { TaskCommentItem, UserBadge, type TaskCommentRow } from "./TaskCommentStream";
import type { TaskLinkedSession } from "./TaskSessionList";

type Person = { name: string; image?: string; github_username?: string };

type HistoryRow = {
  _id: string;
  created_at: number;
  action: string;
  field?: string;
  old_value?: string;
  new_value?: string;
  actor?: Person | null;
  old_value_resolved?: Person | null;
  new_value_resolved?: Person | null;
};

type Item =
  | { kind: "change"; ts: number; key: string; row: HistoryRow }
  | { kind: "comment"; ts: number; key: string; row: TaskCommentRow }
  | { kind: "session"; ts: number; key: string; row: TaskLinkedSession }
  | { kind: "git"; ts: number; key: string; row: ExternalEventRecord };

const FILTER_KINDS: Record<string, Item["kind"]> = {
  changes: "change",
  comments: "comment",
  sessions: "session",
  git: "git",
};

function Who({ person }: { person?: Person | null }) {
  return person
    ? <UserBadge name={person.name} image={person.image} username={person.github_username} />
    : <span className="text-sol-text font-medium">System</span>;
}

// Avatars and status icons sit beside plain words here, and a text baseline
// drops the words below the avatar's name. One line, centered.
function Line({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center flex-wrap gap-x-2 gap-y-0.5 min-w-0">{children}</span>;
}

function changeStyle(row: HistoryRow) {
  if (row.action === "created") return { icon: ListPlus, color: "text-sol-green" };
  if (row.field === "status") return { icon: ArrowRight, color: "text-sol-yellow" };
  if (row.field === "assignee") return { icon: UserRound, color: "text-sol-cyan" };
  return { icon: Pencil, color: "text-sol-text-dim" };
}

function ChangeBody({ row }: { row: HistoryRow }) {
  const dim = "text-sol-text-muted";
  if (row.action === "created") {
    return <><Who person={row.actor} /><span className={dim}>created this task</span></>;
  }
  if (row.field === "status") {
    return (
      <>
        <Who person={row.actor} />
        <span className={dim}>moved it from</span>
        <StatusWord status={row.old_value} />
        <span className={dim}>to</span>
        <StatusWord status={row.new_value} />
      </>
    );
  }
  if (row.field === "assignee") {
    return (
      <>
        <Who person={row.actor} />
        <span className={dim}>{row.new_value ? "assigned it to" : "removed the assignee"}</span>
        {row.new_value && (row.new_value_resolved
          ? <Who person={row.new_value_resolved} />
          : <span className="text-sol-text-muted italic">someone who has since left</span>)}
      </>
    );
  }
  return (
    <>
      <Who person={row.actor} />
      <span className={dim}>changed {row.field?.replace(/_/g, " ")}</span>
      {row.old_value && <span className="text-sol-text-dim line-through truncate max-w-[14rem]">{row.old_value}</span>}
      {row.new_value && <span className="text-sol-text truncate max-w-[14rem]">{row.new_value}</span>}
    </>
  );
}

export function TaskTimeline({
  task,
  sessions,
  externalEvents,
  openLinkedSession,
}: {
  task: { _id: string; created_at: number; creator?: Person | null; history?: HistoryRow[]; comments?: TaskCommentRow[] };
  sessions: TaskLinkedSession[];
  externalEvents: ExternalEventRecord[];
  openLinkedSession: (info: any) => void;
}) {
  const [filter, setFilter] = useState("all");

  const items = useMemo(() => {
    const history = task.history ?? [];
    // A task made from the CLI has no "created" row in its history. The task
    // row itself still knows who made it and when, so the trail always opens
    // with its first event.
    const created: HistoryRow[] = history.some((h) => h.action === "created")
      ? []
      : [{ _id: `created-${task._id}`, created_at: task.created_at, action: "created", actor: task.creator }];
    const all: Item[] = [
      ...[...created, ...history].map((row) => ({ kind: "change" as const, ts: row.created_at, key: row._id, row })),
      ...(task.comments ?? []).map((row) => ({ kind: "comment" as const, ts: row.created_at, key: row._id, row })),
      // A blank session that never got a message did no work on the task.
      ...sessions.filter((s) => s.started_at && (s.title || s.message_count)).map((row) => ({ kind: "session" as const, ts: row.started_at!, key: `s-${row._id}`, row })),
      ...externalEvents.map((row) => ({ kind: "git" as const, ts: row.created_at ?? 0, key: row._id, row })),
    ];
    return all.sort((a, b) => a.ts - b.ts);
  }, [task._id, task.created_at, task.creator, task.history, task.comments, sessions, externalEvents]);

  const count = (kind: Item["kind"]) => items.filter((i) => i.kind === kind).length;
  const filters = [
    { key: "all", label: "All", count: items.length },
    { key: "changes", label: "Changes", count: count("change") },
    { key: "comments", label: "Comments", count: count("comment") },
    { key: "sessions", label: "Sessions", count: count("session") },
    { key: "git", label: "Git & issues", count: count("git") },
  ].filter((f) => f.key === "all" || f.count > 0);

  const groups = useMemo(
    () => groupByDay(filter === "all" ? items : items.filter((i) => i.kind === FILTER_KINDS[filter]), Date.now()),
    [items, filter],
  );

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide flex items-center gap-1.5">
          <History className="w-3.5 h-3.5" />
          Activity
        </h2>
        {filters.length > 2 && <SegmentedToggle value={filter} onChange={setFilter} items={filters} variant="bare" />}
      </div>

      {groups.map((group) => (
        <RailDay key={group.label} label={group.label}>
          {group.events.map((item) => {
            if (item.kind === "git") {
              return (
                <RailBare key={item.key}>
                  <ExternalEventRow
                    event={externalEventRowToExternalEvent(item.row)}
                    density="compact"
                    omitRefs={["task_id", "task_short_id"]}
                  />
                </RailBare>
              );
            }
            if (item.kind === "comment") {
              return (
                <RailRow key={item.key} icon={MessageSquare} color="text-sol-blue" ts={item.ts} card clock>
                  <CollapsibleBody collapsedHeight={200} className="flex-1 min-w-0 -mt-1.5" expandLabel="Read the whole comment" collapseLabel="Collapse">
                    <TaskCommentItem comment={item.row} openLinkedSession={openLinkedSession} />
                  </CollapsibleBody>
                </RailRow>
              );
            }
            if (item.kind === "session") {
              const s = item.row;
              return (
                <RailRow key={item.key} icon={Terminal} color="text-sol-violet" ts={item.ts} clock>
                  <Line>
                    <button
                      type="button"
                      onClick={() => openLinkedSession(s)}
                      className="inline-flex items-center gap-1.5 min-w-0 text-sol-text font-medium hover:text-sol-cyan transition-colors"
                    >
                      <AgentTypeIcon agentType={s.agent_type || "claude_code"} className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{s.title || "Untitled session"}</span>
                    </button>
                    <span className="text-sol-text-muted flex-shrink-0">started working on it</span>
                  </Line>
                </RailRow>
              );
            }
            const style = changeStyle(item.row);
            return (
              <RailRow key={item.key} icon={style.icon} color={style.color} ts={item.ts} clock>
                <Line><ChangeBody row={item.row} /></Line>
              </RailRow>
            );
          })}
        </RailDay>
      ))}
    </div>
  );
}
