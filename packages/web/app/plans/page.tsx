"use client";

import { copyToClipboard } from "../../lib/utils";
import { useState, useCallback, useMemo, useEffect, useRef, type MouseEvent } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { useSyncPlansWithArgs } from "../../hooks/useSyncPlans";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useInboxStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import { AppLoader } from "../../components/AppLoader";
import { DashboardLayout } from "../../components/DashboardLayout";
import { DetailSplitLayout } from "../../components/DetailSplitLayout";
import { PlanDetailPanel } from "../../components/PlanDetailPanel";
import { CreateDocModal } from "../../components/CreateDocModal";
import { ContextMenu, useContextMenu } from "../../components/ui/context-menu";
import { PlanMenuItems } from "../../components/menus/ObjectContextMenus";
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
  Link2,
  Forward,
} from "lucide-react";
import { openForwardToChat } from "../../lib/forwardToChat";
import { useTeamFeature } from "../../lib/teamFeatures";
import { toast } from "sonner";
import { LivePulseHalo } from "../../components/LivenessDot";
import { planLivenessState } from "../../lib/liveness";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";

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

function SidebarPlanItem({
  plan,
  isSelected,
  onSelect,
  onContextMenu,
}: {
  plan: any;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const status = STATUS_CONFIG[plan.status as PlanStatus] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;
  const sessionCount = plan.session_ids?.length || 0;
  const activeAgents = plan.active_agents || 0;
  const liveness = planLivenessState(plan.status, activeAgents > 0);
  const taskCount = plan.task_ids?.length || plan.progress?.total || 0;

  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`w-full text-left px-3 py-2.5 transition-colors border-l-2 ${
        isSelected
          ? "bg-sol-cyan/8 border-l-sol-cyan"
          : "border-l-transparent hover:bg-sol-bg-alt/50"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {liveness === "active" ? (
          <LivePulseHalo><StatusIcon className={`w-3.5 h-3.5 ${status.color}`} /></LivePulseHalo>
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
  onPlanContextMenu,
  defaultCollapsed,
}: {
  status: PlanStatus;
  plans: any[];
  selectedPlanId: string | null;
  onSelectPlan: (id: string) => void;
  onPlanContextMenu: (e: MouseEvent, plan: any) => void;
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
              onContextMenu={(e) => onPlanContextMenu(e, p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlansPage() {
  const router = useRouter();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
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

  // The source toggle is otherwise store-only; honor a shared ?source= deep link
  // once on mount so the copied "link to this view" round-trips back through here.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const src = searchParams.get("source");
    if (src && src !== planSource) setPlanSource(src);
  }, []);

  // A deep-linkable URL for the current view: the source filter plus the
  // open plan (already carried in the URL as ?plan=). Built from state rather
  // than window.location because the source toggle doesn't live-sync the URL.
  const chatOn = useTeamFeature("chat");
  const viewLink = useCallback(() => {
    const params = new URLSearchParams();
    if (planSource) params.set("source", planSource);
    if (selectedPlan) params.set("plan", selectedPlan);
    const qs = params.toString();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/plans${qs ? `?${qs}` : ""}`;
  }, [planSource, selectedPlan]);
  const copyViewLink = useCallback(async () => {
    try {
      await copyToClipboard(viewLink());
      toast.success("Link to this view copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  }, [viewLink]);

  // Local-first: the board renders from the store's plans collection
  // synchronously (workspace-scoped through the one chokepoint); these
  // subscriptions only FEED it — the same split the tasks board uses. The
  // done-plans sync arms on demand, since webList excludes done/abandoned by
  // default and those rows may not be cached yet.
  const workspaceArgs = useWorkspaceArgs();
  const { ready } = useSyncPlansWithArgs(workspaceArgs);
  useSyncPlansWithArgs(showDone ? workspaceArgs : "skip", "done");
  const wsPlans = useWorkspaceCollection<any>(
    "plans",
    (p) => `${p.status}|${p.source ?? ""}|${p.updated_at ?? 0}|${p.title ?? ""}|${p.progress?.done ?? 0}/${p.progress?.total ?? 0}`,
  );

  const rawPlans = useMemo(() => {
    // Mirror the server's read-time filter: done/abandoned stay hidden until
    // asked for. The store may hold them from an earlier toggle or another
    // surface's sync; the filter, not the fetch, is what hides them.
    const rows = showDone ? wsPlans : wsPlans.filter((p: any) => p.status !== "done" && p.status !== "abandoned");
    return [...rows].sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));
  }, [wsPlans, showDone]);
  // Skeleton only for a genuinely cold cache: no cached rows AND the first
  // answer still in flight. A populated store paints instantly.
  const plansLoading = !ready && rawPlans.length === 0;

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

  const ctxMenu = useContextMenu<any>();
  const handlePlanContextMenu = useCallback((e: MouseEvent, plan: any) => {
    ctxMenu.open(e, plan);
  }, [ctxMenu.open]);

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
            loading={plansLoading}
            empty={!plansLoading && rawPlans.length === 0}
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
        <DetailSplitLayout
          closeHref="/plans"
          list={
            <div className="flex flex-col h-full bg-sol-bg">
            <div ref={titlebarRef} className="cc-panel__head justify-between">
              {/* The tab bar already says "Plans"; repeating it here was the
                  doubled title. Identity stays as the glyph alone. */}
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-sol-cyan" />
                <h2 className="sr-only">Plans</h2>
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
                  onClick={copyViewLink}
                  className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                  title="Copy link to this view"
                >
                  <Link2 className="w-3.5 h-3.5" />
                </button>
                {chatOn && (
                  <button
                    onClick={() => openForwardToChat({ url: viewLink(), label: "view" })}
                    className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                    title="Send this view to chat"
                  >
                    <Forward className="w-3.5 h-3.5" />
                  </button>
                )}
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
              {plansLoading ? (
                <AppLoader className="min-h-[16rem] h-full" />
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
                      onPlanContextMenu={handlePlanContextMenu}
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
                          onPlanContextMenu={handlePlanContextMenu}
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
                      onPlanContextMenu={handlePlanContextMenu}
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

          }
        >
          {selectedPlan ? <PlanDetailPanel planId={selectedPlan} /> : null}
        </DetailSplitLayout>
        <ContextMenu state={ctxMenu}>
          {(plan) => (
            <PlanMenuItems plan={plan} onOpen={() => handleSelectPlan(plan.short_id || plan._id)} />
          )}
        </ContextMenu>
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
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  return (
    <div className="h-full flex flex-col">
      <div ref={titlebarRef} className="px-4 py-3 border-b border-sol-border/30 flex items-center justify-between">
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
          <AppLoader className="min-h-[16rem] h-full" />
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
