"use client";
import { ShortId } from "../../../../components/ShortId";
import { api } from "@codecast/convex/convex/_generated/api";
import { MarkdownRenderer } from "../../../../components/tools/MarkdownRenderer";
import { AvatarImg } from "../../../../lib/avatarCache";
import { SharedObjectPage } from "../../SharedObjectPage";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: "Draft", color: "text-sol-text-dim", bg: "bg-sol-base02" },
  active: { label: "Active", color: "text-sol-green", bg: "bg-sol-green/10" },
  paused: { label: "Paused", color: "text-sol-yellow", bg: "bg-sol-yellow/10" },
  done: { label: "Done", color: "text-sol-cyan", bg: "bg-sol-cyan/10" },
  abandoned: { label: "Abandoned", color: "text-sol-text-dim", bg: "bg-sol-base02" },
};

const TASK_STATUS_ICON: Record<string, string> = {
  open: "○",
  in_progress: "◑",
  in_review: "◕",
  done: "●",
  dropped: "×",
  backlog: "·",
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SharedPlanClient() {
  return (
    <SharedObjectPage<any> kind="plan" query={(api as any).plans.getShared} noun="plan">
      {(plan) => {
        const status = STATUS_CONFIG[plan.status] || STATUS_CONFIG.draft;
        const progress = plan.progress;
        const progressPct = progress && progress.total > 0
          ? Math.round((progress.done / progress.total) * 100)
          : null;
        return (
          <>
            {/* Header */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${status.color} ${status.bg}`}>
                  {status.label}
                </span>
                <ShortId id={plan.short_id} className="text-xs text-sol-text-dim" />
              </div>
              <h1 className="text-2xl font-semibold text-sol-text mb-3">{plan.title}</h1>
              <div className="flex items-center gap-3 text-xs text-sol-text-dim">
                {plan.user?.image && (
                  <AvatarImg src={plan.user.image} alt="" className="w-5 h-5 rounded-full" />
                )}
                {plan.user?.name && <span className="text-sol-text-muted">{plan.user.name}</span>}
                <span>{formatDate(plan.created_at)}</span>
              </div>
            </div>

            {/* Goal */}
            {plan.goal && (
              <div className="mb-6 px-4 py-3 border-l-2 border-sol-cyan/40 bg-sol-base02/50 rounded-r">
                <div className="text-xs text-sol-text-dim uppercase tracking-wider mb-1">Goal</div>
                <p className="text-sm text-sol-text-muted">{plan.goal}</p>
              </div>
            )}

            {/* Acceptance criteria */}
            {plan.acceptance_criteria && plan.acceptance_criteria.length > 0 && (
              <div className="mb-6">
                <div className="text-xs text-sol-text-dim uppercase tracking-wider mb-2">Acceptance Criteria</div>
                <ul className="space-y-1">
                  {plan.acceptance_criteria.map((c: string, i: number) => (
                    <li key={i} className="text-sm text-sol-text-muted flex gap-2">
                      <span className="text-sol-cyan shrink-0">-</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Progress bar */}
            {progressPct !== null && (
              <div className="mb-6">
                <div className="flex items-center justify-between text-xs text-sol-text-dim mb-1">
                  <span>Progress</span>
                  <span>{progress!.done}/{progress!.total} tasks ({progressPct}%)</span>
                </div>
                <div className="h-1.5 bg-sol-base02 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-sol-green rounded-full transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Doc content */}
            {plan.doc_content && (
              <article className="prose prose-invert max-w-none mb-8">
                <MarkdownRenderer content={plan.doc_content} />
              </article>
            )}

            {/* Tasks */}
            {plan.tasks && plan.tasks.length > 0 && (
              <div className="mb-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-3">Tasks</h2>
                <div className="space-y-1">
                  {plan.tasks.map((t: any) => (
                    <div key={t._id} className="flex items-center gap-2 text-sm py-1.5 px-3 rounded bg-sol-base02/30">
                      <span className={`font-mono text-xs ${t.status === "done" ? "text-sol-green" : "text-sol-text-dim"}`}>
                        {TASK_STATUS_ICON[t.status] || "○"}
                      </span>
                      <span className="text-sol-text-muted flex-1">{t.title}</span>
                      {t.short_id && (
                        <ShortId id={t.short_id} className="text-xs text-sol-text-dim" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments timeline */}
            {plan.comments && plan.comments.length > 0 && (
              <div className="border-t border-sol-border/20 pt-8">
                <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wider mb-4">Timeline</h2>
                <div className="space-y-3">
                  {plan.comments.map((e: any, i: number) => (
                    <div key={i} className="flex gap-3 text-sm">
                      <span className="text-sol-text-dim shrink-0 w-16">{formatDate(e.timestamp)}</span>
                      <span className="text-xs text-sol-cyan/70 shrink-0 w-20">{e.type}</span>
                      <div className="text-sol-text-muted">
                        <span>{e.content}</span>
                        {e.rationale && (
                          <span className="text-sol-text-dim ml-2">({e.rationale})</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
