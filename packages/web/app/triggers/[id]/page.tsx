"use client";

// The dedicated page for ONE trigger — what it does, when it fires, every past
// run, and the verbs — addressed as /triggers/<tr-short-id|convex-id>. This is
// where the inline tr- pills and the conversation strip land. The list page
// (/triggers) keeps its row expander for browsing; this page is the full-width
// home of a single schedule.
//
// Data is local-first for the viewer's own triggers (the agentTasks store
// collection paints the first frame and verbs flip it synchronously); webGet
// overlays the enrichment (creator titles, is_own) and is the ONLY source for
// a foreign trigger — one owned by another account (a remote daemon's bot
// login) but anchored to a conversation the viewer can see. Foreign rows are
// view-only: the verbs belong to the owner account.

import { useMemo, useState } from "react";
import { ShareControl } from "../../../components/ShareControl";
import { policyTeamOf } from "@codecast/shared/contracts";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMutation } from "convex/react";
import { copyToClipboard } from "../../../lib/utils";
import { AuthGuard } from "../../../components/AuthGuard";
import { PaneLoader } from "../../../components/PaneLoader";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ShortcutTooltip } from "../../../components/KeyboardShortcutsHelp";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { useTriggers } from "../../../hooks/useSyncTriggers";
import { TriggerRunList, useTriggerRuns } from "../../../components/TriggerRunHistory";
import { TriggerPromptView } from "../../../components/TriggerPromptView";
import { entityQueryArgs } from "../../../lib/entityDisplay";
import {
  describeTaskCadence,
  fmtClock,
  fmtDuration,
  taskStateLabel,
  triggerEventLabel,
} from "../../../components/triggerCadence";
import { ARMED_STATUSES, isTriggerTerminal, taskDisplayTitle, type TaskRow } from "../../../components/triggerTasks";
import { isTriggerEditable } from "../../../lib/triggerEditable";
import { SwitchReview } from "../../../components/consequential/ConsequentialSwitch";
import { useRunCost } from "../../../components/consequential/useRunCost";
import { triggerArmLedger, triggerRunNowLedger } from "../../../components/work/startLedgers";
import { TriggerForm } from "../page";
import { PageFrame, PageHeader } from "../../../components/ui/page-header";
import { useIsModernStyle } from "../../../hooks/useVisualStyle";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  Folder,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck,
  X,
  XCircle,
  Zap,
} from "lucide-react";

const api = _api as any;

// One trigger's status, as a chip — same vocabulary as the strip and the list
// rows (taskStateLabel for armed states), sized for the page header.
function StatusChip({ task, now }: { task: TaskRow; now: number }) {
  switch (task.status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sol-green/40 bg-sol-green/10 text-sol-green text-meta font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
          running
        </span>
      );
    case "scheduled":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sol-orange/40 bg-sol-orange/10 text-sol-orange text-meta font-medium tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" />
          {taskStateLabel(task, now)}
        </span>
      );
    case "paused":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sol-border bg-sol-bg-alt/60 text-sol-text-dim text-meta font-medium">
          <Pause className="w-3 h-3" /> paused
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sol-red/40 bg-sol-red/10 text-sol-red text-meta font-medium">
          <XCircle className="w-3 h-3" /> failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-sol-border bg-sol-bg-alt/60 text-sol-text-dim text-meta font-medium">
          <Check className="w-3 h-3" /> done
        </span>
      );
  }
}

function StatCell({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-sol-border/40 bg-sol-bg-alt/30 px-3.5 py-3">
      <div className="text-mark font-semibold uppercase tracking-[0.14em] text-sol-text-dim/70">
        {label}
      </div>
      <div className="mt-1 text-sm text-sol-text truncate">{children}</div>
      {sub && <div className="mt-0.5 text-meta text-sol-text-dim truncate">{sub}</div>}
    </div>
  );
}

// A linked conversation row for the provenance card.
function SessionLink({ label, id, title }: { label: string; id?: string; title?: string }) {
  if (!id) return null;
  return (
    <Link
      href={`/conversation/${id}`}
      className="group flex items-center gap-2 py-1 text-meta no-underline"
    >
      <MessageSquare className="w-3 h-3 flex-shrink-0 text-sol-cyan/70" />
      <span className="text-sol-text-dim flex-shrink-0">{label}</span>
      <span className="truncate text-sol-text-muted group-hover:text-sol-cyan transition-colors">
        {title || "Untitled session"}
      </span>
      <ArrowUpRight className="w-3 h-3 flex-shrink-0 text-sol-cyan opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

const verbBtn =
  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-[color,background-color,transform] duration-100 active:scale-[0.97] disabled:opacity-50";

export default function TriggerDetailPage() {
  const params = useParams();
  const id = (params?.id as string | undefined)?.trim();

  // Server row: enrichment + the only source for foreign (bot-owned) triggers.
  // No-throw so a backend that predates webGet's access change degrades to the
  // store row instead of an error boundary.
  const { data: served, error } = useQueryNoThrow(
    api.agentTasks.webGet,
    id ? entityQueryArgs("trigger", id) : "skip"
  );

  // The viewer's own roster, from the store — first paint and the optimistic
  // side of every verb click.
  const { tasks: ownTasks } = useTriggers();
  const storeRow = useMemo(() => {
    if (!id) return undefined;
    const lower = id.toLowerCase();
    return (ownTasks as TaskRow[]).find((t) => t._id === id || t.short_id === lower);
  }, [ownTasks, id]);

  // Store wins the shared fields (status flips locally on a verb click);
  // server-only enrichment (titles, is_own, owner_name) rides underneath.
  const trigger: (TaskRow & { short_id?: string }) | null | undefined = useMemo(() => {
    if (storeRow) return { ...(served ?? {}), ...storeRow };
    if (served !== undefined) return served;
    if (error) return null;
    // Own roster fully loaded with no match and the query still in flight:
    // keep waiting for the server's answer (it may be a foreign trigger).
    return undefined;
  }, [storeRow, served, error]);

  const now = useCoarseNow(30_000);
  const triggerAction = useInboxStore((s) => s.triggerAction);
  const regenerateSummary = useMutation(api.agentTasks.webRegenerateSummary);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  // A start (run now, resume, reactivate) spends an agent run: it opens the
  // shared review, and only the review's confirm acts. Pause and cancel stay
  // one press.
  const [reviewing, setReviewing] = useState<null | "runNow" | "resume" | "reactivate">(null);
  const [editing, setEditing] = useState(false);
  const runCost = useRunCost(null);
  const modern = useIsModernStyle();

  const taskId = trigger?._id;
  const runs = useTriggerRuns(taskId ?? null);

  if (!id || trigger === undefined) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <PaneLoader />
        </DashboardLayout>
      </AuthGuard>
    );
  }

  if (trigger === null) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm px-4">
              <Zap className="w-6 h-6 mx-auto text-sol-orange/50" />
              <div className="mt-3 text-sm text-sol-text">This trigger isn't available</div>
              <p className="mt-1 text-xs text-sol-text-dim">
                It was deleted, or it belongs to a session you don't have access to.
              </p>
              <Link
                href="/triggers"
                className="mt-4 inline-block px-3 py-1 rounded border border-sol-border text-xs text-sol-text-muted hover:bg-sol-bg-alt transition-colors no-underline"
              >
                All triggers
              </Link>
            </div>
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  const t = trigger;
  // Verbs follow view access: whoever can see this page can manage the
  // trigger (founder decision 2026-08-30). The "runs as X" chip stays as
  // provenance for foreign triggers.
  const isForeign = t.is_own === false;
  const isArmed = ARMED_STATUSES.has(t.status);
  const isTerminal = isTriggerTerminal(t.status);
  const isEditable = isTriggerEditable(t.status);
  const msUntil = t.status === "scheduled" && t.run_at !== undefined ? t.run_at - now : undefined;
  const cycleProgress =
    t.schedule_type === "recurring" && t.interval_ms && msUntil !== undefined
      ? Math.round(Math.min(1, Math.max(0, 1 - msUntil / t.interval_ms)) * 100)
      : null;
  const brief = t.display_summary?.trim();
  const title = taskDisplayTitle(t);
  // Skipped firings are runs in the history, but not runs of the agent — the
  // "Runs" vital counts sessions, which is what run_count means.
  const sessionRuns = runs?.filter((r) => r.kind !== "skipped_precheck");
  const totalRuns = Math.max(t.run_count ?? 0, sessionRuns?.length ?? 0);
  // triggerEventLabel reads a raw webhook filter as well as a derived name, so
  // an old trigger armed on "pull_request" still reads as words.
  const eventLabel =
    t.schedule_type === "event" && t.event_filter ? triggerEventLabel(t.event_filter) : null;
  const projectName = t.project_path?.split("/").filter(Boolean).pop();

  const outcome = t.last_run_failed
    ? { Icon: XCircle, tone: "text-sol-red", word: "failed" }
    : t.last_run_needs_attention
      ? { Icon: AlertTriangle, tone: "text-sol-orange", word: "needs attention" }
      : { Icon: CheckCircle2, tone: "text-sol-green", word: "ok" };

  const act = (verb: "pause" | "resume" | "runNow" | "cancel" | "reactivate") => {
    triggerAction(t._id, verb);
    setConfirmingCancel(false);
  };

  const ledgerFacts = {
    title,
    cadence: describeTaskCadence(t),
    schedule: t.schedule_type,
    intervalMs: t.interval_ms ?? null,
    agent: t.agent_type ?? null,
    project: projectName ?? null,
    applies: t.mode === "apply",
    hosted: t.hosted_home === true,
  };
  const reviewLedger =
    reviewing === "runNow" ? triggerRunNowLedger(ledgerFacts, runCost)
    : reviewing === "resume" ? triggerArmLedger(ledgerFacts, "Paused", null, runCost)
    : reviewing === "reactivate" ? triggerArmLedger(ledgerFacts, "Finished", t.schedule_type === "recurring" && t.interval_ms ? now + t.interval_ms : null, runCost)
    : null;

  const copyId = () => {
    copyToClipboard(t.short_id ?? t._id).then(() => {
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    });
  };

  // The id and the share control, drawn by whichever header is up.
  const idCopy = (t.short_id || t._id) && (
                    <ShortcutTooltip label={idCopied ? "Copied" : "Copy id"}>
                      <button
                        onClick={copyId}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-border/50 font-mono text-meta text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
                      >
                        {t.short_id ?? "id"}
                        {idCopied ? (
                          <Check className="w-2.5 h-2.5 text-sol-green" />
                        ) : (
                          <Copy className="w-2.5 h-2.5" />
                        )}
                      </button>
                    </ShortcutTooltip>
  );
  const share = <ShareControl label="trigger" path={`/triggers/${t._id}`} publicShare={{ kind: "trigger", id: t._id, token: (t as any).share_token, team: policyTeamOf("triggers", t) }} />;
  const backLink = (
            <Link
              href="/triggers"
              data-page-head
              className="inline-flex items-center gap-1 text-meta text-sol-text-dim hover:text-sol-text transition-colors no-underline"
            >
              <ArrowLeft className="w-3 h-3" /> All triggers
            </Link>
  );

  return (
    <AuthGuard>
      <DashboardLayout>
        <PageFrame
          // data-page-head: inside a reveal band the band's strip names and shares it (globals.css).
          header={<PageHeader legacy={backLink} data-page-head crumbs={<Link href="/triggers" className="no-underline hover:text-sol-text">Triggers</Link>} icon={Zap} title={title} actions={idCopy} share={share} />}
          legacyScroll="h-full overflow-y-auto"
          legacyScrollProps={{ "data-main-scroll": true }}
          legacyColumn="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6"
          column="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5"
        >
            {/* ── Identity (Modern: the header names it; its state and brief lead the page) ── */}
            <div className={modern ? "flex items-start gap-4" : "mt-4 flex items-start gap-4"}>
              {!modern && (
                <div data-page-head className="flex-shrink-0 w-11 h-11 rounded-xl border border-sol-orange/30 bg-sol-orange/10 flex items-center justify-center">
                  <Zap className="w-5 h-5 text-sol-orange" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {!modern && (
                  <div data-page-head className="flex items-center gap-2.5 flex-wrap">
                    <h1 className="text-xl font-semibold text-sol-text leading-tight">{title}</h1>
                    {share}
                    {idCopy}
                  </div>
                )}
                <div className={`${modern ? "" : "mt-1.5 "}flex items-center gap-2 flex-wrap text-meta`}>
                  <StatusChip task={t} now={now} />
                  <span className="text-sol-text-dim">{describeTaskCadence(t)}</span>
                  {t.mode !== "apply" && (
                    <ShortcutTooltip label="Read-only run — investigates and reports, changes nothing">
                      <span className="px-1.5 py-px rounded border font-medium border-sol-cyan/40 text-sol-cyan/90 bg-sol-cyan/10">
                        read-only
                      </span>
                    </ShortcutTooltip>
                  )}
                  {isForeign && (
                    <ShortcutTooltip label="This trigger runs under a different account; anyone who can see it can manage it">
                      <span className="inline-flex items-center gap-1 px-1.5 py-px rounded border border-sol-violet/40 bg-sol-violet/10 text-sol-violet">
                        <Bot className="w-3 h-3" />
                        runs as {t.owner_name || "another account"}
                      </span>
                    </ShortcutTooltip>
                  )}
                </div>
                {brief && (
                  <p className="mt-2.5 max-w-[90ch] text-[13px] leading-relaxed text-sol-text-muted">
                    {brief}
                  </p>
                )}
              </div>
            </div>

            {/* ── Verbs ── */}
            {(isArmed || isTerminal) && (
              <div className="mt-4 flex items-center gap-1.5 flex-wrap">
                {isArmed && (
                  <>
                    <ShortcutTooltip label="Queue a run immediately — doesn't shift the regular cadence">
                      <button
                        onClick={() => setReviewing("runNow")}
                        aria-haspopup="dialog"
                        className={`${verbBtn} border-sol-cyan/40 text-sol-cyan bg-sol-cyan/10 hover:bg-sol-cyan/20`}
                      >
                        <Play className="w-3.5 h-3.5" /> Run now
                      </button>
                    </ShortcutTooltip>
                    {t.status === "paused" ? (
                      <ShortcutTooltip label="Re-arm the trigger — fires resume from now">
                        <button
                          onClick={() => setReviewing("resume")}
                          aria-haspopup="dialog"
                          className={`${verbBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10`}
                        >
                          <Play className="w-3.5 h-3.5" /> Resume
                        </button>
                      </ShortcutTooltip>
                    ) : (
                      <ShortcutTooltip label="Pause — skips every fire until resumed">
                        <button
                          onClick={() => act("pause")}
                          className={`${verbBtn} border-sol-border/50 text-sol-text-dim hover:bg-sol-bg-alt/60`}
                        >
                          <Pause className="w-3.5 h-3.5" /> Pause
                        </button>
                      </ShortcutTooltip>
                    )}
                    {confirmingCancel ? (
                      <button
                        onClick={() => act("cancel")}
                        className={`${verbBtn} border-sol-red/50 text-sol-red bg-sol-red/10 hover:bg-sol-red/20`}
                      >
                        Confirm cancel
                      </button>
                    ) : (
                      <ShortcutTooltip label="Cancel this trigger permanently" hint="asks to confirm">
                        <button
                          onClick={() => setConfirmingCancel(true)}
                          className={`${verbBtn} border-sol-border/50 text-sol-text-dim hover:text-sol-red hover:border-sol-red/40`}
                        >
                          <X className="w-3.5 h-3.5" /> Cancel
                        </button>
                      </ShortcutTooltip>
                    )}
                  </>
                )}
                {isTerminal && (
                  <ShortcutTooltip label="Re-arm this trigger — the next fire is one cycle from now">
                    <button
                      onClick={() => setReviewing("reactivate")}
                      aria-haspopup="dialog"
                      className={`${verbBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10`}
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Reactivate
                    </button>
                  </ShortcutTooltip>
                )}
                {isEditable && (
                  <ShortcutTooltip label="Edit the prompt or cadence">
                    <button
                      onClick={() => setEditing((v) => !v)}
                      aria-expanded={editing}
                      className={`${verbBtn} border-sol-border/50 text-sol-text-dim hover:bg-sol-bg-alt/60 ${editing ? "bg-sol-bg-alt/60 text-sol-text" : ""}`}
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </button>
                  </ShortcutTooltip>
                )}
              </div>
            )}

            {/* The edit form, here on the trigger's own page. */}
            {editing && isEditable && (
              <div className="mt-4">
                <TriggerForm editTask={t} onClose={() => setEditing(false)} />
              </div>
            )}

            {reviewing && reviewLedger && (
              <SwitchReview
                ledger={reviewLedger}
                onClose={() => setReviewing(null)}
                onConfirm={() => { const verb = reviewing; setReviewing(null); act(verb); }}
              />
            )}

            {/* ── Attention banner: the latest run's flag, with its summary ── */}
            {(t.last_run_failed || t.last_run_needs_attention) && (
              <div
                className={`mt-4 rounded-lg border border-l-2 px-3.5 py-2.5 ${
                  t.last_run_failed
                    ? "border-sol-red/30 border-l-sol-red/70 bg-sol-red/5"
                    : "border-sol-orange/30 border-l-sol-orange/70 bg-sol-orange/5"
                }`}
              >
                <div className="flex items-center gap-1.5 text-meta font-medium">
                  <outcome.Icon className={`w-3.5 h-3.5 ${outcome.tone}`} />
                  <span className={outcome.tone}>Last run {outcome.word}</span>
                  {t.last_run_at && (
                    <span className="text-sol-text-dim font-normal">
                      · {fmtDuration(Math.max(0, now - t.last_run_at))} ago
                    </span>
                  )}
                </div>
                {t.last_run_summary && (
                  <p className="mt-1 text-meta leading-relaxed text-sol-text-muted">
                    {t.last_run_summary}
                  </p>
                )}
              </div>
            )}

            {/* ── Precheck: the gate that decides whether a firing spends a
                 session at all. Shown whenever one is set, because "this
                 trigger sometimes does nothing" is otherwise invisible — a
                 skipped firing leaves no session behind. ── */}
            {t.precheck && (
              <div
                data-testid="trigger-precheck"
                className="mt-4 rounded-lg border border-sol-border/40 bg-sol-bg-alt/20 px-3.5 py-2.5"
              >
                <div className="flex items-center gap-1.5 text-mark font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                  <ShieldCheck className="w-3.5 h-3.5" /> Precheck
                  {t.schedule_type === "event" && (
                    <span className="font-normal normal-case tracking-normal text-sol-text-dim/80">
                      · not run for event triggers
                    </span>
                  )}
                </div>
                <p className="mt-1.5 font-mono text-meta leading-relaxed text-sol-text break-all">
                  {t.precheck}
                </p>
                {/* What the gate does, as label and value rows. */}
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta">
                  <dt className="text-sol-text-dim">Exit 0</dt><dd className="text-sol-text-muted">Runs the trigger</dd>
                  <dt className="text-sol-text-dim">Other exit</dt><dd className="text-sol-text-muted">Skipped run</dd>
                  <dt className="text-sol-text-dim">Manual, event</dt><dd className="text-sol-text-muted">Not checked</dd>
                  {t.last_run_source === "manual" && (
                    <><dt className="text-sol-text-dim">Last run</dt><dd className="text-sol-text-muted">Manual, not checked</dd></>
                  )}
                </dl>
                {t.last_precheck_skip_at && (
                  <p className="mt-1.5 text-meta text-sol-yellow">
                    Last skipped {fmtDuration(Math.max(0, now - t.last_precheck_skip_at))} ago
                    {t.last_precheck_skip_reason ? ` — ${t.last_precheck_skip_reason}` : ""}
                  </p>
                )}
              </div>
            )}

            {/* ── Vitals ── */}
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              <StatCell
                label="Next fire"
                sub={
                  t.status === "scheduled" && t.run_at !== undefined
                    ? `${fmtClock(t.run_at)} · ${new Date(t.run_at).toLocaleDateString()}`
                    : undefined
                }
              >
                {t.status === "scheduled" && msUntil !== undefined ? (
                  <span className="tabular-nums text-sol-orange">
                    {msUntil > 0 ? `in ${fmtDuration(msUntil)}` : "due now"}
                  </span>
                ) : t.status === "running" ? (
                  <span className="text-sol-green">running now</span>
                ) : t.status === "paused" ? (
                  "paused"
                ) : eventLabel ? (
                  `on ${eventLabel}`
                ) : (
                  "—"
                )}
              </StatCell>
              <StatCell
                label="Cadence"
                sub={
                  cycleProgress !== null ? (
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-14 h-1 rounded-full bg-sol-bg-highlight overflow-hidden">
                        <span
                          className="block h-full rounded-full bg-sol-orange/70"
                          style={{ width: `${cycleProgress}%` }}
                        />
                      </span>
                      {cycleProgress}% of cycle
                    </span>
                  ) : undefined
                }
              >
                {describeTaskCadence(t)}
              </StatCell>
              <StatCell
                label="Runs"
                sub={
                  (t.retry_count ?? 0) > 0 ? (
                    <span className="text-sol-red">{t.retry_count} failed attempt{t.retry_count === 1 ? "" : "s"} in a row</span>
                  ) : undefined
                }
              >
                <span className="tabular-nums">{totalRuns}</span>
              </StatCell>
              <StatCell
                label="Last run"
                sub={t.last_run_at ? new Date(t.last_run_at).toLocaleString() : undefined}
              >
                {t.last_run_at ? (
                  <span className="inline-flex items-center gap-1.5">
                    <outcome.Icon className={`w-3.5 h-3.5 ${outcome.tone}`} />
                    <span className="tabular-nums">{fmtDuration(Math.max(0, now - t.last_run_at))} ago</span>
                  </span>
                ) : (
                  "never"
                )}
              </StatCell>
              <StatCell
                label="Where"
                sub={t.agent_type ? `agent: ${t.agent_type}` : undefined}
              >
                {projectName ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                    <Folder className="w-3.5 h-3.5 text-sol-text-dim" />
                    <span className="truncate">{projectName}</span>
                  </span>
                ) : (
                  "—"
                )}
              </StatCell>
            </div>

            {/* ── Body: runs timeline + the contract ── */}
            <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-5 min-w-0">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-mark font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                    Run history
                  </h2>
                  {runs && runs.length > 0 && (
                    <span className="text-meta text-sol-text-dim/70 tabular-nums">
                      {runs.length} recorded
                    </span>
                  )}
                </div>
                <div className="mt-2 rounded-lg border border-sol-border/40 bg-sol-bg-alt/20 px-3 py-2.5">
                  {runs === undefined ? (
                    <div className="py-3 text-meta text-sol-text-dim">Loading runs…</div>
                  ) : runs.length === 0 ? (
                    <div className="py-3 text-meta text-sol-text-dim">
                      No runs yet
                      {t.status === "scheduled" && msUntil !== undefined && msUntil > 0
                        ? ` — the first fires in ${fmtDuration(msUntil)}.`
                        : "."}
                    </div>
                  ) : (
                    <TriggerRunList runs={runs} now={now} ensureInboxRoute />
                  )}
                </div>
              </div>

              <div className="lg:col-span-7 min-w-0 space-y-5">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-mark font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                      Briefing
                    </h2>
                    {!brief && (
                      <button
                        disabled={summarizing}
                        onClick={() => {
                          setSummarizing(true);
                          regenerateSummary({ task_id: t._id }).catch(() => setSummarizing(false));
                        }}
                        className="text-meta text-sol-text-dim hover:text-sol-text transition-colors disabled:opacity-60"
                      >
                        {summarizing ? "Summarizing…" : "Summarize"}
                      </button>
                    )}
                  </div>
                  {/* The raw prompt is the contract each run receives — always
                      in view here; the page is the trigger's home. */}
                  <div className="mt-2 rounded-lg border border-sol-border/40 overflow-hidden">
                    <TriggerPromptView prompt={t.prompt} />
                  </div>
                </div>

                {(t.created_by_conversation_id || t.originating_conversation_id || t.last_run_conversation_id) && (
                  <div>
                    <h2 className="text-mark font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                      Sessions
                    </h2>
                    <div className="mt-1.5 rounded-lg border border-sol-border/40 bg-sol-bg-alt/20 px-3.5 py-2">
                      <SessionLink
                        label="created by"
                        id={t.created_by_conversation_id}
                        title={t.created_by_conversation_title}
                      />
                      {t.originating_conversation_id !== t.created_by_conversation_id && (
                        <SessionLink
                          label="runs inside"
                          id={t.originating_conversation_id}
                          title={t.originating_conversation_title}
                        />
                      )}
                      {t.last_run_conversation_id !== t.originating_conversation_id && (
                        <SessionLink
                          label="last run"
                          id={t.last_run_conversation_id}
                          title={t.last_run_conversation_title}
                        />
                      )}
                    </div>
                  </div>
                )}

                <div className="text-meta text-sol-text-dim flex items-center gap-3 flex-wrap">
                  <span>created {new Date(t.created_at).toLocaleString()}</span>
                  {t.max_runtime_ms !== undefined && <span>max runtime {fmtDuration(t.max_runtime_ms)}</span>}
                  {t.project_path && (
                    <ShortcutTooltip label={t.project_path}>
                      <span className="font-mono truncate max-w-[26rem]">{t.project_path}</span>
                    </ShortcutTooltip>
                  )}
                </div>
              </div>
            </div>
        </PageFrame>
      </DashboardLayout>
    </AuthGuard>
  );
}
