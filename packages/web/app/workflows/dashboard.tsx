"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { DynamicRunView, wfStatusMeta, wfFmtTokens } from "../../components/DynamicRunView";
import { ExternalLink, Workflow } from "lucide-react";

const api = _api as any;

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function RunCard({ run }: { run: any }) {
  const sm = wfStatusMeta(run.status);
  const agentCount = run.agent_count ?? (run.node_statuses || []).length;
  return (
    <div className="rounded-xl border border-sol-cyan/20 bg-sol-cyan/[0.04] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-sol-cyan/15">
        <Workflow className="w-4 h-4 text-sol-cyan flex-shrink-0" />
        <span className="text-sm font-semibold text-sol-text truncate">{run.workflow_name || "workflow"}</span>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-sol-text-dim flex-shrink-0">
          <span>{agentCount} agents</span>
          {run.total_tokens ? <span>{wfFmtTokens(run.total_tokens)} tok</span> : null}
          <span>{timeAgo(run.updated_at || run.created_at)}</span>
          <span className={`flex items-center gap-1 ${sm.cls}`}>
            {sm.dot ? <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} /> : sm.icon}
            {run.status}
          </span>
          {run.primary_conversation_id && (
            <Link
              href={`/conversation/${run.primary_conversation_id}`}
              className="text-sol-cyan hover:text-sol-cyan flex items-center gap-0.5 hover:underline underline-offset-2"
            >
              view <ExternalLink className="w-3 h-3" />
            </Link>
          )}
        </div>
      </div>
      <div className="px-4 py-3">
        <DynamicRunView run={run} />
      </div>
    </div>
  );
}

function WorkflowsDashboardContent() {
  const runs = useQuery(api.workflow_runs.listDynamicRuns, {});
  return (
    <div className="h-full overflow-y-auto bg-sol-bg">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-baseline gap-2 mb-5">
          <Workflow className="w-4 h-4 text-sol-cyan self-center" />
          <h1 className="text-lg font-semibold text-sol-text">Workflows</h1>
          <span className="text-xs text-sol-text-dim">dynamic agent runs</span>
          {runs && <span className="ml-auto text-xs text-sol-text-dim font-mono">{runs.length}</span>}
        </div>
        {runs === undefined ? (
          <div className="text-sm text-sol-text-dim">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <Workflow className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">No workflow runs yet</p>
            <p className="text-xs text-sol-text-dim max-w-xs">
              Run a dynamic workflow in any session (e.g. <code className="font-mono text-sol-text-muted">ultracode</code>) and it appears here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {runs.map((r: any) => <RunCard key={r._id} run={r} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowsDashboard() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <WorkflowsDashboardContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
