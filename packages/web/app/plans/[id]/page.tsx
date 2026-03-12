"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { Badge } from "../../../components/ui/badge";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  PauseCircle,
  XCircle,
  Target,
  ListChecks,
  MessageSquare,
  ArrowLeft,
  Clock,
  Lightbulb,
  GitBranch,
  ExternalLink,
} from "lucide-react";

const api = _api as any;

const STATUS_CONFIG: Record<string, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim" },
};

const TASK_STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string }> = {
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  dropped: { icon: XCircle, color: "text-sol-text-dim" },
  draft: { icon: Circle, color: "text-sol-text-dim" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function PlanDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const plan = useQuery(api.plans.webGet, id ? { id: id as any } : "skip");

  if (!plan) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="flex items-center justify-center h-48 text-sol-text-dim">
            <span className="text-sm">{plan === null ? "Plan not found" : "Loading..."}</span>
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  const status = STATUS_CONFIG[plan.status] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6">
            {/* Back link */}
            <Link href="/plans" className="inline-flex items-center gap-1.5 text-xs text-sol-text-dim hover:text-sol-text mb-4 transition-colors">
              <ArrowLeft className="w-3 h-3" />
              Plans
            </Link>

            {/* Header */}
            <div className="mb-6">
              <div className="flex items-center gap-2.5 mb-2">
                <StatusIcon className={`w-5 h-5 ${status.color}`} />
                <h1 className="text-xl font-semibold text-sol-text">{plan.title}</h1>
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${status.color} border-current/30`}>
                  {status.label}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-sol-text-dim">
                <span className="font-mono">{plan.short_id}</span>
                <span>Created {formatTimestamp(plan.created_at)}</span>
                <span>Updated {formatTimestamp(plan.updated_at)}</span>
              </div>
              {plan.goal && (
                <p className="mt-3 text-sm text-sol-text-muted leading-relaxed">{plan.goal}</p>
              )}
              {plan.acceptance_criteria?.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-1">Acceptance Criteria</h3>
                  <ul className="text-sm text-sol-text-muted space-y-0.5">
                    {plan.acceptance_criteria.map((c: string, i: number) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-sol-text-dim mt-0.5">-</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Progress */}
            {plan.progress && plan.progress.total > 0 && (
              <div className="mb-6 p-3 bg-sol-bg-alt/30 rounded-lg border border-sol-border/20">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-sol-border/30 rounded-full overflow-hidden">
                    <div className="h-full flex">
                      <div className="bg-sol-green transition-all" style={{ width: `${(plan.progress.done / plan.progress.total) * 100}%` }} />
                      <div className="bg-sol-yellow transition-all" style={{ width: `${(plan.progress.in_progress / plan.progress.total) * 100}%` }} />
                    </div>
                  </div>
                  <span className="text-xs text-sol-text-dim tabular-nums whitespace-nowrap">
                    {plan.progress.done} done, {plan.progress.in_progress} in progress, {plan.progress.open} open
                  </span>
                </div>
              </div>
            )}

            {/* Tasks */}
            {plan.tasks?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <ListChecks className="w-4 h-4 text-sol-text-dim" />
                  Tasks ({plan.tasks.length})
                </h2>
                <div className="border border-sol-border/20 rounded-lg overflow-hidden">
                  {plan.tasks.map((task: any) => {
                    const tc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
                    const TaskIcon = tc.icon;
                    return (
                      <Link
                        key={task._id}
                        href={`/tasks/${task._id}`}
                        className="flex items-center gap-2.5 px-3 py-2.5 hover:bg-sol-bg-alt/40 transition-colors border-b border-sol-border/10 last:border-b-0"
                      >
                        <TaskIcon className={`w-3.5 h-3.5 ${tc.color} flex-shrink-0`} />
                        <span className="text-xs font-mono text-sol-text-dim">{task.short_id}</span>
                        <span className="text-sm text-sol-text truncate">{task.title}</span>
                        <span className="text-[10px] text-sol-text-dim ml-auto">{task.status}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sessions */}
            {plan.session_ids?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <MessageSquare className="w-4 h-4 text-sol-text-dim" />
                  Sessions ({plan.session_ids.length})
                </h2>
                <p className="text-xs text-sol-text-dim">
                  {plan.session_ids.length} session{plan.session_ids.length !== 1 ? "s" : ""} linked to this plan
                </p>
              </div>
            )}

            {/* Progress Log */}
            {plan.progress_log?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <Clock className="w-4 h-4 text-sol-text-dim" />
                  Progress Log
                </h2>
                <div className="space-y-2">
                  {[...plan.progress_log].reverse().map((entry: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <span className="text-[11px] text-sol-text-dim tabular-nums whitespace-nowrap mt-0.5">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <span className="text-sol-text-muted">{entry.entry}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Decision Log */}
            {plan.decision_log?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <GitBranch className="w-4 h-4 text-sol-text-dim" />
                  Decisions
                </h2>
                <div className="space-y-3">
                  {plan.decision_log.map((d: any, i: number) => (
                    <div key={i} className="text-sm">
                      <span className="text-sol-text">{d.decision}</span>
                      {d.rationale && (
                        <p className="text-xs text-sol-text-dim mt-0.5">{d.rationale}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Discoveries */}
            {plan.discoveries?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <Lightbulb className="w-4 h-4 text-sol-text-dim" />
                  Discoveries
                </h2>
                <div className="space-y-1.5">
                  {plan.discoveries.map((d: any, i: number) => (
                    <p key={i} className="text-sm text-sol-text-muted">{d.finding}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Context Pointers */}
            {plan.context_pointers?.length > 0 && (
              <div className="mb-6">
                <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
                  <ExternalLink className="w-4 h-4 text-sol-text-dim" />
                  Context
                </h2>
                <div className="space-y-1">
                  {plan.context_pointers.map((cp: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="text-sol-text-dim">{cp.label}:</span>
                      <span className="text-sol-text-muted font-mono text-xs">{cp.path_or_url}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
