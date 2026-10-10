"use client";
// Ask an agent (line-workspace.md LW4): the person says what is wrong with the
// step; the labeled decisions go with it as examples, with every close the
// problem came back after presumed wrong (each removable), and an unsaved edit as
// the change they propose. It is filed as a cause against the line (LX6) and
// the project's line starts on it at once: an agent edits the prompt, replays
// the step on the labeled cases, and returns a card with before and after.
import { useMemo, useState } from "react";
import { askAgentFields, cameBackPattern, labeledCases, type AskCase } from "../../../../lib/line/lineActions";
import { useInboxStore } from "../../../../store/inboxStore";
import { taskStubId } from "../../../../store/taskStub";
import { backTimes, useLineNav } from "../parts";
import type { AskSlotProps } from "../actionSlots";
import "./actions.css";

const newClientKey = () => `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

type Sent = { key: string; result?: { task_id?: string; task_short_id?: string; started: boolean; reason?: string; role_handle?: string }; error?: string };

export function AskPanel({ model, step, draft }: AskSlotProps) {
  const nav = useLineNav();
  const projectId = nav.projectId ?? null;
  const all = useMemo(() => labeledCases(step), [step]);
  const pattern = useMemo(() => cameBackPattern(step), [step]);
  // The cases the person took out of the ask, by run.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const cases = useMemo(() => all.filter((c) => !dropped.has(c.runId)), [all, dropped]);
  // One chip per case: a case dissolved three times goes, or stays out, as one example of three runs.
  const chips = useMemo(() => {
    const by = new Map<string, { key: string; label: string; first: AskCase; runs: string[] }>();
    for (const c of all) {
      const label = c.caseRef ?? c.caseTitle;
      // Runs on one case group when they are the same kind of example: a case labeled right stays apart from its closes that came back.
      const key = `${label}:${c.cameBack ? "back" : c.verdict}`;
      const had = by.get(key);
      if (had) had.runs.push(c.runId);
      else by.set(key, { key, label, first: c, runs: [c.runId] });
    }
    return [...by.values()];
  }, [all]);
  const toggle = (runs: ReadonlyArray<string>) => setDropped((had) => {
    const next = new Set(had);
    const out = runs.every((r) => had.has(r));
    for (const r of runs) { if (out) next.delete(r); else next.add(r); }
    return next;
  });
  const [words, setWords] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  // The cause as the store paints it, then as the server row supersedes it.
  const task = useInboxStore((s) => {
    if (!sent) return null;
    const tasks = (s as any).tasks ?? {};
    return (sent.result?.task_id ? tasks[sent.result.task_id] : null) ?? tasks[taskStubId(sent.key)] ?? null;
  });
  const caseCount = new Set(cases.map((c) => c.caseRef ?? c.caseTitle)).size;
  const back = cases.filter((c) => c.cameBack).length;
  const wrong = cases.filter((c) => c.verdict === "wrong" && !c.cameBack).length;
  const can = !!projectId && (!!words.trim() || !!draft);

  const ask = async () => {
    if (!projectId) return;
    const fields = askAgentFields({ graphTitle: model.title, step, words, draft, cases });
    if (!fields) return;
    const key = newClientKey();
    setSent({ key });
    try {
      const result = await useInboxStore.getState().askLineAgent(key, projectId, fields);
      setSent({ key, result: result ?? undefined });
      setWords("");
    } catch (err) {
      setSent({ key, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="lw-ask" data-line-ask={step.id}>
      <label className="lw-ask-field">
        <span>What should change about {step.label}?</span>
        <textarea
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && can) { e.preventDefault(); void ask(); } }}
          rows={4}
          placeholder={pattern ?? `Say what ${step.label} gets wrong, in a sentence.`}
        />
      </label>
      <div className="lw-ask-goes">
        {cases.length > 0
          ? <span>Goes with {caseCount} {caseCount === 1 ? "case" : "cases"}{[back ? `${back} ${back === 1 ? "close" : "closes"} that came back, presumed wrong` : null, wrong ? `${wrong} marked wrong` : null].filter(Boolean).map((x) => `, ${x}`).join("")}: the agent checks its change against each.</span>
          : all.length > 0 ? <span>No cases go with the ask. Add one back below.</span>
          : <span>No labeled cases yet. Mark decisions right or wrong and they go with the ask as examples.</span>}
        {draft && <span>Your unsaved edit goes as the change you propose.</span>}
      </div>
      {all.length > 0 && (
        <div className="lw-ask-cases">
          {chips.map(({ key, label, first: c, runs }) => {
            const out = runs.every((r) => dropped.has(r));
            return (
              <span key={key} className="lw-ask-case" data-out={out ? "" : undefined} title={runs.length > 1 ? `${runs.length} runs on this case go with the ask` : c.note ?? c.decided}>
                <span className="lw-labelmark" data-verdict={c.verdict}>{c.cameBack ? `Came back ${backTimes(c.cameBackTotal ?? c.cameBack)}` : c.verdict === "right" ? "Right" : "Wrong"}</span>
                <span className="lw-ask-case-t">{label}{runs.length > 1 && <small> ×{runs.length}</small>}</span>
                <button type="button" className="lw-ask-case-x" onClick={() => toggle(runs)} aria-label={out ? `Add ${label} back` : `Leave ${label} out`} data-line-ask-case={key}>
                  {out ? "+" : "×"}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="lw-try-go">
        <button type="button" className="lw-act" data-primary="" onClick={ask} disabled={!can || (!!sent && !sent.result && !sent.error)}>
          Ask an agent
        </button>
        {!projectId && <span className="lw-try-fine">Open this step in its project's line to ask.</span>}
      </div>
      {sent && (
        <div className="lw-save-note" data-tone={sent.error || (sent.result && !sent.result.started) ? "warn" : "ok"} aria-live="polite">
          {sent.error ? `Not filed: ${sent.error}`
            : !sent.result ? `Filing ${task?.short_id && task.short_id !== "ct-…" ? task.short_id : "the ask"}…`
            : sent.result.started ? `Filed ${task?.short_id ?? sent.result.task_short_id}${sent.result.role_handle ? `; @${sent.result.role_handle}'s line is on it` : "; the line is on it"}. Its card comes back with before and after.`
            : `Filed ${task?.short_id ?? sent.result.task_short_id}, not started: ${sent.result.reason}`}
        </div>
      )}
    </div>
  );
}
