"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useWorkspaceArgs } from "../hooks/useWorkspaceArgs";
import { TaskStatusBadge } from "./TaskStatusBadge";
import {
  Target,
  Zap,
  ExternalLink,
  CircleDot,
  CheckCircle2,
  Circle,
  AlertTriangle,
} from "lucide-react";

const api = _api as any;

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function ProgressBar({ progress }: { progress?: { total: number; done: number; in_progress: number; open?: number } }) {
  if (!progress || progress.total === 0) return null;
  const donePct = (progress.done / progress.total) * 100;
  const ipPct = (progress.in_progress / progress.total) * 100;

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-sol-border/20 rounded-full overflow-hidden">
        <div className="h-full flex">
          <div className="bg-sol-green transition-all" style={{ width: `${donePct}%` }} />
          <div className="bg-sol-yellow transition-all" style={{ width: `${ipPct}%` }} />
        </div>
      </div>
      <span className="text-[10px] text-sol-text-dim tabular-nums whitespace-nowrap">
        {progress.done}/{progress.total}
      </span>
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: number; color: string; sub?: string }) {
  return (
    <div className="px-3 py-2.5 rounded-lg bg-sol-bg-alt/30 border border-sol-border/15">
      <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-0.5">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-xl font-semibold tabular-nums ${color}`}>{value}</span>
        {sub && <span className="text-[10px] text-sol-text-dim">{sub}</span>}
      </div>
    </div>
  );
}

function PlanCard({ plan }: { plan: any }) {
  const isActive = plan.status === "active";
  const progress = plan.progress;
  const hasProgress = progress && progress.total > 0;

  return (
    <Link
      href={`/plans?plan=${plan.short_id}`}
      className={`block p-3 rounded-lg border transition-colors hover:bg-sol-bg-alt/40 ${
        isActive ? "border-sol-cyan/20 bg-sol-cyan/3" : "border-sol-border/15 bg-sol-bg-alt/10"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <CircleDot className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-sol-cyan" : "text-sol-text-dim"}`} />
        <span className="text-sm text-sol-text font-medium truncate">{plan.title}</span>
        <span className="text-[10px] font-mono text-sol-text-dim ml-auto flex-shrink-0">{plan.short_id}</span>
      </div>

      {hasProgress && <ProgressBar progress={progress} />}

      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-sol-text-dim">
        {hasProgress && (
          <>
            <span className="flex items-center gap-0.5">
              <CheckCircle2 className="w-2.5 h-2.5 text-sol-green" />
              {progress.done}
            </span>
            <span className="flex items-center gap-0.5">
              <CircleDot className="w-2.5 h-2.5 text-sol-yellow" />
              {progress.in_progress}
            </span>
            <span className="flex items-center gap-0.5">
              <Circle className="w-2.5 h-2.5 text-sol-blue" />
              {progress.open}
            </span>
          </>
        )}
        <span className="ml-auto tabular-nums">{timeAgo(plan.updated_at)}</span>
      </div>
    </Link>
  );
}

function ActiveAgentCard({ task }: { task: any }) {
  return (
    <Link
      href={`/conversation/${task.activeSession.session_id}`}
      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/8 border border-emerald-500/20 hover:bg-emerald-500/15 transition-colors group"
    >
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
      <span className="text-xs font-mono text-sol-text-dim flex-shrink-0">{task.short_id}</span>
      <span className="text-xs text-emerald-300/80 truncate group-hover:text-emerald-200 transition-colors">
        {task.title}
      </span>
      <ExternalLink className="w-2.5 h-2.5 text-emerald-400/40 group-hover:text-emerald-400/80 ml-auto flex-shrink-0 transition-colors" />
    </Link>
  );
}

interface OrchestrationDashboardProps {
  className?: string;
}

export function OrchestrationDashboard({ className }: OrchestrationDashboardProps) {
  const workspaceArgs = useWorkspaceArgs();
  const plans = useQuery(
    api.plans.webList,
    workspaceArgs === "skip" ? "skip" : { ...workspaceArgs, include_all: true }
  );

  const activePlanIds = useMemo(() => {
    if (!plans) return [];
    return plans
      .filter((p: any) => p.status === "active")
      .slice(0, 5)
      .map((p: any) => p.short_id);
  }, [plans]);

  const plan0 = useQuery(api.plans.webGet, activePlanIds[0] ? { short_id: activePlanIds[0] } : "skip");
  const plan1 = useQuery(api.plans.webGet, activePlanIds[1] ? { short_id: activePlanIds[1] } : "skip");
  const plan2 = useQuery(api.plans.webGet, activePlanIds[2] ? { short_id: activePlanIds[2] } : "skip");
  const plan3 = useQuery(api.plans.webGet, activePlanIds[3] ? { short_id: activePlanIds[3] } : "skip");
  const plan4 = useQuery(api.plans.webGet, activePlanIds[4] ? { short_id: activePlanIds[4] } : "skip");

  const enrichedPlans = useMemo(() => {
    return [plan0, plan1, plan2, plan3, plan4].filter(Boolean);
  }, [plan0, plan1, plan2, plan3, plan4]);

  const stats = useMemo(() => {
    if (!plans) return null;
    const activePlans = plans.filter((p: any) => p.status === "active");

    let totalTasks = 0;
    let doneTasks = 0;
    let inProgressTasks = 0;
    let openTasks = 0;

    for (const p of activePlans) {
      if (p.progress) {
        totalTasks += p.progress.total || 0;
        doneTasks += p.progress.done || 0;
        inProgressTasks += p.progress.in_progress || 0;
        openTasks += p.progress.open || 0;
      }
    }

    const activeAgents: any[] = [];
    const blockedTasks: any[] = [];
    for (const ep of enrichedPlans) {
      if (!ep?.tasks) continue;
      for (const t of ep.tasks) {
        if (t.activeSession) activeAgents.push(t);
        if (t.execution_status === "blocked" || t.execution_status === "needs_context") blockedTasks.push(t);
      }
    }

    return {
      activePlanCount: activePlans.length,
      totalPlans: plans.length,
      totalTasks,
      doneTasks,
      inProgressTasks,
      openTasks,
      activeAgents,
      blockedTasks,
    };
  }, [plans, enrichedPlans]);

  if (plans === undefined) {
    return (
      <div className={`flex items-center justify-center h-48 text-sol-text-dim ${className || ""}`}>
        <span className="text-sm">Loading orchestration data...</span>
      </div>
    );
  }

  if (!stats) return null;

  const activePlans = plans.filter((p: any) => p.status === "active");
  const hasActiveWork = stats.activeAgents.length > 0;

  return (
    <div className={className}>
      <div className={`rounded-lg border overflow-hidden mb-6 ${
        hasActiveWork ? "border-emerald-500/30 bg-emerald-950/8" : "border-sol-border/20 bg-sol-bg-alt/15"
      }`}>
        <div className="px-4 py-3 flex items-center gap-2 border-b border-sol-border/10">
          <Zap className={`w-4 h-4 ${hasActiveWork ? "text-emerald-400" : "text-sol-text-dim"}`} />
          <span className={`text-xs font-semibold uppercase tracking-wider ${hasActiveWork ? "text-emerald-400" : "text-sol-text-dim"}`}>
            Orchestration Overview
          </span>
          {hasActiveWork && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
        </div>

        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Active Plans" value={stats.activePlanCount} color="text-sol-cyan" sub={`of ${stats.totalPlans}`} />
          <StatCard label="Tasks Done" value={stats.doneTasks} color="text-sol-green" sub={`of ${stats.totalTasks}`} />
          <StatCard label="In Progress" value={stats.inProgressTasks} color="text-sol-yellow" />
          <StatCard
            label="Issues"
            value={stats.blockedTasks.length}
            color={stats.blockedTasks.length > 0 ? "text-sol-red" : "text-sol-text-dim"}
            sub={stats.blockedTasks.length > 0 ? "blocked" : ""}
          />
        </div>
      </div>

      {stats.activeAgents.length > 0 && (
        <div className="mb-6">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-sol-text-dim uppercase tracking-wider mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Active Agents ({stats.activeAgents.length})
          </h3>
          <div className="grid gap-2">
            {stats.activeAgents.map((t: any) => (
              <ActiveAgentCard key={t._id} task={t} />
            ))}
          </div>
        </div>
      )}

      {stats.blockedTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-sol-red uppercase tracking-wider mb-2">
            <AlertTriangle className="w-3 h-3" />
            Blocked ({stats.blockedTasks.length})
          </h3>
          <div className="space-y-1.5">
            {stats.blockedTasks.map((t: any) => (
              <div key={t._id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sol-red/5 border border-sol-red/15">
                <TaskStatusBadge status={t.execution_status} type="execution" />
                <span className="text-xs font-mono text-sol-text-dim">{t.short_id}</span>
                <span className="text-xs text-sol-text truncate">{t.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="flex items-center gap-2 text-xs font-semibold text-sol-text-dim uppercase tracking-wider mb-2">
          <Target className="w-3 h-3" />
          Active Plans ({activePlans.length})
        </h3>
        {activePlans.length === 0 ? (
          <div className="text-center py-8 text-sol-text-dim text-sm">
            No active plans
          </div>
        ) : (
          <div className="grid gap-2">
            {activePlans.map((p: any) => (
              <PlanCard key={p._id} plan={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
