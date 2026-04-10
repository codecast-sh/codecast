"use client";

import { useState, useCallback, useMemo } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { useInboxStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { PlanDetailPanel } from "../../components/PlanDetailPanel";
import { CreateDocModal } from "../../components/CreateDocModal";
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
  Zap,
  User,
  Bot,
} from "lucide-react";
import { LivenessDot, planLivenessState } from "../../components/LivenessDot";

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
  const activeAgents = plan.active_agents || 0;
  const liveness = planLivenessState(plan.status, activeAgents > 0);
  const taskCount = plan.task_ids?.length || plan.progress?.total || 0;

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
        {liveness === "active" ? (
          <LivenessDot state="active" size="sm" />
        ) : (
          <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${status.color}`} />
        )}
        <span className={`text-sm truncate ${isSelected ? "text-sol-text font-medium" : "text-sol-text"}`}>
          {plan.title}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1 pl-[22px]">
        <span className="text-[10px] font-mono text-sol-text-dim">{plan.short_id}</span>
        <MiniProgressBar progress={plan.progress} />
        {activeAgents > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-400">
            <Zap className="w-2.5 h-2.5" />
            {activeAgents}
          </span>
        )}
        {taskCount > 0 && (
          <span className="text-[10px] text-sol-text-dim tabular-nums">
            {taskCount}t
          </span>
        )}
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

export default function PlansPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedPlan = searchParams.get("plan");
  const [showDone, setShowDone] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const planView = useInboxStore((s) => s.clientState.ui?.plan_view);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const planSource = planView?.source ?? "";
  const setPlanSource = useCallback((source: string) => {
    updateClientUI({ plan_view: { ...planView, source: source || undefined } });
  }, [updateClientUI, planView]);

  const workspaceArgs = useWorkspaceArgs();
  const activePlans = useQuery(api.plans.webList,
    workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const donePlans = useQuery(api.plans.webList,
    workspaceArgs === "skip" ? "skip"
      : showDone ? { status: "done", ...workspaceArgs } : "skip"
  );

  const rawPlans = useMemo(() => [
    ...(activePlans || []),
    ...(donePlans || []),
  ], [activePlans, donePlans]);

  const allPlans = useMemo(() => {
    if (planSource === "human") return rawPlans.filter((p: any) => p.source === "human" || !p.source);
    return rawPlans; // Default: show everything
  }, [rawPlans, planSource]);

  const hiddenAgentCount = useMemo(() => {
    if (planSource !== "human") return 0;
    return rawPlans.filter((p: any) => p.source && p.source !== "human").length;
  }, [rawPlans, planSource]);

  const grouped = STATUS_ORDER.reduce((acc, status) => {
    acc[status] = allPlans.filter((p: any) => p.status === status);
    return acc;
  }, {} as Record<PlanStatus, any[]>);

  const handleSelectPlan = useCallback((planId: string) => {
    router.push(`/plans?plan=${planId}`);
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
            planSource={planSource}
            setPlanSource={setPlanSource}
            hiddenAgentCount={hiddenAgentCount}
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
              <div className="flex items-center gap-1.5">
                <div className="flex items-center rounded-md border border-sol-border/40 overflow-hidden">
                  <button
                    onClick={() => setPlanSource("")}
                    className={`px-1.5 py-1 transition-colors ${!planSource ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                    title="My plans"
                  >
                    <User className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setPlanSource("all")}
                    className={`px-1.5 py-1 text-[10px] transition-colors border-l border-sol-border/40 ${planSource === "all" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                    title="All plans"
                  >
                    All
                  </button>
                </div>
                <button
                  onClick={() => setShowCreate(!showCreate)}
                  className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                  title="New Plan"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {showCreate && (
              <CreateDocModal onClose={() => setShowCreate(false)} initialType="plan" />
            )}

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
                  {hiddenAgentCount > 0 && (
                    <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-sol-text-dim border-b border-sol-border/15">
                      <Bot className="w-3 h-3 opacity-40" />
                      <span>{hiddenAgentCount} agent {hiddenAgentCount === 1 ? "plan" : "plans"} not shown</span>
                      <button onClick={() => setPlanSource("all")} className="text-sol-cyan hover:underline ml-0.5">
                        Show
                      </button>
                    </div>
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
  planSource,
  setPlanSource,
  hiddenAgentCount,
}: {
  grouped: Record<PlanStatus, any[]>;
  showDone: boolean;
  setShowDone: (v: boolean) => void;
  loading: boolean;
  empty: boolean;
  planSource: string;
  setPlanSource: (v: string) => void;
  hiddenAgentCount: number;
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-sol-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-sol-cyan" />
          <h1 className="text-base font-semibold text-sol-text">Plans</h1>
        </div>
        <div className="flex items-center rounded-md border border-sol-border/40 overflow-hidden">
          <button
            onClick={() => setPlanSource("")}
            className={`px-2 py-1 transition-colors ${!planSource ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
            title="My plans"
          >
            <User className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setPlanSource("all")}
            className={`px-2 py-1 text-xs transition-colors border-l border-sol-border/40 ${planSource === "all" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
            title="All plans"
          >
            All
          </button>
        </div>
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
            {hiddenAgentCount > 0 && (
              <div className="px-4 py-2.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                <Bot className="w-3 h-3 opacity-40" />
                <span>{hiddenAgentCount} agent {hiddenAgentCount === 1 ? "plan" : "plans"} not shown</span>
                <button onClick={() => setPlanSource("all")} className="text-sol-cyan hover:underline ml-0.5">
                  Show
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
