"use client";
/**
 * The Timeline tab: everything that happened in a project, one feed.
 *
 * The backend (api.projectUpdates.webTimeline) merges update posts and their
 * comments, task lifecycle from task_history, plan entries and doc creation
 * into one time-ordered list. This view's job is legibility: group by day,
 * hang every event off one vertical rail, and give each kind a small icon and
 * color so the eye can skim a week in a glance. Update posts render as cards —
 * they are the narrated moments; everything else is a one-line fact.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  ArrowRight,
  Circle,
  FilePlus2,
  GitCommit,
  History,
  ListPlus,
  Megaphone,
  MessageSquare,
  Sparkles,
  Target,
} from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { SegmentedToggle } from "./SegmentedToggle";
import { groupByDay, RailBare, RailDay, RailRow, StatusWord } from "./timeline/Rail";
import { ExternalEventRow } from "./feed/ExternalEventRow";
import { externalEventRowToExternalEvent, type ExternalEventRecord } from "../lib/externalEvents";
import { useSyncProjectExternalEvents, useExternalEvents, externalEventsNewestFirst } from "../hooks/useSyncExternalEvents";

const api = _api as any;

type TimelineEvent = {
  ts: number;
  type:
    | "project_created"
    | "update_posted"
    | "update_comment"
    | "task_created"
    | "task_status"
    | "task_comment"
    | "plan_created"
    | "plan_entry"
    | "doc_created"
    | "git";
  actor?: string;
  actor_kind?: "user" | "agent" | "system";
  update?: { id: string; short_id?: string; title?: string; kind: "update" | "digest"; body: string };
  text?: string;
  task?: { short_id?: string; title: string; status: string; priority?: string };
  old_value?: string;
  new_value?: string;
  plan?: { short_id?: string; title: string; status: string };
  entry_type?: string;
  doc?: { id: string; title: string; doc_type?: string };
  /** Set only on "git" rows: the store row this event was built from. */
  git?: ExternalEventRecord;
};

/** Icon + accent per event kind. The rail dot wears the accent; rows stay calm. */
const EVENT_STYLE: Record<TimelineEvent["type"], { icon: typeof Circle; color: string }> = {
  project_created: { icon: Target, color: "text-sol-violet" },
  update_posted: { icon: Megaphone, color: "text-sol-blue" },
  update_comment: { icon: MessageSquare, color: "text-sol-blue" },
  task_created: { icon: ListPlus, color: "text-sol-text-dim" },
  task_status: { icon: ArrowRight, color: "text-sol-yellow" },
  task_comment: { icon: MessageSquare, color: "text-sol-text-dim" },
  plan_created: { icon: Target, color: "text-sol-cyan" },
  plan_entry: { icon: History, color: "text-sol-cyan" },
  doc_created: { icon: FilePlus2, color: "text-sol-orange" },
  git: { icon: GitCommit, color: "text-sol-blue" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "people", label: "People" },
  { key: "updates", label: "Updates" },
  { key: "tasks", label: "Tasks" },
  { key: "plans", label: "Plans & docs" },
  { key: "git", label: "Git & issues" },
] as const;

const FILTER_TYPES: Record<string, Set<TimelineEvent["type"]>> = {
  updates: new Set(["update_posted", "update_comment"]),
  tasks: new Set(["task_created", "task_status", "task_comment"]),
  plans: new Set(["plan_created", "plan_entry", "doc_created"]),
  git: new Set(["git"]),
};

function TaskLink({ task }: { task: NonNullable<TimelineEvent["task"]> }) {
  const inner = (
    <span className="text-sol-text hover:text-sol-cyan transition-colors truncate">{task.title}</span>
  );
  return task.short_id ? <Link href={`/tasks/${task.short_id}`}>{inner}</Link> : inner;
}

function Actor({ event }: { event: TimelineEvent }) {
  if (!event.actor) return null;
  return (
    <span className="text-sol-text font-medium">
      {event.actor}
      {event.actor_kind === "agent" && <Sparkles className="inline w-2.5 h-2.5 ml-1 text-sol-violet" />}
    </span>
  );
}

function EventBody({ event }: { event: TimelineEvent }) {
  switch (event.type) {
    case "project_created":
      return <span className="text-sol-text-muted">Project created</span>;
    case "update_posted":
      return (
        <div className="flex-1 min-w-0 rounded-lg border border-sol-border/30 bg-sol-bg p-2.5">
          <div className="flex items-baseline gap-2">
            <Actor event={event} />
            <span className="text-sol-text-dim">
              posted {event.update?.kind === "digest" ? "a digest" : "an update"}
            </span>
          </div>
          {event.update?.title && (
            <div className="text-sm font-medium text-sol-text mt-1">{event.update.title}</div>
          )}
          {event.update?.body && (
            <div className="text-xs text-sol-text-muted mt-1">
              <MarkdownRenderer content={event.update.body} className="cc-cmt-md" />
            </div>
          )}
        </div>
      );
    case "update_comment":
      // The one row type whose payload is guaranteed clipped links to the
      // full thread on the Updates tab.
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">commented on</span>{" "}
          <Link href="?tab=updates" className="text-sol-text hover:text-sol-cyan transition-colors">
            {event.update?.title || "an update"}
          </Link>
          {event.text && <span className="text-sol-text-muted">: {event.text}</span>}
        </span>
      );
    case "task_created":
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">filed</span>{" "}
          <TaskLink task={event.task!} />
        </span>
      );
    case "task_status":
      // Transition first, title second: the title is the part that can afford
      // to truncate; the status change is the reason the row exists.
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">moved</span>{" "}
          {event.old_value && (
            <>
              <StatusWord status={event.old_value} />
              <span className="text-sol-text-dim"> → </span>
            </>
          )}
          <StatusWord status={event.new_value} />{" "}
          <span className="text-sol-text-dim">·</span> <TaskLink task={event.task!} />
        </span>
      );
    case "task_comment":
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">on</span>{" "}
          <TaskLink task={event.task!} />
          {event.text && <span className="text-sol-text-muted">: {event.text}</span>}
        </span>
      );
    case "plan_created":
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">created plan</span>{" "}
          <Link
            href={`/plans?plan=${event.plan?.short_id ?? ""}`}
            className="text-sol-text hover:text-sol-cyan transition-colors"
          >
            {event.plan?.title}
          </Link>
        </span>
      );
    case "plan_entry":
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} />{" "}
          <span className="text-sol-text-dim">{event.entry_type ?? "note"} on</span>{" "}
          <Link
            href={`/plans?plan=${event.plan?.short_id ?? ""}`}
            className="text-sol-text hover:text-sol-cyan transition-colors"
          >
            {event.plan?.title}
          </Link>
          {event.text && <span className="text-sol-text-muted">: {event.text}</span>}
        </span>
      );
    case "git":
      // External rows paint through ExternalEventRow, not here.
      return null;
    case "doc_created":
      return (
        <span className="text-sol-text-muted min-w-0 truncate">
          <Actor event={event} /> <span className="text-sol-text-dim">wrote</span>{" "}
          <Link
            href={`/docs/${event.doc?.id}`}
            className="text-sol-text hover:text-sol-cyan transition-colors"
          >
            {event.doc?.title || "Untitled"}
          </Link>
          {event.doc?.doc_type && <span className="text-sol-text-dim"> ({event.doc.doc_type})</span>}
        </span>
      );
  }
}

export function ProjectTimeline({ projectId }: { projectId: string }) {
  const { data: events, error, retry } = useQueryNoThrow(
    api.projectUpdates.webTimeline,
    projectId ? { project_id: projectId } : "skip",
  );
  const [filter, setFilter] = useState<string>("all");

  // External events do not come from webTimeline: they are their own synced
  // collection, so mount the project feeder and read the store.
  useSyncProjectExternalEvents(projectId);
  const externalWhere = useMemo(
    () => (row: ExternalEventRecord) => !!projectId && !!row.project_ids?.includes(projectId),
    [projectId],
  );
  const externalRows = useExternalEvents(externalWhere, externalEventsNewestFirst);

  const groups = useMemo(() => {
    const now = Date.now();
    const externalEvents: TimelineEvent[] = externalRows.map((row) => ({
      ts: row.created_at ?? 0,
      type: "git",
      git: row,
    }));
    const list = [...((events ?? []) as TimelineEvent[]), ...externalEvents]
      .filter((e) => {
        if (filter === "all") return true;
        // "People" cuts across kinds: only what a human actually did — posts,
        // comments, status moves — with the agent and system churn stripped out.
        if (filter === "people") return e.actor_kind === "user";
        return FILTER_TYPES[filter]?.has(e.type);
      })
      // The server list arrives newest first; the git rows have to land in the
      // same order before the day grouping walks it.
      .sort((a, b) => b.ts - a.ts);
    return groupByDay(list, now);
  }, [events, filter, externalRows]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center">
        <p className="text-xs text-sol-text-dim">The timeline could not load.</p>
        <button onClick={retry} className="mt-2 text-[11px] text-sol-cyan hover:underline">
          Try again
        </button>
      </div>
    );
  }
  if (events === undefined) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center text-xs text-sol-text-dim">Loading timeline…</div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-4 px-2">
      {/* Kind filter — the feed mixes narration with mechanics; let the reader
          pick which layer they are reading. */}
      <div className="mb-4 w-fit">
        <SegmentedToggle value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ ...f }))} />
      </div>

      {groups.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <History className="w-8 h-8 text-sol-text-dim/20 mb-2" />
          <p className="text-xs text-sol-text-dim">
            {filter === "all" ? "Nothing here yet" : "No matching activity"}
          </p>
          <p className="text-[11px] text-sol-text-dim/60 mt-1">
            {filter === "all"
              ? "Task changes, updates and comments in this project will land here as they happen"
              : filter === "people"
                ? "No human activity in this window — switch to All to see everything"
                : "Nothing of this kind yet — switch to All to see everything"}
          </p>
        </div>
      )}

      {groups.map((group) => (
        <RailDay key={group.label} label={group.label}>
          {group.events.map((e, i) => {
            // A git event brings its own disc, color and time.
            if (e.type === "git" && e.git) {
              return (
                <RailBare key={e.git._id}>
                  <ExternalEventRow
                    event={externalEventRowToExternalEvent(e.git)}
                    density="compact"
                    omitRefs={["project_id"]}
                  />
                </RailBare>
              );
            }
            const style = EVENT_STYLE[e.type];
            return (
              <RailRow key={`${e.ts}-${i}`} icon={style.icon} color={style.color} ts={e.ts} card={e.type === "update_posted"}>
                <EventBody event={e} />
              </RailRow>
            );
          })}
        </RailDay>
      ))}
    </div>
  );
}
