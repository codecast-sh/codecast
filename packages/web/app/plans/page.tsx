"use client";

import { useState, useCallback } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { PlanDetailPanel } from "../../components/PlanDetailPanel";
import { toast } from "sonner";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  PauseCircle,
  XCircle,
  Target,
  MessageSquare,
  ChevronRight,
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

const STATUS_ORDER: PlanStatus[] = ["active", "draft", "paused", "done", "abandoned"];

function MiniProgressBar({ progress }: { progress?: { total: number; done: number; in_progress: number } }) {
  if (!progress || progress.total === 0) return null;
  const donePct = (progress.done / progress.total) * 100;
  const ipPct = (progress.in_progress / progress.total) * 100;

  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1 bg-sol-border/30 rounded-full overflow-hidden">
        <div className="h-full flex">
          <div className="bg-sol-green transition-all" style={{ width: `${donePct}%` }} />
          <div className="bg-sol-yellow transition-all" style={{ width: `${ipPct}%` }} />
        </div>
      </div>
      <span className="text-[10px] text-sol-text-dim tabular-nums">
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

function SidebarPlanItem({ plan, isSelected, onSelect }: { plan: any; isSelected: boolean; onSelect: () => void }) {
  const status = STATUS_CONFIG[plan.status as PlanStatus] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;
  const sessionCount = plan.session_ids?.length || 0;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 transition-colors border-l-2 ${
        isSelected
          ? "bg-sol-cyan/8 border-l-sol-cyan"
          : "border-l-transparent hover:bg-sol-bg-alt/50"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${status.color}`} />
        <span className={`text-sm truncate ${isSelected ? "text-sol-text font-medium" : "text-sol-text"}`}>
          {plan.title}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1 pl-[22px]">
        <span className="text-[10px] font-mono text-sol-text-dim">{plan.short_id}</span>
        <MiniProgressBar progress={plan.progress} />
        {sessionCount > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-sol-text-dim">
            <MessageSquare className="w-2.5 h-2.5" />
            {sessionCount}
          </span>
        )}
        <span className="text-[10px] text-sol-text-dim tabular-nums ml-auto">
          {timeAgo(plan.updated_at)}
        </span>
      </div>
    </button>
  );
}

function StatusGroup({
  status,
  plans,
  selectedPlanId,
  onSelectPlan,
  defaultCollapsed,
}: {
  status: PlanStatus;
  plans: any[];
  selectedPlanId: string | null;
  onSelectPlan: (id: string) => void;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  if (plans.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-sol-bg-alt/40 border-b border-sol-border/15 hover:bg-sol-bg-alt/60 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 text-sol-text-dim transition-transform ${collapsed ? "" : "rotate-90"}`} />
        <Icon className={`w-3 h-3 ${config.color}`} />
        <span className="text-[11px] font-medium text-sol-text-dim uppercase tracking-wide">
          {config.label}
        </span>
        <span className="text-[10px] text-sol-text-dim/60">({plans.length})</span>
      </button>
      {!collapsed && (
        <div>
          {plans.map((p: any) => (
            <SidebarPlanItem
              key={p._id}
              plan={p}
              isSelected={selectedPlanId === p._id || selectedPlanId === p.short_id}
              onSelect={() => onSelectPlan(p.short_id || p._id)}
            />
          ))}
        </div>
      )}
    </div>
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
        router.push(`/plans?plan=${result.short_id || result.id}`, { scroll: false });
      }
    } catch {
      toast.error("Failed to create plan");
      setSubmitting(false);
    }
  }, [title, goal, submitting, createPlan, router, onClose]);

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/30 px-3 py-3">
      <div className="space-y-2">
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) handleSubmit(); if (e.key === "Escape") onClose(); }}
          placeholder="Plan title..."
          className="w-full text-sm px-3 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
        />
        <textarea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && e.metaKey) handleSubmit(); if (e.key === "Escape") onClose(); }}
          placeholder="Goal (optional)..."
          rows={2}
          className="w-full text-sm px-3 py-1.5 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan resize-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="px-3 py-1 text-xs rounded-lg bg-sol-cyan text-sol-bg font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {submitting ? "Creating..." : "Create"}
          </button>
          <button onClick={onClose} className="px-2 py-1 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PlansPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedPlan = searchParams.get("plan");
  const [showDone, setShowDone] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const workspaceArgs = useWorkspaceArgs();
  const activePlans = useQuery(api.plans.webList,
    workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const donePlans = useQuery(api.plans.webList,
    workspaceArgs === "skip" ? "skip"
      : showDone ? { status: "done", ...workspaceArgs } : "skip"
  );

  const allPlans = [
    ...(activePlans || []),
    ...(donePlans || []),
  ];

  const grouped = STATUS_ORDER.reduce((acc, status) => {
    acc[status] = allPlans.filter((p: any) => p.status === status);
    return acc;
  }, {} as Record<PlanStatus, any[]>);

  const handleSelectPlan = useCallback((planId: string) => {
    router.push(`/plans?plan=${planId}`, { scroll: false });
  }, [router]);

  const [isMobile, setIsMobile] = useState(false);
  useMountEffect(() => {
    setIsMobile(window.innerWidth < 768);
  });
  useEventListener("resize", useCallback(() => {
    setIsMobile(window.innerWidth < 768);
  }, []));

  if (isMobile) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <MobileList
            grouped={grouped}
            showDone={showDone}
            setShowDone={setShowDone}
            loading={!activePlans}
            empty={activePlans?.length === 0}
          />
        </DashboardLayout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full flex">
          <div className="w-[300px] flex-shrink-0 border-r border-sol-border/30 flex flex-col h-full bg-sol-bg">
            <div className="px-3 py-3 border-b border-sol-border/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-sol-cyan" />
                <h2 className="text-sm font-semibold text-sol-text tracking-tight">Plans</h2>
              </div>
              <button
                onClick={() => setShowCreate(!showCreate)}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                title="New Plan"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {showCreate && <CreatePlanForm onClose={() => setShowCreate(false)} />}

            <div className="flex-1 overflow-y-auto">
              {!activePlans ? (
                <div className="flex items-center justify-center h-32 text-sol-text-dim">
                  <span className="text-xs">Loading...</span>
                </div>
              ) : allPlans.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-sol-text-dim px-4">
                  <Target className="w-6 h-6 mb-2 opacity-30" />
                  <p className="text-xs">No plans yet</p>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="mt-2 flex items-center gap-1 text-xs text-sol-cyan hover:text-sol-text transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    Create your first plan
                  </button>
                </div>
              ) : (
                <>
                  {STATUS_ORDER.filter(s => s !== "done" && s !== "abandoned").map(status => (
                    <StatusGroup
                      key={status}
                      status={status}
                      plans={grouped[status]}
                      selectedPlanId={selectedPlan}
                      onSelectPlan={handleSelectPlan}
                    />
                  ))}
                  {(grouped.done.length > 0 || !showDone) && (
                    <div>
                      {showDone ? (
                        <StatusGroup
                          status="done"
                          plans={grouped.done}
                          selectedPlanId={selectedPlan}
                          onSelectPlan={handleSelectPlan}
                          defaultCollapsed
                        />
                      ) : (
                        <button
                          onClick={() => setShowDone(true)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 bg-sol-bg-alt/20 border-b border-sol-border/15 hover:bg-sol-bg-alt/40 transition-colors text-[11px] text-sol-text-dim"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Show completed plans
                        </button>
                      )}
                    </div>
                  )}
                  {grouped.abandoned.length > 0 && (
                    <StatusGroup
                      status="abandoned"
                      plans={grouped.abandoned}
                      selectedPlanId={selectedPlan}
                      onSelectPlan={handleSelectPlan}
                      defaultCollapsed
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {selectedPlan ? (
              <PlanDetailPanel planId={selectedPlan} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-sol-text-dim">
                <Target className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-sm">Select a plan to view details</p>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}

function MobileList({
  grouped,
  showDone,
  setShowDone,
  loading,
  empty,
}: {
  grouped: Record<PlanStatus, any[]>;
  showDone: boolean;
  setShowDone: (v: boolean) => void;
  loading: boolean;
  empty: boolean;
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-sol-border/30 flex items-center gap-2">
        <Target className="w-4 h-4 text-sol-cyan" />
        <h1 className="text-base font-semibold text-sol-text">Plans</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sol-text-dim">
            <span className="text-sm">Loading...</span>
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center justify-center h-32 text-sol-text-dim">
            <Target className="w-6 h-6 mb-2 opacity-30" />
            <p className="text-sm">No plans yet</p>
          </div>
        ) : (
          <>
            {STATUS_ORDER.filter(s => s !== "done" && s !== "abandoned").map(status => {
              if (grouped[status].length === 0) return null;
              return (
                <div key={status}>
                  <div className="px-4 py-1.5 text-[11px] font-medium text-sol-text-dim uppercase tracking-wide bg-sol-bg-alt/30 border-b border-sol-border/15">
                    {STATUS_CONFIG[status].label} ({grouped[status].length})
                  </div>
                  {grouped[status].map((p: any) => (
                    <Link key={p._id} href={`/plans/${p._id}`} className="block px-4 py-3 border-b border-sol-border/15 hover:bg-sol-bg-alt/30">
                      <div className="text-sm text-sol-text">{p.title}</div>
                      <div className="text-[10px] text-sol-text-dim font-mono mt-0.5">{p.short_id}</div>
                    </Link>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
