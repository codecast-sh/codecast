"use client";

// The status of one session in a migration batch, shared by Settings →
// Migration and the resource monitor's offload runs.
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { ROW_STATUS_LABEL, isRowActive, type MigrationRowStatus } from "../lib/migrationPlan";

const STATUS_TONE: Record<MigrationRowStatus, string> = {
  queued: "bg-sol-bg-highlight/60 text-sol-text-muted",
  waiting_idle: "bg-sol-yellow/15 text-sol-yellow",
  quiescing: "bg-sol-orange/15 text-sol-orange",
  transferring: "bg-sol-blue/15 text-sol-blue",
  switching: "bg-sol-violet/15 text-sol-violet",
  resuming: "bg-sol-cyan/15 text-sol-cyan",
  done: "bg-sol-green/15 text-sol-green",
  failed: "bg-sol-red/15 text-sol-red",
  cancelled: "bg-sol-bg-highlight/60 text-sol-text-dim",
};

export function MigrationStatusPill({ status }: { status: MigrationRowStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium whitespace-nowrap", STATUS_TONE[status])}>
      {isRowActive(status) && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {status === "done" && <Check className="h-2.5 w-2.5" />}
      {status === "failed" && <AlertTriangle className="h-2.5 w-2.5" />}
      {ROW_STATUS_LABEL[status]}
    </span>
  );
}
