"use client";
// The scope page's Line tab (docs/architecture/the-line.md L3, L5, L10): one
// column per station in the team's status order, every task in scope as a
// card in the column of its status. A card shows the run's live node with the
// hand's state as its stripe, a held marker when a pending blocking decision
// is bound at the task's station, and an evidence count. Paints from the
// store: tasks, runs (useSyncRuns feeds workflow_runs.listRuns) and
// decisions; no query per card. The hold, run and node rules are the task
// page's (lib/taskLine.ts), so the board and the strip agree.
import { useMemo } from "react";
import { ShortId } from "../../ShortId";
import Link from "next/link";
import { Lock, Workflow } from "lucide-react";
import { classifySession, useTrackedStore, type SessionDecisionItem, type TaskItem } from "../../../store/inboxStore";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useSyncArtifacts } from "../../../hooks/useSyncArtifacts";
import { useSyncRuns, useWorkspaceRuns, type LineRun } from "../../../hooks/useSyncRuns";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { inScope, type ScopeIds } from "../../../hooks/useScopeIds";
import { statusVisual, useTeamTaskStatusList } from "../../../lib/taskStatuses";
import { resolveAssigneeInfo } from "../../../lib/liveEntities";
import { decisionHref } from "../../../lib/decisionLinks";
import { cn } from "../../../lib/utils";
import { AssigneeFace } from "../../identity/AssigneeFace";
import { useOrgRoles } from "../../../hooks/useOrgRoles";
import { ORG_STATE_META } from "../orgMeta";
import { handWorkState, heldDecisionFor, isLiveRun, runForTask, runLiveNode } from "../../../lib/taskLine";
import { evidenceCount, lineColumns } from "./lineBoard";

const heldDecisionSig = (d: SessionDecisionItem) => `${d.status}|${d.blocking ? 1 : 0}|${d.task_id ?? ""}|${d.station ?? ""}|${d.short_id ?? ""}|${d.created_at ?? 0}`;
const boundDecision = (d: SessionDecisionItem) => !!d.task_id && d.status === "pending" && !!d.blocking;
// Pages attached to a task (the-line.md L6): the artifacts store rows carry
// task_id, so the card's page count reads the store; the feeder is mounted
// once per board.
const boundPage = (a: { task_id?: string | null }) => !!a.task_id;
const pageSig = (a: { slug?: string; task_id?: string | null; version?: number }) => `${a.slug}|${a.task_id ?? ""}|${a.version ?? 0}`;

export function ScopeLineTab({ ids, teamId }: { ids: ScopeIds; teamId?: string }) {
  const phone = useIsPhone();
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  const statuses = useTeamTaskStatusList(teamId);
  // One feed for the whole board: the workspace's runs, which the cards look
  // up by task. The feeder overlays the shared runs collection (L8).
  useSyncRuns(useMemo(() => ({ limit: 200 }), []));
  const runs = useWorkspaceRuns();
  const held = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: boundDecision, sig: heldDecisionSig });
  useSyncArtifacts();
  const pages = useCollectionRows<{ slug?: string; task_id?: string | null; version?: number }>("artifacts", { where: boundPage, sig: pageSig });

  const inScopeTasks = useMemo(
    () => tasks.filter((t) => inScope(ids, t as any) && !(t as any).parent_id),
    [tasks, ids],
  );
  const columns = useMemo(() => lineColumns(inScopeTasks, statuses), [inScopeTasks, statuses]);

  if (inScopeTasks.length === 0) {
    return (
      <div className="py-14 text-center">
        <p className="text-[13px]" style={{ color: "var(--sol-text-muted)" }}>No tasks on the line.</p>
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Tasks in this scope show here by station; a run moves them along.</p>
      </div>
    );
  }

  return (
    <div className={cn("flex items-stretch gap-3 overflow-x-auto cq-no-scrollbar pb-3", phone ? "-mx-2 px-2" : "")} data-line-board style={{ scrollSnapType: phone ? "x mandatory" : undefined }}>
      {columns.map(({ status, tasks: colTasks }) => {
        const vis = statusVisual(status, statuses);
        const Icon = vis.icon;
        return (
          <section
            key={status.id}
            data-line-column={status.id}
            className={cn("shrink-0 flex flex-col rounded-xl border", phone ? "w-[78vw]" : "w-[224px]")}
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 24%, transparent)", background: "color-mix(in srgb, var(--sol-card) 60%, transparent)", scrollSnapAlign: phone ? "start" : undefined }}
          >
            <header className="flex items-center gap-1.5 px-2.5 h-9 border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 20%, transparent)" }}>
              <Icon className={cn("w-3.5 h-3.5 shrink-0", vis.color)} />
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] truncate" style={{ color: "var(--sol-text-muted)" }}>{status.name}</span>
              <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{colTasks.length}</span>
            </header>
            <div className="flex-1 min-h-[96px] p-1.5 space-y-1.5">
              {colTasks.length === 0 ? (
                <p className="px-1.5 py-3 text-[11px] italic" style={{ color: "var(--sol-text-dim)" }}>Nothing at this station.</p>
              ) : colTasks.map((t) => (
                <LineCard
                  key={t._id}
                  task={t}
                  run={runForTask(t, runs) ?? null}
                  held={heldDecisionFor(t, held) ?? null}
                  evidence={evidenceCount(t, pages)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LineCard({ task, run, held, evidence }: { task: TaskItem; run: LineRun | null; held: SessionDecisionItem | null; evidence: { pages: number; files: number } }) {
  const handId = run?.primary_conversation_id;
  // The hand's state as one scalar, never its row: a heartbeat cannot
  // re-render the card, a state change does. Assignee names come from the
  // live roster (lib/liveEntities), not the server snapshot.
  const { roles: orgRoles } = useOrgRoles();
  const s = useTrackedStore([
    (st) => { const row = handId ? st.sessions[handId] : undefined; return row ? handWorkState(classifySession(row), null) : null; },
    (st) => st.teamMembers,
    (st) => st.currentUser?._id,
  ]);
  const handRow = handId ? s.sessions[handId] : undefined;
  const live = isLiveRun(run) ? runLiveNode(run) : null;
  const node = live?.label ?? null;
  // The stripe follows the store row when we hold the hand's session, else
  // the run's own enrichment; a run waiting at a gate with no hand says so.
  const handState = live && (handRow || live.session) ? handWorkState(handRow ? classifySession(handRow) : null, live.session) : null;
  const handMeta = handState ? ORG_STATE_META[handState] : null;
  const assignee = resolveAssigneeInfo(task.assignee, task.assignee_info, s.teamMembers, s.currentUser, orgRoles);
  const evidenceLine = [evidence.pages ? `${evidence.pages} page${evidence.pages === 1 ? "" : "s"}` : "", evidence.files ? `${evidence.files} file${evidence.files === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");

  return (
    <div data-line-card={task.short_id} className="relative rounded-lg border transition-colors hover:bg-sol-bg-highlight/60" style={{ borderColor: held ? "color-mix(in srgb, var(--sol-yellow) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 32%, transparent)", background: "var(--sol-card)" }}>
      <Link href={`/tasks/${task.short_id}`} className="block px-2.5 pt-2 pb-2">
        <span className="block text-[12.5px] font-medium leading-snug line-clamp-2" style={{ color: "var(--sol-text)" }}>{task.title}</span>
        <span className="mt-1 flex items-center gap-1.5 text-[10.5px] min-w-0" style={{ color: "var(--sol-text-dim)" }}>
          <ShortId id={task.short_id} />
          {assignee && (
            <span className="inline-flex items-center gap-1 min-w-0 truncate" title={assignee.name}>
              <AssigneeFace info={assignee} size={16} />
              <span className="truncate">{assignee.name}</span>
            </span>
          )}
          {evidenceLine && <span className="ml-auto shrink-0 tabular-nums">{evidenceLine}</span>}
        </span>
        {node && (
          <span data-line-node className="mt-1.5 flex items-center gap-1.5 text-[11px] min-w-0 pl-1.5" style={{ borderLeft: `3px solid ${handMeta?.color ?? "color-mix(in srgb, var(--sol-border) 60%, transparent)"}`, color: "var(--sol-text-muted)" }}>
            <Workflow className="w-3 h-3 shrink-0" style={{ color: "var(--sol-green)" }} />
            <span className="truncate">{node}</span>
            {handMeta && <span className="shrink-0 text-[10px]" style={{ color: handMeta.color }}>{handMeta.label}</span>}
            {run?.status === "paused" && !handMeta && <span className="shrink-0 text-[10px]" style={{ color: "var(--sol-yellow)" }}>paused</span>}
          </span>
        )}
      </Link>
      {held && (
        <Link
          href={decisionHref(held)}
          data-line-held
          className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium"
          style={{ background: "color-mix(in srgb, var(--sol-yellow) 16%, transparent)", color: "var(--sol-yellow)" }}
          title={`Held here by ${held.short_id ?? "a decision"}: ${held.question ?? ""}`}
        >
          <Lock className="w-2.5 h-2.5" /> held{held.short_id ? ` · ${held.short_id}` : ""}
        </Link>
      )}
    </div>
  );
}
