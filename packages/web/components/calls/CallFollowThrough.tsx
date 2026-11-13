"use client";

// The calls page with no call open: what each recent call asked for and what
// came of it. One row per ask (a task pulled from the call, or a summary
// action item nobody filed), showing who holds it, the sessions working it,
// the decision card waiting on it, and its stage. The stage totals at the top
// filter the board, so "what did nobody pick up" is one press.

import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { callPathRef, isRecRoomKey } from "@codecast/shared/contracts";
import { EntityIdPill } from "../EntityIdPill";
import { AuthorAvatar } from "../entityDisplay";
import { relativeTime } from "../../lib/entityDisplay";
import { taskFacePath } from "../../lib/workUnit";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useInboxStore, useMyUserId } from "../../store/inboxStore";
import { callTitle } from "../../lib/calls/roomLabels";
import { fmtClock } from "../triggerCadence";
import type { WorkspaceKey } from "../../lib/workspaceScope";
import { buildFollowThrough, FOLLOW_STAGES, type FollowCall, type FollowItem, type FollowStage } from "../../lib/calls/followThrough";
import { firstName } from "./speakers";
import { makeCallTask, useOpenTask } from "./CallTasks";

const WINDOW_MS = 14 * 24 * 3600_000;

const STAGE: Record<FollowStage, { label: string; color: string }> = {
  unfiled: { label: "No task", color: "var(--sol-red)" },
  guessed: { label: "Likely filed", color: "var(--sol-orange)" },
  filed: { label: "Not picked up", color: "var(--sol-yellow)" },
  working: { label: "Working", color: "var(--sol-blue)" },
  deciding: { label: "Needs decision", color: "var(--sol-magenta)" },
  review: { label: "In review", color: "var(--sol-cyan)" },
  done: { label: "Done", color: "var(--sol-green)" },
  dropped: { label: "Dropped", color: "var(--sol-text-dim)" },
};

const taskSig = (t: any) =>
  `${t.from_call ?? ""}|${t.status}|${t.title}|${t.assignee ?? ""}|${(t.conversation_ids ?? []).length}|${t.updated_at ?? ""}`;
const hasTask = (d: any) => !!d.task_id;
const decisionSig = (d: any) => `${d.task_id}|${d.status}|${d.short_id ?? ""}`;
const titleSig = (d: any) => d.title ?? "";

function StageMark({ stage }: { stage: FollowStage }) {
  const s = STAGE[stage];
  return (
    <span className="inline-flex w-[112px] shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px]" style={{ color: s.color }}>
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

/** The call's asks as one bar, a segment per stage. */
function StageBar({ counts, total }: { counts: Record<FollowStage, number>; total: number }) {
  if (total === 0) return null;
  return (
    <span className="flex h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-sol-bg-alt" aria-hidden="true">
      {[...FOLLOW_STAGES, "dropped" as const].map((s) =>
        counts[s] ? <span key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: STAGE[s].color }} /> : null,
      )}
    </span>
  );
}

function ItemRow({ item, call }: { item: FollowItem; call: any }) {
  const openTask = useOpenTask();
  const t = item.task;
  const open = (e: MouseEvent) => openTask(e, t);
  const owner = t?.assignee_info;
  const extra = item.sessions.length - 2;
  return (
    <li className={`flex min-h-[34px] items-center gap-3 px-4 py-1 hover:bg-sol-bg-alt/40 ${item.stage === "dropped" ? "opacity-50" : ""}`}>
      <StageMark stage={item.stage} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {t ? (
          <a href={taskFacePath(t)} onClick={open} className="flex min-w-0 items-center gap-2 text-[12.5px] text-sol-text hover:underline">
            <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{t.short_id}</span>
            <span className="truncate">{t.title}</span>
          </a>
        ) : (
          <>
            <span className="truncate text-[12.5px] text-sol-text-muted">{item.title}</span>
            {item.guess && (
              <a
                href={taskFacePath(item.guess)}
                onClick={(e) => openTask(e, item.guess)}
                title={`Reads like ${item.guess.short_id}: ${item.guess.title}`}
                className="shrink-0 font-mono text-[10.5px] text-sol-orange hover:underline"
              >
                {item.guess.short_id}?
              </a>
            )}
          </>
        )}
      </span>
      <span className="flex w-[92px] shrink-0 items-center gap-1 truncate text-[11px] text-sol-text-muted">
        {owner ? (
          <>
            <AuthorAvatar name={owner.name} avatar={owner.image} size={14} />
            <span className="truncate">{firstName(owner.name ?? "")}</span>
          </>
        ) : item.askedOf ? (
          <span className="truncate text-sol-text-dim" title={`Asked of ${item.askedOf}, nobody holds it`}>{firstName(item.askedOf)}</span>
        ) : (
          <span className="text-sol-text-dim">nobody</span>
        )}
      </span>
      <span className="flex max-w-[220px] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] [&_.entity-ref]:max-w-[120px] [&_.entity-ref]:truncate">
        {item.sessions.slice(0, 2).map((id) => (
          <EntityIdPill key={id} shortId={id.slice(0, 7)} compact />
        ))}
        {extra > 0 && <span className="text-[10.5px] text-sol-text-dim">+{extra}</span>}
        {item.decisions[0]?.short_id && <EntityIdPill shortId={item.decisions[0].short_id} compact />}
      </span>
      {item.raw ? (
        <button
          type="button"
          onClick={() => makeCallTask(call, item.raw!)}
          title={item.guess ? `File this ask as its own task, apart from ${item.guess.short_id}` : "File this ask as a task on the call"}
          className="flex w-[84px] shrink-0 items-center justify-end gap-1 text-[11px] text-sol-text-dim hover:text-sol-text"
        >
          <Plus className="h-3 w-3" /> Make task
        </button>
      ) : (
        <span className="w-[84px] shrink-0 text-right text-[10.5px] tabular-nums text-sol-text-dim">
          {t ? relativeTime(t.updated_at) : ""}
        </span>
      )}
    </li>
  );
}

function CallBlock({ fc, filter }: { fc: FollowCall; filter: FollowStage | null }) {
  const { call, counts } = fc;
  const items = filter ? fc.items.filter((i) => i.stage === filter) : fc.items;
  const title = useInboxStore((s) => callTitle(call, s as any));
  const people = (call.participants ?? []).map((p: any) => firstName(p.name)).join(", ");
  return (
    <section className="border-b border-sol-border/20">
      <header className="flex items-center gap-3 px-4 pb-1.5 pt-3">
        <Link href={`/calls/${callPathRef(call)}`} className="min-w-0 truncate text-[13px] font-medium text-sol-text hover:underline">
          {title}
        </Link>
        <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{call.short_id}</span>
        <span className="shrink-0 text-[11px] text-sol-text-dim">{fmtClock(call.started_at)}</span>
        <span className="min-w-0 truncate text-[11px] text-sol-text-dim">{people}</span>
        <span className="flex-1" />
        {call.summary_status === "failed" && (
          <span className="shrink-0 rounded bg-sol-red/10 px-1.5 py-0.5 text-[10.5px] text-sol-red">no summary</span>
        )}
        {fc.sweepDocs.length > 0 && <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px]">{fc.sweepDocs.map((d) => (
          <EntityIdPill key={d._id} type="doc" id={String(d._id)} compact fallback={<FileText className="h-3 w-3" />} />
        ))}</span>}
        <span className="shrink-0 text-[11px] tabular-nums text-sol-text-muted">
          {counts.done}/{fc.items.length - counts.dropped}
        </span>
        <StageBar counts={counts} total={fc.items.length} />
      </header>
      {items.length === 0 ? (
        <p className="px-4 pb-3 text-[11.5px] text-sol-text-dim">{fc.items.length === 0 ? "Nothing filed from this call." : null}</p>
      ) : (
        <ul className="pb-2">
          {items.map((it) => (
            <ItemRow key={it.key} item={it} call={call} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CallFollowThrough({ calls, fallback }: { calls: any[]; fallback: ReactNode }) {
  const workspace = useActiveWorkspaceKey();
  const me = useMyUserId();
  const tasks = useWorkspaceCollection<any>("tasks", taskSig, workspace);
  const teamDocs = useWorkspaceCollection<any>("docs", titleSig, workspace);
  const myDocs = useWorkspaceCollection<any>("docs", titleSig, (me ? `user:${me}` : null) as WorkspaceKey | null);
  const decisions = useCollectionRows<any>("sessionDecisions", { where: hasTask, sig: decisionSig });
  const [filter, setFilter] = useState<FollowStage | null>(null);

  const board = useMemo(() => {
    const since = Date.now() - WINDOW_MS;
    const recent = calls.filter(
      (c) => c.status !== "live" && !isRecRoomKey(c.room_key) && (c.started_at ?? 0) >= since && `team:${c.team_id}` === workspace,
    );
    return buildFollowThrough(recent, tasks, decisions, [...teamDocs, ...myDocs]);
  }, [calls, tasks, decisions, teamDocs, myDocs, workspace]);

  const totals = useMemo(() => {
    const out = Object.fromEntries(FOLLOW_STAGES.map((s) => [s, 0])) as Record<FollowStage, number>;
    for (const fc of board) for (const s of FOLLOW_STAGES) out[s] += fc.counts[s];
    return out;
  }, [board]);
  const shown = filter ? board.filter((fc) => fc.counts[filter] > 0) : board;
  if (board.length === 0) return <>{fallback}</>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-2 border-b border-sol-border/20 px-4 py-3">
        <h2 className="mr-3 text-sm font-medium text-sol-text">What came of each call</h2>
        <span className="mr-3 text-[11px] text-sol-text-dim">{board.length} calls, last 14 days</span>
        {FOLLOW_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            disabled={totals[s] === 0}
            onClick={() => setFilter(filter === s ? null : s)}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors disabled:opacity-40 ${
              filter === s ? "border-current" : "border-sol-border/30 hover:bg-sol-bg-alt"
            }`}
            style={{ color: filter === s || totals[s] > 0 ? STAGE[s].color : undefined }}
          >
            <span className="text-[13px] font-semibold tabular-nums">{totals[s]}</span>
            <span className={filter === s ? "" : "text-sol-text-muted"}>{STAGE[s].label}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((fc) => (
          <CallBlock key={fc.call._id} fc={fc} filter={filter} />
        ))}
      </div>
    </div>
  );
}
