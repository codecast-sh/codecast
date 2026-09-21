"use client";

// A workflow run's nodes as a list of sessions. Every surface that shows a
// run's steps renders this: the context panel on a task, plan or
// conversation, the run page, the routines side panel, the dashboard and the
// inline conversation card. A node that ran as a session is the same row the
// task page draws for a linked session (TaskSessionRow) with a step gutter in
// front, so it opens, drags and reads like a session anywhere else. A node
// with no session (a command, a gate, a step not yet reached) is a plain
// step row in the same gutter.

import Link from "next/link";
import { Bot, CheckCircle2, Circle, GitFork, Loader2, Merge, Terminal, User, XCircle, Zap } from "lucide-react";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { formatRunDuration, runNodeGroups, runNodeLine, wfFmtTokens, type RunNodeRow } from "../lib/workflowRun";
import { TaskSessionRow, type TaskLinkedSession } from "./tasks/TaskSessionList";

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  agent: Bot,
  prompt: Zap,
  command: Terminal,
  human: User,
  conditional: GitFork,
  parallel_fanout: GitFork,
  parallel_fanin: Merge,
};

function StepMark({ row }: { row: RunNodeRow }) {
  const cls = "w-3.5 h-3.5 flex-shrink-0";
  if (row.status === "completed") return <CheckCircle2 className={`${cls} text-sol-green`} aria-label="completed" />;
  if (row.status === "failed") return <XCircle className={`${cls} text-sol-red`} aria-label="failed" />;
  if (row.status === "running" || row.current) return <Loader2 className={`${cls} text-sol-cyan animate-spin`} aria-label="running" />;
  return <Circle className={`${cls} text-sol-text-dim/50`} aria-label="pending" />;
}

function stepTone(row: RunNodeRow): "failed" | "current" | undefined {
  if (row.status === "failed") return "failed";
  if (row.current || row.status === "running") return "current";
  return undefined;
}

// A verdict the status does not already say: "success" on a completed node
// and "failure" on a failed one add nothing.
function outcomeText(row: RunNodeRow): string | null {
  const o = row.outcome?.trim();
  if (!o) return null;
  if (row.status === "completed" && o === "success") return null;
  if (row.status === "failed" && o === "failure") return null;
  return o;
}

function StepMeta({ row, now }: { row: RunNodeRow; now: number }) {
  const duration = row.started_at ? formatRunDuration(row.started_at, row.completed_at, now) : null;
  const outcome = outcomeText(row);
  const tokens = wfFmtTokens(row.tokens);
  if (!duration && !outcome && !tokens) return null;
  return (
    <>
      {duration && <span className="tabular-nums flex-shrink-0">{duration}</span>}
      {tokens && <span className="tabular-nums flex-shrink-0">{tokens} tok</span>}
      {outcome && <span className={`truncate ${row.status === "failed" ? "text-sol-red/80" : ""}`}>{outcome}</span>}
    </>
  );
}

function NodeLabelChip({ label }: { label: string }) {
  return (
    <span className="flex-shrink-0 max-w-[10rem] truncate text-[9px] font-mono px-1 py-px rounded bg-sol-bg-alt text-sol-text-muted border border-sol-border/40">
      {label}
    </span>
  );
}

function SessionNodeRow({ row, now, onOpen }: { row: RunNodeRow; now: number; onOpen: (conv: TaskLinkedSession) => void }) {
  const s = row.session!;
  const snapshot: TaskLinkedSession = {
    _id: s._id,
    session_id: s.session_id,
    title: s.title,
    project_path: s.project_path,
    message_count: s.message_count,
    is_active: s.is_active,
    started_at: s.started_at,
    updated_at: s.updated_at,
    agent_type: s.agent_type,
  };
  const titled = !!(s.title && s.title.trim() && s.title.trim() !== row.label);
  return (
    <TaskSessionRow
      snapshot={titled ? snapshot : { ...snapshot, title: row.label }}
      now={now}
      onOpen={onOpen}
      tone={stepTone(row)}
      leading={<span className="mt-0.5 flex-shrink-0" data-step-status={row.status}><StepMark row={row} /></span>}
      badge={titled ? <NodeLabelChip label={row.label} /> : undefined}
      fallbackLine={runNodeLine(row)}
      meta={<StepMeta row={row} now={now} />}
    />
  );
}

function StepRow({ row, now }: { row: RunNodeRow; now: number }) {
  const TypeIcon = TYPE_ICONS[row.type] ?? Bot;
  const tone = stepTone(row);
  const line = runNodeLine(row);
  const href = row.session_id ? `/conversation/${row.session_id}` : null;
  const body = (
    <>
      <span className="mt-0.5 flex-shrink-0" data-step-status={row.status}><StepMark row={row} /></span>
      <TypeIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sol-text-dim/70" />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-xs leading-tight ${
          row.status === "failed" ? "text-sol-red" : row.status === "pending" && !row.current ? "text-sol-text-dim" : "text-sol-text"
        } ${row.current ? "font-medium" : ""}`}>
          {row.label}
        </div>
        {line && <p className="mt-0.5 text-[11px] text-sol-text-muted truncate leading-snug">{line}</p>}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sol-text-dim/70 min-w-0 empty:hidden">
          <StepMeta row={row} now={now} />
        </div>
      </div>
    </>
  );
  const cls = `flex items-start gap-2 px-2 py-1.5 rounded-md border-l-2 ${
    tone === "failed" ? "border-l-sol-red/40 bg-sol-red/[0.03]"
      : tone === "current" ? "border-l-sol-cyan/50 bg-sol-cyan/[0.04]"
        : "border-l-transparent"
  }`;
  return (
    <div data-step={row.id}>
      {href ? (
        <Link href={href} className={`${cls} transition-colors hover:bg-sol-bg-alt/70`} onClick={(e) => e.stopPropagation()}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </div>
  );
}

export function WorkflowRunNodes({ run, workflow, className }: { run: any; workflow?: any | null; className?: string }) {
  const now = useCoarseNow(30_000);
  const openLinkedSession = useOpenLinkedSession();
  const groups = runNodeGroups(run, workflow);
  if (groups.every((g) => g.rows.length === 0)) {
    return <div className="px-2 py-2 text-xs text-sol-text-dim">No steps</div>;
  }
  return (
    <div className={className ?? "space-y-2"} data-run-nodes={run?._id ?? ""}>
      {groups.map((g, i) => (
        <div key={g.title ?? `group-${i}`} className="space-y-0.5">
          {g.title && (
            <div className="flex items-center gap-1.5 px-2 pt-1" title={g.detail}>
              <span className="text-[9px] uppercase tracking-wider text-sol-cyan/70 font-semibold">{g.title}</span>
              <span className="text-[9px] text-sol-text-dim/60 tabular-nums">{g.rows.length}</span>
            </div>
          )}
          {g.rows.map((row) =>
            row.session
              ? <SessionNodeRow key={row.id} row={row} now={now} onOpen={openLinkedSession} />
              : <StepRow key={row.id} row={row} now={now} />,
          )}
        </div>
      ))}
    </div>
  );
}
