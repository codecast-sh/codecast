"use client";
// Where a thing on the line came from (ct-68152): one strip from the raw thing
// that happened (a contact's conversation, an error, a person's report) through
// the finding, the problem and its run to the decision, each step a link, then
// the raw thing itself opened in place (FindingReader, which draws the moment,
// the error group or the escalation). A decision no line run asked names the
// session that asked it and that session's task instead.
import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useTrackedStore } from "../../../store/inboxStore";
import { FindingReader, useFinderName, type ReaderSignal } from "./FindingReader";
import { MomentView } from "./MomentView";
import { useLineNav } from "./parts";
import { sourceName } from "../../../lib/line/sourceNames";
import "./originTrail.css";

export type OriginTrailProps = {
  /** A decision (its _id): its problem and run, or the session that asked it. */
  decision?: string | null;
  /** A problem (its task _id). */
  task?: string | null;
  /** A finding (its _id): the one opened, else the problem's newest. */
  signal?: string | null;
  /** A moment (mo-N) with no finding behind it yet. */
  moment?: string | null;
  /** Draw the strip only, with the raw thing folded until asked for. */
  folded?: boolean;
};

type Step = { key: string; label: string; ref?: string | null; href?: string | null; onOpen?: () => void; tone?: "raw" | "ask" };

const byNewest = (a: ReaderSignal, b: ReaderSignal) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at);

export const OriginTrail = memo(function OriginTrail({ decision, task: taskProp, signal: signalProp, moment, folded = false }: OriginTrailProps) {
  const nav = useLineNav();
  const who = useFinderName();
  // Wake on the fields drawn: the decision's state and its problem's title, never the whole collections.
  const taskOf = (st: any): any => { const t = taskProp ?? (decision ? st.sessionDecisions[decision]?.task_id : null); return t ? st.tasks[t] : null; };
  const s = useTrackedStore([
    (st) => { const x = decision ? (st.sessionDecisions as any)[decision] : null; return x ? `${x.status}|${x.task_id ?? ""}|${x.session_title ?? ""}` : null; },
    (st) => { const t = taskOf(st); return t ? `${t._id}|${t.title}|${t.short_id ?? ""}` : null; },
  ]);
  const d = decision ? ((s.sessionDecisions as any)[decision] ?? null) : null;
  const task = taskOf(s);
  const taskId: string | null = taskProp ?? d?.task_id ?? null;
  useSyncTaskSignals(taskId);
  const where = useMemo(() => (taskId ? (r: ReaderSignal) => r.task_id === taskId : signalProp ? (r: ReaderSignal) => r._id === signalProp : () => false), [taskId, signalProp]);
  const signals = useCollectionRows<ReaderSignal>("signals", { where, sig: (r) => `${r._id}|${r.task_id ?? ""}` });
  const sorted = useMemo(() => [...signals].sort(byNewest), [signals]);
  const finding = (signalProp ? sorted.find((x) => x._id === signalProp) : null) ?? sorted[0] ?? null;
  const momentRef = finding?.moment ?? moment ?? null;
  // Problems merged into this one: their findings came along (signals.folded_from).
  const merged = useMemo(() => new Set(signals.map((x) => (x as { folded_from?: string }).folded_from).filter(Boolean)).size, [signals]);
  const [open, setOpen] = useState(!folded);

  const line = !!(d?.workflow_run_id && d?.task_id) || (!d && !!taskId);
  const steps: Step[] = [];
  if (d && !line) {
    // A card a session asked: the session is the origin, its task beside it.
    steps.push({ key: "session", label: d.session_title || "A session", href: d.conversation_id ? `/conversation/${d.conversation_id}` : null, tone: "raw" });
    if (task) steps.push({ key: "task", label: task.title, ref: task.short_id, href: `/tasks/${task.short_id ?? taskId}` });
  } else {
    if (finding) {
      const raw = momentRef ? "Conversation" : finding.subject?.startsWith("eg-") ? "Error" : finding.source === "person" ? "Report" : sourceName(finding.source);
      steps.push({ key: "raw", label: raw, ref: momentRef ?? (finding.subject?.startsWith("eg-") ? finding.subject : null), tone: "raw", onOpen: () => setOpen(true) });
      steps.push({ key: "finding", label: who(finding), ref: finding.short_id, onOpen: () => setOpen(true) });
    } else if (moment) {
      steps.push({ key: "raw", label: "Conversation", ref: moment, tone: "raw", onOpen: () => setOpen(true) });
    }
    if (task) steps.push({ key: "problem", label: merged ? `Problem · ${merged + 1} merged` : "Problem", ref: task.short_id, href: nav.caseHref?.(taskId!) ?? null, onOpen: nav.openCase ? () => nav.openCase!(taskId!) : undefined });
    const runId = d?.workflow_run_id ?? null;
    if (runId) steps.push({ key: "run", label: "Run", href: nav.runHref(runId, taskId), onOpen: () => nav.openRun(runId, taskId) });
    if (d) steps.push({ key: "decision", label: d.status === "pending" ? "Asks you" : "Answered", ref: d.short_id, tone: d.status === "pending" ? "ask" : undefined });
  }
  if (!steps.length) return null;

  return (
    <section className="ot" data-origin-trail>
      <ol className="ot-steps" aria-label="Where it came from">
        {steps.map((st, i) => (
          <li key={st.key} className="ot-step" data-tone={st.tone}>
            {i > 0 && <span className="ot-arrow" aria-hidden>→</span>}
            {st.href || st.onOpen ? (
              st.href && !st.onOpen ? <Link href={st.href} className="ot-btn" data-origin-step={st.key}><StepFace st={st} /></Link> : (
                <a href={st.href ?? undefined} className="ot-btn" data-origin-step={st.key} onClick={(e) => { if (st.onOpen && !e.metaKey && !e.ctrlKey) { e.preventDefault(); st.onOpen(); } }}><StepFace st={st} /></a>
              )
            ) : <span className="ot-btn" data-static data-origin-step={st.key}><StepFace st={st} /></span>}
          </li>
        ))}
        {(finding || moment) && <li className="ot-step ot-toggle"><button type="button" className="ot-fold" aria-expanded={open} onClick={() => setOpen(!open)} data-origin-raw-toggle>{open ? "Hide" : "Show what happened"}</button></li>}
      </ol>
      {open && finding && <div className="ot-raw"><FindingReader signal={finding} open onToggle={() => setOpen(false)} who={who(finding)} /></div>}
      {open && !finding && moment && <div className="ot-raw"><MomentView moment={moment} /></div>}
    </section>
  );
});

function StepFace({ st }: { st: Step }) {
  return <>
    <span className="ot-label">{st.label}</span>
    {st.ref && <span className="ot-ref">{st.ref}</span>}
  </>;
}
