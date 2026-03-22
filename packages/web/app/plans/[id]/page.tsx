"use client";
import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { DocumentDetailLayout } from "../../../components/DocumentDetailLayout";
import { DocListPanel, DetailSplitLayout } from "../../../components/DetailListPanel";
import "../../../components/editor/editor.css";
import {
  PlanProgressBar,
  PlanTaskSection,
  OrchestrationHeader,
  OrchestrationTab,
  StartWorkflowButton,
  DriveRoundIndicator,
  PLAN_STATUS_CONFIG,
} from "../../../components/PlanDetailPanel";
import { WorkflowContextPanel } from "../../../components/WorkflowContextPanel";
import { PlanBoardView } from "../../../components/PlanBoardView";
import { PlanGraphView } from "../../../components/PlanGraphView";
import {
  Clock,
  CheckCircle2,
  Zap,
  Layers,
  GitBranch,
  Lightbulb,
  ExternalLink,
} from "lucide-react";

const api = _api as any;

type PlanTab = "overview" | "orchestration" | "board" | "graph";

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PlanStatusSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const status = PLAN_STATUS_CONFIG[value] || PLAN_STATUS_CONFIG.draft;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`text-xs px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${status.color} ${status.bg} hover:opacity-80`}
      >
        {status.label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1 z-50 min-w-[130px]">
            {Object.entries(PLAN_STATUS_CONFIG).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  key === value
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                <span className={cfg.color}>{cfg.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EnsureDocTrigger({ planId }: { planId: any }) {
  const ensureDoc = useMutation(api.plans.ensureDoc);
  useMountEffect(() => {
    ensureDoc({ plan_id: planId });
  });
  return (
    <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
      Initializing plan document...
    </div>
  );
}

export default function PlanDetailPage() {
  const params = useParams();
  const id = params?.id as string;

  const queryArgs = id.startsWith("pl-") ? { short_id: id } : { id };
  const plan = useQuery(api.plans.webGet, queryArgs);
  const webUpdate = useMutation(api.plans.webUpdate);

  const [activeTab, setActiveTab] = useState<PlanTab>("overview");

  const handleTitleChange = useCallback(
    (title: string) => {
      if (!plan) return;
      webUpdate({ short_id: plan.short_id, title });
    },
    [plan, webUpdate]
  );

  const handleStatusChange = useCallback(
    (newStatus: string) => {
      if (!plan) return;
      webUpdate({ short_id: plan.short_id, status: newStatus });
    },
    [plan, webUpdate]
  );

  if (plan === undefined) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
            Loading...
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  if (plan === null) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
            Plan not found
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  if (!plan.doc_id) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <EnsureDocTrigger planId={plan._id} />
        </DashboardLayout>
      </AuthGuard>
    );
  }

  const hasTasks = (plan.tasks || []).length > 0;
  const hasActiveSessions = (plan.sessions || []).some((s: any) => s.is_active);

  return (
    <AuthGuard>
      <DashboardLayout>
        <DetailSplitLayout list={<DocListPanel selectedId={plan.doc_id} />}>
        <div className="h-full min-w-0">
        <DocumentDetailLayout
          docId={plan.doc_id}
          title={plan.title}
          markdownContent={plan.doc_content || ""}
          onTitleChange={handleTitleChange}
          backHref="/plans"
          linkedObjectId={plan._id}
          placeholder="Write plan details, notes, or documentation..."
          contextType="plan"
          topBarLeft={
            <>
              <PlanStatusSelector value={plan.status} onChange={handleStatusChange} />
              {plan.drive_state && plan.drive_state.total_rounds > 0 && (
                <DriveRoundIndicator driveState={plan.drive_state} />
              )}
            </>
          }
          metaContent={
            <>
              <div className="flex items-center gap-4 text-xs text-sol-text-dim flex-wrap">
                {plan.author?.image && (
                  <span className="flex items-center gap-1.5">
                    <img
                      src={plan.author.image}
                      alt={plan.author.name || ""}
                      className="w-4 h-4 rounded-full object-cover"
                    />
                    <span className="text-sol-text-muted">{plan.author.name}</span>
                  </span>
                )}
                <span className="font-mono text-sol-text-dim">{plan.short_id}</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatDate(plan.created_at)}
                </span>
                {plan.updated_at !== plan.created_at && (
                  <span>Updated {formatDate(plan.updated_at)}</span>
                )}
              </div>
              {plan.goal && (
                <p className="mt-2 text-sm text-sol-text-muted leading-relaxed">{plan.goal}</p>
              )}
              {plan.acceptance_criteria?.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-1">
                    Acceptance Criteria
                  </h3>
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
              {plan.context_pointers?.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-1">
                    Context
                  </h3>
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
            </>
          }
        >
          {plan.progress && plan.progress.total > 0 && (
            <PlanProgressBar progress={plan.progress} />
          )}

          {(plan as any).workflow_id && !(plan as any).workflow_run_id && (
            <StartWorkflowButton workflowId={(plan as any).workflow_id} planId={plan._id} />
          )}

          {(plan as any).workflow_run_id && (
            <div className="mb-5">
              <WorkflowContextPanel workflowRunId={(plan as any).workflow_run_id} />
            </div>
          )}

          {hasTasks && (
            <div className="flex items-center gap-1 mb-5 border-b border-sol-border/15">
              {([
                { key: "overview", icon: CheckCircle2, label: "Overview" },
                { key: "orchestration", icon: Zap, label: "Orchestration" },
                { key: "board", icon: Layers, label: "Board" },
                { key: "graph", icon: GitBranch, label: "Graph" },
              ] as const).map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === key
                      ? "text-sol-text border-sol-cyan"
                      : "text-sol-text-dim border-transparent hover:text-sol-text-muted"
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${key === "orchestration" && hasActiveSessions ? "text-emerald-600 dark:text-emerald-400" : ""}`} />
                  {label}
                  {key === "orchestration" && hasActiveSessions && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          )}

          {activeTab === "graph" ? (
            <PlanGraphView tasks={plan.tasks || []} />
          ) : activeTab === "board" ? (
            <PlanBoardView tasks={plan.tasks || []} planShortId={plan.short_id} />
          ) : activeTab === "overview" ? (
            <>
              <OrchestrationHeader tasks={plan.tasks || []} sessions={plan.sessions || []} />
              <PlanTaskSection planShortId={plan.short_id} tasks={plan.tasks || []} sessions={plan.sessions || []} />

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
                          {formatDate(entry.timestamp)}
                        </span>
                        <span className="text-sol-text-muted">{entry.entry}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
            </>
          ) : (
            <OrchestrationTab tasks={plan.tasks || []} sessions={plan.sessions || []} />
          )}
        </DocumentDetailLayout>
        </div>
        </DetailSplitLayout>
      </DashboardLayout>
    </AuthGuard>
  );
}
