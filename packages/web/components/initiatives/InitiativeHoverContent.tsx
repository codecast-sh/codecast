"use client";
// What an `in-N` pill shows on hover
// (docs/architecture/initiatives-projects-role-page.md I1 "Everywhere else"):
// enough to answer how it is going and who drives it without opening it.
import { Flag } from "lucide-react";
import { INITIATIVE_STATUS_LABEL, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useBoardTasks, useTasksBackfilled } from "../../hooks/useInitiatives";
import { initiativeProgress } from "../../lib/initiatives";
import { HealthChip, INITIATIVE_ACCENT, OwnerChip, ProgressBar, TargetDate } from "./InitiativeAtoms";

export function InitiativeHoverContent({ initiative }: { initiative: InitiativeRow }) {
  const now = useCoarseNow(60_000);
  const progress = initiativeProgress(initiative, useBoardTasks());
  const counted = useTasksBackfilled();
  const projects = initiative.project_ids.length;
  return (
    <div className="space-y-2" data-initiative-hover={initiative.short_id}>
      <div className="flex items-start gap-2">
        <Flag className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: INITIATIVE_ACCENT }} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{initiative.title}</div>
          <span className="text-[10px] font-medium text-sol-text-dim">
            Initiative · {INITIATIVE_STATUS_LABEL[initiative.status]}{initiative.short_id ? ` · ${initiative.short_id}` : ""}
          </span>
        </div>
      </div>
      <div className="pl-[22px] flex items-center gap-x-3 gap-y-1 flex-wrap">
        <OwnerChip owner={initiative.owner} size={14} />
        <HealthChip health={initiative.health} at={initiative.health_at} now={now} />
        <TargetDate ts={initiative.target_date} now={now} done={initiative.status === "completed" || initiative.status === "cancelled"} />
      </div>
      <div className="pl-[22px] flex items-center gap-2">
        <ProgressBar progress={progress} partial={!counted} className="flex-1" />
        <span className="shrink-0 text-[10px] text-sol-text-dim">{projects} {projects === 1 ? "project" : "projects"}</span>
      </div>
    </div>
  );
}
