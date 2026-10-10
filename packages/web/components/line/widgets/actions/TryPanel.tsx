"use client";
// Try (line-workspace.md LW4): the step's text, edited or as it stands, run on
// past cases it decided, on the machine that pushed the graph, in a sandbox
// where every write is refused. Pick the cases (the ones marked wrong first),
// run, and each answer lands beside the old one as it settles. Nothing ships
// from a try. A case the problem came back after is picked first and its
// result says whether the step still closes it the same way: the change that
// does is the fix already tried.
import { useMemo, useState } from "react";
import type { LineStep } from "../../../../lib/line/lineModel";
import { cameBackTryResult, cameBackTryWords, caseChanged, decisionAnswer, defaultTryPick, drawnWorkflowId, oncePerCase, triedCameBack, triesOf, tryCandidates, tryCaseWords, type LineTry } from "../../../../lib/line/lineActions";
import { decisionKey } from "../../../../lib/line/lineModel";
import { promptDiff } from "../../../../lib/line/promptText";
import { useInboxStore } from "../../../../store/inboxStore";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useGraphEditability, useLineTries } from "../../../../hooks/useLineActions";
import { BeforeAfterTable, type BeforeAfterRow } from "../BeforeAfterTable";
import { DecisionSaid } from "../DecisionCard";
import { DecisionTag, dayWords, useLineNav } from "../parts";
import type { TrySlotProps } from "../actionSlots";
import "./actions.css";

const DEFAULT_PICK = 3;

const newTryId = () => `try_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const money = (usd: number) => (usd >= 0.995 ? `$${usd.toFixed(2)}` : `${Math.max(1, Math.round(usd * 100))}¢`);

export function TryPanel({ model, step, draft, runs }: TrySlotProps) {
  const nav = useLineNav();
  const projectId = nav.projectId ?? null;
  const workflowId = drawnWorkflowId(model);
  const can = useGraphEditability(workflowId);
  const rows = useLineTries(projectId);
  const now = useCoarseNow(30_000);
  const tries = useMemo(() => triesOf(rows, step.id, now), [rows, step.id, now]);
  // One row per case: a case run several times is tried once, on its newest run (or the run asked for).
  const candidates = useMemo(() => (runs?.length ? oncePerCase(step.decisions.filter((d) => runs.includes(d.runId))) : tryCandidates(step)), [step, runs]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = useMemo(() => picked ?? defaultTryPick(candidates, DEFAULT_PICK), [picked, candidates]);
  const text = draft ?? step.prompt?.text ?? "";
  const diff = useMemo(() => (draft && step.prompt ? promptDiff(step.prompt.text, draft) : null), [draft, step.prompt]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (runId: string) => setPicked((p) => {
    const cur = p ?? chosen;
    return cur.includes(runId) ? cur.filter((r) => r !== runId) : [...cur, runId];
  });

  const start = async () => {
    if (!workflowId || !chosen.length) return;
    setError(null);
    const base = can && can.editable ? can.nodes.find((n) => n.id === step.id)?.h ?? null : null;
    try {
      await useInboxStore.getState().tryLineStep(newTryId(), workflowId, { node: step.id, text, runs: chosen, base_hash: base, base_text: step.prompt?.text ?? null, project_id: projectId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!step.prompt) return <div className="lw-empty"><b>Nothing to try</b>The graph names this step without its prompt.</div>;

  return (
    <div className="lw-try" data-line-try={step.id}>
      <div className="lw-try-what">
        {diff ? (
          <span>Your edit <span className="lw-plus-n">+{diff.added}</span> <span className="lw-minus-n">−{diff.removed}</span></span>
        ) : (
          <span>The prompt as it stands: a run shows whether the step decides the same twice</span>
        )}
      </div>

      {can && !can.editable ? (
        <div className="lw-empty"><b>This graph runs on another machine</b>{can.reason}</div>
      ) : candidates.length === 0 ? (
        <div className="lw-empty"><b>No past cases yet</b>A try replays decisions the step already made; none has finished here.</div>
      ) : (
        <>
          <div className="lw-try-cases" role="group" aria-label="Cases to try it on">
            {candidates.map((d) => {
              const on = chosen.includes(d.runId);
              const back = cameBackTryWords(d);
              return (
                <label key={d.id} className="lw-try-case" data-on={on ? "" : undefined} data-came-back={back ? "" : undefined}>
                  <input type="checkbox" checked={on} onChange={() => toggle(d.runId)} />
                  <span className="lw-try-case-t">
                    <b>{d.caseTitle}</b>
                    {back && <span className="lw-try-back" title={d.closed?.words ?? undefined}>{back}</span>}
                    <small>
                      {d.caseRef && <>{d.caseRef} · </>}
                      {/* The came-back line above already says it came back: the tag here is only what it decided. */}
                      <DecisionTag d={d} backTag={!back} /><span className="lw-try-case-said"><DecisionSaid d={d} /></span>
                    </small>
                  </span>
                  {d.label && <span className="lw-labelmark" data-verdict={d.label.verdict}>{d.label.verdict === "right" ? "Right" : "Wrong"}</span>}
                </label>
              );
            })}
          </div>
          <div className="lw-try-go">
            <button type="button" className="lw-act" data-hot="" onClick={start} disabled={!workflowId || !chosen.length || can === undefined}>
              {draft ? "Try the edit" : "Run again"} on {chosen.length} {chosen.length === 1 ? "case" : "cases"}
            </button>
            <span className="lw-try-fine">Each case runs as the step would, on the machine that pushed the graph. Every write it attempts is refused; nothing ships.</span>
          </div>
          {error && <div className="lw-save-note" data-tone="bad">{error}</div>}
        </>
      )}

      {tries.map((t, i) => <TryResult key={t.id} t={t} step={step} open={i === 0} />)}
    </div>
  );
}

function TryResult({ t, step, open: initiallyOpen }: { t: LineTry; step: LineStep; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const byRun = useMemo(() => new Map(step.decisions.map((d) => [d.runId, d])), [step.decisions]);
  const rows: BeforeAfterRow[] = useMemo(() => t.cases.map((c) => {
    const d = byRun.get(c.run_id);
    const settledNoAnswer = c.status === "not_tryable" || c.status === "failed" || (c.status === "done" && !c.new);
    const changed = caseChanged(c);
    // A close the problem came back after was wrong, as surely as a label saying so: closing it the same way again is worse.
    const back = d ? triedCameBack(d) : 0;
    const wrong = d?.label ? d.label.verdict === "wrong" : back > 0;
    const verdict = (d?.label || back) && changed !== null
      ? (wrong ? (changed ? "better" : "worse") : changed ? "worse" : null)
      : null;
    const backWords = back && d ? `came back ${back === 1 ? "once" : `${back}x`}, ${cameBackTryResult(decisionKey(d), changed) ?? "waiting for its answer"}` : null;
    const note = [backWords, d?.label ? `marked ${d.label.verdict}` : null, c.via === "checkpoint" ? "from its checkpoint" : null, c.older_text ? "ran an older text" : null, c.refused?.length ? `${c.refused.length} ${c.refused.length === 1 ? "write" : "writes"} refused` : null].filter(Boolean).join(" · ");
    return {
      id: c._id,
      caseTitle: d?.caseTitle ?? c.run_id,
      caseRef: d?.caseRef ?? null,
      note: note || null,
      before: c.old && (c.old.result || c.old.words) ? decisionAnswer(c.old) : { outcome: d?.decided.outcome ?? null, words: d?.decided.words ?? "" },
      after: c.status === "done" && c.new ? decisionAnswer(c.new) : null,
      afterNote: settledNoAnswer ? tryCaseWords(c) : c.status === "queued" && t.stalled ? "Not picked up" : null,
      verdict,
    };
  }), [t, byRun]);
  const meta = [dayWords(t.at), t.cost > 0 ? money(t.cost) : null].filter(Boolean).join(" · ");
  // The came-back cases, said first: whether the edit still closes them the way that did not hold.
  const backRows = t.cases.flatMap((c) => {
    const d = byRun.get(c.run_id);
    return d && triedCameBack(d) ? [{ d, changed: caseChanged(c) }] : [];
  });
  const stillSame = backRows.filter((r) => r.changed === false).length;
  const answered = backRows.filter((r) => r.changed !== null).length;
  const verb = backRows.length ? cameBackTryResult(decisionKey(backRows[0].d), false)?.replace(/^still /, "") : null;
  const backLine = !backRows.length ? null
    : answered < backRows.length ? `${answered} of ${backRows.length} came-back ${backRows.length === 1 ? "case" : "cases"} answered`
    : stillSame === 0 ? `None of the ${backRows.length === 1 ? "came-back case" : `${backRows.length} came-back cases`} ${verb ? verb.replace(/s it$/, "") : "closes the same way"} it again`
    : `${stillSame} of ${backRows.length} came-back ${backRows.length === 1 ? "case" : "cases"} still ${verb ?? "closes it the same way"}: the edit repeats the fix that did not hold`;
  if (!open) {
    return (
      <button type="button" className="lw-try-past" onClick={() => setOpen(true)}>
        <span>Try {meta}</span>
        <span>{t.done ? `${t.changed} decided differently, ${t.same} the same` : `${t.settled} of ${t.cases.length} answered`}{backLine ? `; ${backLine.charAt(0).toLowerCase()}${backLine.slice(1)}` : ""}</span>
      </button>
    );
  }
  return (
    <div className="lw-try-result">
      {t.stalled && <div className="lw-save-note" data-tone="warn">{t.stalled}</div>}
      {backLine && <div className="lw-try-backline" data-tone={answered === backRows.length ? (stillSame ? "bad" : "ok") : undefined} data-try-came-back>{backLine}.</div>}
      <BeforeAfterTable rows={rows} title={`Tried ${meta}`} beforeLabel="It decided" afterLabel="With the edit" />
    </div>
  );
}
