"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  PauseCircle,
  XCircle,
  Target,
  ListChecks,
  MessageSquare,
  Plus,
} from "lucide-react";

const api = _api as any;

type PlanStatus = "draft" | "active" | "paused" | "done" | "abandoned";

const STATUS_CONFIG: Record<PlanStatus, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim" },
};

function ProgressBar({ progress }: { progress?: { total: number; done: number; in_progress: number; open: number } }) {
  if (!progress || progress.total === 0) return null;
  const donePct = (progress.done / progress.total) * 100;
  const ipPct = (progress.in_progress / progress.total) * 100;

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 bg-sol-border/30 rounded-full overflow-hidden">
        <div className="h-full flex">
          <div className="bg-sol-green transition-all" style={{ width: `${donePct}%` }} />
          <div className="bg-sol-yellow transition-all" style={{ width: `${ipPct}%` }} />
        </div>
      </div>
      <span className="text-[11px] text-sol-text-dim tabular-nums">
        {progress.done}/{progress.total}
      </span>
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function PlanCard({ plan }: { plan: any }) {
  const status = STATUS_CONFIG[plan.status as PlanStatus] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;
  const taskCount = plan.task_ids?.length || 0;
  const sessionCount = plan.session_ids?.length || 0;

  return (
    <Link
      href={`/plans/${plan._id}`}
      className="block group"
    >
      <div className="px-5 py-4 hover:bg-sol-bg-alt/40 transition-colors border-b border-sol-border/20">
        <div className="flex items-start gap-3">
          <StatusIcon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${status.color}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-sm font-medium text-sol-text group-hover:text-sol-cyan transition-colors truncate">
                {plan.title}
              </span>
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${status.color} border-current/30 flex-shrink-0`}>
                {status.label}
              </Badge>
              <span className="text-[10px] text-sol-text-dim font-mono">{plan.short_id}</span>
            </div>
            {plan.goal && (
              <p className="text-xs text-sol-text-muted/80 leading-relaxed line-clamp-1 mt-0.5">
                {plan.goal}
              </p>
            )}
            <div className="flex items-center gap-4 mt-2">
              <ProgressBar progress={plan.progress} />
              {taskCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim">
                  <ListChecks className="w-3 h-3" />
                  {taskCount}
                </span>
              )}
              {sessionCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim">
                  <MessageSquare className="w-3 h-3" />
                  {sessionCount}
                </span>
              )}
              <span className="text-[11px] text-sol-text-dim tabular-nums ml-auto">
                {timeAgo(plan.updated_at)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function CreatePlanForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const createPlan = useMutation(api.plans.webCreate);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const result = await createPlan({
        title: title.trim(),
        goal: goal.trim() || undefined,
        status: "active",
      });
      toast.success("Plan created");
      onClose();
      if (result?.id) {
        router.push(`/plans/${result.id}`);
      }
    } catch {
      toast.error("Failed to create plan");
      setSubmitting(false);
    }
  }, [title, goal, submitting, createPlan, router, onClose]);

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/30 px-5 py-4">
      <div className="space-y-3">
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) handleSubmit(); if (e.key === "Escape") onClose(); }}
          placeholder="Plan title..."
          className="w-full text-sm px-3 py-2 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
        />
        <textarea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && e.metaKey) handleSubmit(); if (e.key === "Escape") onClose(); }}
          placeholder="Goal (optional)..."
          rows={2}
          className="w-full text-sm px-3 py-2 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan resize-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="px-4 py-1.5 text-xs rounded-lg bg-sol-cyan text-sol-bg font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {submitting ? "Creating..." : "Create Plan"}
          </button>
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
            Cancel
          </button>
          <span className="text-[10px] text-sol-text-dim ml-auto">Enter to create, Esc to cancel</span>
        </div>
      </div>
    </div>
  );
}

export default function PlansPage() {
  const plans = useQuery(api.plans.webList, {});
  const [showCreate, setShowCreate] = useState(false);

  const activePlans = plans?.filter((p: any) => p.status === "active") || [];
  const draftPlans = plans?.filter((p: any) => p.status === "draft") || [];
  const pausedPlans = plans?.filter((p: any) => p.status === "paused") || [];
  const donePlans = plans?.filter((p: any) => p.status === "done") || [];

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full flex flex-col">
          <div className="px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Target className="w-5 h-5 text-sol-cyan" />
                <h1 className="text-lg font-semibold text-sol-text tracking-tight">Plans</h1>
              </div>
              <button
                onClick={() => setShowCreate(!showCreate)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New Plan
              </button>
            </div>
          </div>

          {showCreate && <CreatePlanForm onClose={() => setShowCreate(false)} />}

          <div className="flex-1 overflow-y-auto">
            {!plans ? (
              <div className="flex items-center justify-center h-48 text-sol-text-dim">
                <span className="text-sm">Loading...</span>
              </div>
            ) : plans.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                <Target className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No plans yet</p>
                <button
                  onClick={() => setShowCreate(true)}
                  className="mt-2 flex items-center gap-1.5 text-xs text-sol-cyan hover:text-sol-text transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Create your first plan
                </button>
              </div>
            ) : (
              <>
                {activePlans.length > 0 && (
                  <div>
                    <div className="px-5 py-2 text-xs font-medium text-sol-text-dim uppercase tracking-wider border-b border-sol-border/20 bg-sol-bg-alt/20">
                      Active
                    </div>
                    {activePlans.map((p: any) => <PlanCard key={p._id} plan={p} />)}
                  </div>
                )}
                {draftPlans.length > 0 && (
                  <div>
                    <div className="px-5 py-2 text-xs font-medium text-sol-text-dim uppercase tracking-wider border-b border-sol-border/20 bg-sol-bg-alt/20">
                      Draft
                    </div>
                    {draftPlans.map((p: any) => <PlanCard key={p._id} plan={p} />)}
                  </div>
                )}
                {pausedPlans.length > 0 && (
                  <div>
                    <div className="px-5 py-2 text-xs font-medium text-sol-text-dim uppercase tracking-wider border-b border-sol-border/20 bg-sol-bg-alt/20">
                      Paused
                    </div>
                    {pausedPlans.map((p: any) => <PlanCard key={p._id} plan={p} />)}
                  </div>
                )}
                {donePlans.length > 0 && (
                  <div>
                    <div className="px-5 py-2 text-xs font-medium text-sol-text-dim uppercase tracking-wider border-b border-sol-border/20 bg-sol-bg-alt/20">
                      Done
                    </div>
                    {donePlans.map((p: any) => <PlanCard key={p._id} plan={p} />)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
