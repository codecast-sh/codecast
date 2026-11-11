"use client";
// The task page's header, both ways. Classic draws it inside the page's
// column: the id row (id, issue, team, project, call; share, watch, close),
// then the parent line and the title. Modern draws the shared page header
// pinned above the body (components/ui/page-header): the back control and
// the task's place (Tasks, a plan, a project), its status and name, the id and
// the actions, and the facts on a second row.

import { useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CornerDownRight, MoreHorizontal, X } from "lucide-react";
import { policyTeamOf } from "@codecast/shared/contracts";
import { ShareControl } from "../../../components/ShareControl";
import { WatchButton } from "../../../components/WatchButton";
import { IssueLink } from "../../../components/tasks/IssueLink";
import { CallListFeeder, TaskCallChip } from "../../../components/tasks/TaskCallChip";
import { PageHeader } from "../../../components/ui/page-header";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { copyToClipboard } from "../../../lib/utils";
import { projectDotClass } from "../../../lib/projectColors";
import type { TaskDetail } from "../../../store/inboxStore";

// Header ⋯ menu for secondary actions that don't earn a slot in the narrow
// header row (watch state lives here). Clicking an item closes the menu.
function OverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`p-1 rounded-md transition-colors hover:bg-sol-bg-alt ${open ? "text-sol-text bg-sol-bg-alt" : "text-sol-text-dim hover:text-sol-text"}`}
        title="More actions"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          className="absolute top-full right-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-50 py-1 overflow-hidden"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A task status as its icon and colour (lib/taskStatuses statusVisual). */
type TaskStatusLook = { icon: ComponentType<{ className?: string }>; color: string };

type HeadFacts = {
  data: TaskDetail;
  teamInfo: { name: string } | null;
  taskProject: { _id: string; title: string; color?: string } | null;
  taskTeamId: string | undefined;
  isInline: boolean;
  onOpen?: () => void;
  /** The ✕: the peek's own close, or the page's (hooks/useNavTrail useNavClose). */
  close: () => void;
};

export type TaskTitleEdit = {
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  commit: () => void;
  cancel: () => void;
  start: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
};

/** Classic: the card header, id + badges + watch, with actions. */
export function TaskHeadIdRow({ data, teamInfo, taskProject, taskTeamId, isInline, onOpen, close }: HeadFacts) {
  return (
          <div data-page-head className="flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden text-xs text-sol-text-dim">
              <button
                onClick={() => { copyToClipboard(data.short_id); toast.success("Task ID copied"); }}
                className="font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/30 hover:border-sol-cyan/40 hover:text-sol-cyan transition-colors cursor-copy whitespace-nowrap flex-shrink-0"
                title="Click to copy ID"
              >
                {data.short_id}
              </button>
              {data.external && <IssueLink external={data.external} size="sm" />}
              {teamInfo && (
                <span className="px-1.5 py-0.5 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 text-meta truncate min-w-0">{teamInfo.name}</span>
              )}
              {/* Where this task lives. A link, because the project is a place
                  you can work from — and suppressed when you are already inside
                  that project, where the breadcrumb overhead has just said so. */}
              {taskProject && (
                <Link
                  href={`/projects/${taskProject._id}`}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/30 text-meta text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors truncate min-w-0"
                  title={`Open project: ${taskProject.title}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass(taskProject)}`} />
                  <span className="truncate">{taskProject.title}</span>
                </Link>
              )}
              {/* The call this task was pulled from: its recap and sibling tasks. */}
              {data.from_call && <><TaskCallChip callId={data.from_call} size="head" /><CallListFeeder /></>}
              {!taskTeamId && (
                <span className="px-1.5 py-0.5 rounded bg-sol-text-dim/10 text-sol-text-dim border border-sol-text-dim/20 text-meta whitespace-nowrap flex-shrink-0">Personal</span>
              )}
              {data.source === "insight" && (
                <span className="px-1.5 py-0.5 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20 text-meta whitespace-nowrap flex-shrink-0">mined</span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {isInline && onOpen && (
                <button onClick={onOpen} className="text-xs px-2 py-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors" title="Open full page">Open</button>
              )}
              <ShareControl label="task" path={`/tasks/${data.short_id}`} publicShare={{ kind: "task", id: data._id, token: data.share_token, team: policyTeamOf("tasks", data) }} />
              <OverflowMenu>
                <WatchButton entityType="task" entityId={data._id} variant="menuItem" />
              </OverflowMenu>
              <button
                onClick={close}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
  );
}

/** Parent breadcrumb — a subtask never renders context-free. */
export function TaskParentLine({ parent, onOpen }: { parent: { _id: string; short_id?: string; title?: string } | null; onOpen: () => void }) {
  return (
            <button
              onClick={onOpen}
              className="flex items-center gap-1.5 mb-2 text-xs text-sol-text-dim hover:text-sol-cyan transition-colors group"
              title={parent ? `Open ${parent.short_id}` : "Parent task"}
            >
              <CornerDownRight className="w-3 h-3 flex-shrink-0" />
              <span>Subtask of</span>
              <span className="font-mono">{parent?.short_id ?? "…"}</span>
              {parent && <span className="text-sol-text-muted group-hover:text-sol-cyan truncate max-w-[24rem]">{parent.title}</span>}
            </button>
  );
}

/** Classic: the status icon and the title, renamed in place. */
export function TaskHeadTitle({ title, status, edit }: { title: string; status: TaskStatusLook; edit: TaskTitleEdit }) {
  const StatusIcon = status.icon;
  return (
          <div data-page-head className="flex items-start gap-2.5 mb-3">
            <StatusIcon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${status.color}`} />
            <div className="flex-1 min-w-0">
              {edit.editing ? (
                <input
                  ref={edit.inputRef}
                  value={edit.draft}
                  onChange={(e) => edit.setDraft(e.target.value)}
                  onBlur={edit.commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") edit.commit();
                    if (e.key === "Escape") edit.cancel();
                  }}
                  className="w-full text-lg font-semibold text-sol-text bg-transparent border-b border-sol-cyan focus:outline-none pb-0.5"
                />
              ) : (
                <h1
                  className={`text-lg font-semibold text-sol-text leading-snug cursor-text hover:text-sol-cyan/90 transition-colors `}
                  onClick={edit.start}
                  title="Rename"
                >
                  {title}
                </h1>
              )}
            </div>
          </div>
  );
}

const FACT = "inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-meta";

/** Modern: the shared page header, pinned above the task's body. */
export function TaskModernHeader({ data, teamInfo, taskProject, taskTeamId, isInline, onOpen, close, status, edit }: HeadFacts & { status: TaskStatusLook; edit: TaskTitleEdit }) {
  const StatusIcon = status.icon;
  const facts = data.external || teamInfo || taskProject || data.from_call || !taskTeamId || data.source === "insight";
  return (
    <PageHeader
      legacy={null}
      // Inside a reveal band the band's strip names and shares it (globals.css).
      data-page-head
      data-task-head
      title={data.title}
      // The peek beside a list is part of the list's page: the list owns the way out.
      back={isInline ? false : undefined}
      crumbs={isInline ? null : undefined}
      glyph={<StatusIcon className={`size-4 ${status.color}`} />}
      titleNode={edit.editing ? (
        <input
          ref={edit.inputRef}
          value={edit.draft}
          aria-label="Task title"
          onChange={(e) => edit.setDraft(e.target.value)}
          onBlur={edit.commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") edit.commit();
            if (e.key === "Escape") edit.cancel();
          }}
          className="min-w-[12ch] flex-1 border-b border-sol-cyan bg-transparent text-read font-semibold text-sol-text outline-none"
        />
      ) : (
        <h1 title={data.title} onClick={edit.start} className="min-w-0 cursor-text truncate rounded-[4px] text-read font-semibold text-sol-text hover:bg-sol-bg-alt">
          {data.title}
        </h1>
      )}
      status={
        <button
          type="button"
          onClick={() => { copyToClipboard(data.short_id); toast.success("Task ID copied"); }}
          className="font-mono text-meta text-sol-text-dim hover:text-sol-cyan cursor-copy"
          title="Copy the task's id"
        >
          {data.short_id}
        </button>
      }
      actions={<>
        {isInline && onOpen && (
          <button type="button" onClick={onOpen} className="h-control-sm rounded-control px-2 text-ui text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text" title="Open full page">Open</button>
        )}
        <OverflowMenu>
          <WatchButton entityType="task" entityId={data._id} variant="menuItem" />
        </OverflowMenu>
      </>}
      share={<>
        <ShareControl label="task" path={`/tasks/${data.short_id}`} publicShare={{ kind: "task", id: data._id, token: data.share_token, team: policyTeamOf("tasks", data) }} />
        <button type="button" onClick={close} className="inline-flex size-7 items-center justify-center rounded-control text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text" title="Close" aria-label="Close">
          <X className="size-4" />
        </button>
      </>}
    >
      {facts ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sol-text-dim">
          {data.external && <IssueLink external={data.external} size="sm" />}
          {teamInfo && <span className={`${FACT} bg-sol-cyan/10 text-sol-cyan`}>{teamInfo.name}</span>}
          {taskProject && (
            <Link href={`/projects/${taskProject._id}`} className={`${FACT} bg-sol-bg-alt text-sol-text-muted no-underline hover:text-sol-text`} title={`Open project: ${taskProject.title}`}>
              <span className={`size-1.5 rounded-full ${projectDotClass(taskProject)}`} />
              <span className="truncate">{taskProject.title}</span>
            </Link>
          )}
          {data.from_call && <><TaskCallChip callId={data.from_call} size="head" /><CallListFeeder /></>}
          {!taskTeamId && <span className={`${FACT} bg-sol-bg-alt`}>Personal</span>}
          {data.source === "insight" && <span className={`${FACT} bg-sol-violet/10 text-sol-violet`}>mined</span>}
        </div>
      ) : null}
    </PageHeader>
  );
}
