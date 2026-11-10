// A watch's fix as the metric page shows it: the header's one fix action and
// the stepper from the problem to a fix that held.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, RotateCcw, Wand2 } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { durationShort, stampLabel } from "./metricModel";
import { episodeSummary, type Episode } from "./metricEvents";
import { opsHref } from "./opsPaths";
import { StatusPill } from "./parts";
import { FixReview } from "./issueParts";
import { useIssueFix } from "./useIssueFix";
import { fixActionLabel, fixClose, fixStage, regressedAt, taskMatchesIssue } from "./issuesModel";
import { triage } from "./issueUndo";
import type { OpsGroup, OpsSource } from "./opsTypes";

/**
 * The header's one fix action, the issue page's plan (fixPlan) read the same
 * way: open the running fix, start one, start a follow-up when a closed fix
 * did not hold, refile a dropped problem, or resolve an issue whose fix held.
 * `f` presses it (`e` for resolve).
 */
export function FixAction({ group, source, stage, now }: { group: OpsGroup; source?: OpsSource; stage: ReturnType<typeof fixStage>; now: number }) {
  const router = useRouter();
  const { task, plan } = useIssueFix(group, stage, now);
  const [fixing, setFixing] = useState(false);
  const primary = group.status === "ignored" ? null : plan.primary;
  const reopenTask = () => task?.short_id && void useInboxStore.getState().updateTask(task.short_id, { status: "open" });
  const press = (): boolean => {
    if ((primary === "open" || primary === "continue") && plan.live) router.push(`/conversation/${plan.live}`);
    else if (primary === "start" || primary === "followup") setFixing(true);
    else if (primary === "refile") reopenTask();
    else if (primary === "resolve") triage([group], "resolved");
    else return false;
    return true;
  };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal() || fixing) return;
      if (e.key === "f" && primary !== "resolve" && press()) e.preventDefault();
      else if (e.key === "e" && primary === "resolve" && press()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, plan.live, fixing, group, task?.short_id]);
  if (!primary) return null;
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, group.title);
  const label = fixActionLabel(primary, task?.short_id, mismatch) ?? "Start fix";
  const Icon = primary === "resolve" ? Check : primary === "refile" ? RotateCcw : Wand2;
  return (
    <>
      <button type="button" className="ops-btn" data-tone="primary" onClick={press} data-watch-fix={primary}>
        <Icon className="w-3.5 h-3.5" />{label}<KeyCap size="xs" tone="onAccent">{primary === "resolve" ? "e" : "f"}</KeyCap>
      </button>
      {primary === "refile" && <button type="button" className="ops-btn" onClick={() => setFixing(true)} data-watch-fix-start><Wand2 className="w-3.5 h-3.5" />Start fix</button>}
      {fixing && <FixReview groups={[group]} source={source} onClose={() => setFixing(false)} onStarted={() => setFixing(false)} />}
    </>
  );
}

type StepState = "done" | "now" | "todo" | "bad";

/**
 * The alert's issue and its fix in one card: the issue, its state and its
 * episodes over the watch's whole life, then the fix as a stepper (filed,
 * session, closed or shipped, then resolved, or recurred when the fix did
 * not hold). Each step that happened links to its object.
 */
export function FixPanel({ group, source, stage, episodes, now }: { group: OpsGroup; source?: OpsSource; stage: ReturnType<typeof fixStage>; episodes: Episode[]; now: number }) {
  const { task, sessions, plan } = useIssueFix(group, stage, now);
  const [fixing, setFixing] = useState(false);
  // The step the alert waits on carries its action: no session yet, so the Session row starts one.
  const canStart = group.status !== "ignored" && (plan.primary === "start" || plan.primary === "followup");
  const session = plan.live ?? group.fix_conversation_id ?? sessions[0]?.id ?? null;
  const resolved = group.status === "resolved";
  const close = fixClose(group, task ?? undefined);
  const recurred = stage === "recurring" ? regressedAt(group) ?? group.last_transition_at ?? group.last_seen : null;
  const all = episodeSummary(episodes, { from: 0, to: now }, now);
  const first = episodes[0]?.from;
  const closeStep = task?.landed
    ? { label: "Shipped", ref: task.landed.sha.slice(0, 7), href: task.landed.url, external: true, sub: relTimeShort(task.landed.at, now) }
    : close && close.how !== "dissolved" && close.how !== "dropped"
      ? { label: close.how === "resolved" ? "Resolved" : "Closed", ref: close.how === "resolved" ? "by hand" : task?.short_id ?? "task", href: close.how === "resolved" ? opsHref.issue(group.short_id) : `/tasks/${task?.short_id ?? group.signal_task_id}`, sub: close.at ? relTimeShort(close.at, now) : undefined }
      : null;
  const steps: { key: string; label: string; state: StepState; ref?: string; href?: string; external?: boolean; sub?: string }[] = [
    {
      key: "filed", label: "Filed", state: group.signal_task_id ? "done" : "todo",
      ...(group.signal_task_id ? { ref: task?.short_id ?? "task", href: `/tasks/${task?.short_id ?? group.signal_task_id}`, sub: task?.status?.replace("_", " ") } : {}),
    },
    {
      key: "session", label: "Session", state: session ? (plan.live && !closeStep ? "now" : "done") : "todo",
      ...(session ? { ref: plan.live ? "running" : "opened", href: `/conversation/${session}`, sub: group.fix_started_at ? relTimeShort(group.fix_started_at, now) : undefined } : {}),
    },
    { key: "shipped", state: closeStep ? "done" : "todo", ...(closeStep ?? { label: "Shipped" }) },
    recurred !== null
      ? { key: "recurred", label: "Recurred", state: "bad", ref: `${relTimeShort(recurred, now)} ago`, href: opsHref.issue(group.short_id), sub: stampLabel(recurred) }
      : {
        key: "resolved", label: "Resolved", state: resolved ? "done" : "todo",
        ...(resolved ? { ref: group.short_id, href: opsHref.issue(group.short_id), sub: group.resolved_in ? `in ${group.resolved_in}` : group.resolved_at ? relTimeShort(group.resolved_at, now) : undefined } : {}),
      },
  ];
  return (
    <div className="ops-card mt-3.5 mx-fix" data-watch-fixcard data-stage={stage}>
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2 mx-fix-id">
          Issue
          <Link href={opsHref.issue(group.short_id)} className="ops-mono font-normal hover:underline">{group.short_id}</Link>
          <StatusPill status={group.status} failing={group.meta?.ok === undefined ? undefined : !group.meta.ok} />
        </span>
        <span className="ops-num ops-dim font-normal text-[11.5px] mx-fix-sum" data-watch-episodes={all.count} title={first ? `since ${stampLabel(first)}` : undefined}>
          {all.count ? `${all.count} ${all.count === 1 ? "episode" : "episodes"} · ${durationShort(all.total)} alerting` : "no episodes"}
        </span>
      </div>
      {task?.title && <Link href={`/tasks/${task.short_id ?? group.signal_task_id}`} className="mx-fix-title" title={task.title}>{task.title}</Link>}
      <ol className="mx-steps">
        {steps.map((st) => (
          <li key={st.key} data-state={st.state} data-step={st.key}>
            <i aria-hidden>{st.state === "done" ? <Check className="w-2.5 h-2.5" /> : st.state === "bad" ? <AlertTriangle className="w-2.5 h-2.5" /> : null}</i>
            <span className="mx-step-label">{st.label}</span>
            {st.key === "session" && !session && canStart ? (
              <button type="button" className="mx-step-action" onClick={() => setFixing(true)} data-watch-step-start><Wand2 className="w-3 h-3" />{plan.primary === "followup" ? "Start follow-up" : "Start fix"}</button>
            ) : st.ref && st.href ? (
              st.external ? <a href={st.href} target="_blank" rel="noreferrer" className="ops-mono hover:underline">{st.ref}</a> : <Link href={st.href} className="ops-mono hover:underline">{st.ref}</Link>
            ) : <span className="ops-dim">–</span>}
            {st.sub && <span className="ops-dim mx-step-sub">{st.sub}</span>}
          </li>
        ))}
      </ol>
      {fixing && <FixReview groups={[group]} source={source} onClose={() => setFixing(false)} onStarted={() => setFixing(false)} />}
    </div>
  );
}
