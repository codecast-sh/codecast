"use client";
// A step's instructions (line-journeys.md LJ8.6): what the step is told, and
// the way to change it. `Edit` is the one primary until there is an edit; then
// `Test this edit` (the edit run on past cases, nothing ships) and `Save`.
// `Ask an agent to change it` is always there and works from any machine, so
// a line saved elsewhere still has a way through: the panel names where it is
// saved and makes the ask the primary. A person's step reads its question as
// it was last asked, and its answers as a plain list.
import { useMemo, useState } from "react";
import type { LineModel, LineStep } from "../../../../lib/line/lineModel";
import { drawnWorkflowId } from "../../../../lib/line/lineActions";
import { promptDiff } from "../../../../lib/line/promptText";
import { visitDecision } from "../../../../lib/line/stepWork";
import { useGraphEditability } from "../../../../hooks/useLineActions";
import { useInboxStore } from "../../../../store/inboxStore";
import { LINE_ACTIONS, PromptDiffLines, PromptView } from "../../widgets";
import { setStepDraft, useStepDraft } from "../stepDrafts";

export type StepInstructionsProps = {
  model: LineModel;
  step: LineStep;
  /** Open in edit (a cause heading's Edit instructions, Replay's Edit). */
  editing: boolean;
  onEditing: (v: boolean) => void;
  /** The runs to test an edit on (a cause group's), else the step's own pick. */
  testRuns: string[] | null;
  /** Which panel is open under the text. */
  panel: "test" | "ask" | null;
  onPanel: (p: "test" | "ask" | null) => void;
  /** The projects an ask can be filed in, when the line shows no single one. */
  projects: ReadonlyArray<{ _id: string; title?: string | null }>;
};

export function StepInstructions({ model, step: s, editing, onEditing, testRuns, panel, onPanel, projects }: StepInstructionsProps) {
  const draft = useStepDraft(s.id);
  const dirty = !!s.prompt && draft != null && draft !== s.prompt.text;
  const diff = useMemo(() => (dirty && s.prompt ? promptDiff(s.prompt.text, draft!) : null), [dirty, s.prompt, draft]);
  const [showDiff, setShowDiff] = useState(false);
  const workflowId = drawnWorkflowId(model);
  const can = useGraphEditability(workflowId);
  // Saved on a machine this one cannot write to: the edit can still be drafted, tested there, and sent with an ask.
  const elsewhere = !!can && !can.editable;
  const Try = LINE_ACTIONS.Try;
  const Ask = LINE_ACTIONS.Ask;
  const Save = LINE_ACTIONS.Save;
  const reset = () => { setStepDraft(s.id, null); onEditing(false); setShowDiff(false); if (panel === "test") onPanel(null); };
  const noun = s.kind === "script" ? "command" : s.kind === "person" ? "question" : "instructions";

  return (
    <div className="sp-ins" data-line-step-instructions={s.id}>
      {s.kind === "person" && <Question step={s} />}

      {s.prompt ? (
        <>
          <div className="sp-ins-bar">
            <span className="sp-ins-what">
              {s.kind === "person" ? "The question as the line writes it" : `What ${s.label} is told`}
              {s.prompt.file && <code className="sp-ins-file">{s.prompt.file}</code>}
            </span>
            <span className="sp-ins-acts">
              {dirty && diff ? (
                <>
                  <span className="sp-ins-delta lw-num" data-line-prompt-dirty><b className="lw-plus-n">+{diff.added}</b> <b className="lw-minus-n">−{diff.removed}</b></span>
                  <button type="button" className="lw-link" aria-pressed={showDiff} onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide the change" : "Show the change"}</button>
                  <button type="button" className="lw-link" onClick={reset}>Discard</button>
                  {Try && !elsewhere && <button type="button" className="lw-act" aria-pressed={panel === "test"} onClick={() => onPanel(panel === "test" ? null : "test")} data-line-step-test>Test this edit</button>}
                  {elsewhere
                    ? <button type="button" className="lw-act" data-primary="" onClick={() => onPanel("ask")} data-line-step-ask-primary>Ask an agent to make this edit</button>
                    : Save && <Save model={model} step={s} draft={draft!} />}
                </>
              ) : editing ? (
                <button type="button" className="lw-act" onClick={() => onEditing(false)}>Done</button>
              ) : elsewhere ? (
                <>
                  <button type="button" className="lw-act" onClick={() => onEditing(true)} data-line-step-edit>Edit</button>
                  {Ask && <button type="button" className="lw-act" data-primary="" aria-pressed={panel === "ask"} onClick={() => onPanel(panel === "ask" ? null : "ask")} data-line-step-ask-primary>Ask an agent to change it</button>}
                </>
              ) : (
                <button type="button" className="lw-act" data-primary="" onClick={() => onEditing(true)} data-line-step-edit>Edit</button>
              )}
            </span>
          </div>
          {elsewhere && (
            <p className="sp-ins-where" data-line-step-elsewhere>
              <b>This line is saved on a teammate's machine,</b> so it is edited and tested there. Write your edit here and an agent makes it, with your edit as the change you propose.
            </p>
          )}
          {dirty && showDiff && <div className="lw-obj sp-ins-diff" data-flat=""><PromptDiffLines before={s.prompt.text} after={draft!} /></div>}
          <PromptView prompt={s.prompt} nodes={model.graph.nodes} text={draft} changed={diff?.changedAfter ?? null} editing={editing} onEdit={(text) => setStepDraft(s.id, text)} />
        </>
      ) : s.kind !== "person" ? (
        <div className="sp-none">The line names {s.label} without its {noun}, so there is nothing to read or edit here.</div>
      ) : null}

      {panel === "test" && Try && s.prompt && !elsewhere && (
        <section className="sp-ins-panel" data-line-step-panel="test">
          <h3>{dirty ? "Test this edit" : "Run it again"}</h3>
          <Try model={model} step={s} draft={dirty ? draft : null} runs={testRuns ?? undefined} />
        </section>
      )}
      {panel === "ask" && Ask && (
        <section className="sp-ins-panel" data-line-step-panel="ask">
          <h3>Ask an agent to change it</h3>
          <Ask model={model} step={s} draft={dirty ? draft : null} projects={projects} />
        </section>
      )}

      {s.kind !== "end" && (
        <div className="sp-ins-foot">
          {Ask && panel !== "ask" && !elsewhere && <button type="button" className="lw-link" onClick={() => onPanel("ask")} data-line-step-ask>Ask an agent to change it</button>}
          {Try && s.prompt && panel !== "test" && !dirty && !elsewhere && s.kind === "agent" && <button type="button" className="lw-link" onClick={() => onPanel("test")} data-line-step-rerun>Run it again on past cases</button>}
        </div>
      )}
    </div>
  );
}

type AskedRow = { _id: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number; question?: string; card?: { headline?: string } | null };

/** A person's step: the question as it was last really asked, and what each answer does. */
function Question({ step: s }: { step: LineStep }) {
  const newest = s.decisions[0] ?? null;
  const asked = useInboxStore((st) => {
    if (!newest) return "";
    const rows = st as unknown as { sessionDecisions?: Record<string, AskedRow>; lineCards?: Record<string, AskedRow> };
    const c = visitDecision([...Object.values(rows.sessionDecisions ?? {}), ...Object.values(rows.lineCards ?? {})], newest.runId, s.id, "any");
    return c?.question?.trim() || c?.card?.headline?.trim() || "";
  });
  return (
    <div className="sp-question" data-line-step-question>
      {asked && (
        <>
          <div className="sp-question-k">Last asked{newest?.caseRef ? ` on ${newest.caseRef}` : ""}</div>
          <p className="sp-question-q">{asked}</p>
        </>
      )}
      {s.answers.length > 0 && (
        <dl className="sp-answers" data-line-step-answers={s.answers.length}>
          {s.answers.map((a) => (
            <div key={a.answer}>
              <dt>{a.answer}</dt>
              <dd>{a.does ?? ""}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
