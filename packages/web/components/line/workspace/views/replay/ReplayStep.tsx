"use client";
// Replay's step panel (line-workspace.md LW1), ported from the prototype's
// inspector: the step under the playhead, what it decided first (its outcome
// among those it could have given, its words, its reasoning folded), then its
// prompt with both ways to change it, then what it was handed. An agent's
// decision can be marked wrong here, with what it should have said; that label
// is the step's test set (LW4). Re-running the case from this step tries the
// step's prompt, with the person's edit when there is one, on this one case,
// and shows the new decision beside the old.
import { useMemo, useState } from "react";
import { ArrowRight, RotateCcw, Square } from "lucide-react";
import { decisionId, decisionKey, type LineModel, type LineRunModel, type LineStep, type LineVisit } from "../../../../../lib/line/lineModel";
import { stepOutcomes, wrongNote } from "../../../../../lib/line/replay";
import { promptSections } from "../../../../../lib/line/promptText";
import { useStationInput } from "../../../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../../../store/inboxStore";
import { outcomeToneClass } from "../../../RunReport";
import { CameBackTag, LINE_ACTIONS, PromptView, ResultFields, closedTone, durationWords, outcomeTone, outcomeWords } from "../../../widgets";
import { requestDrawerTab, takeMarkRequest, useMarkRequest, useStepDraft } from "../../stepDrafts";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";

const KIND_LINE = { agent: "Agent", script: "Script", person: "You decide", end: "End" } as const;

export type ReplayStepProps = {
  model: LineModel;
  run: LineRunModel;
  visit: LineVisit;
  /** Open a step in the drawer (the workspace selection). */
  openStep: (stepId: string) => void;
  onNext: () => void;
  onJump: (index: number) => void;
  /** The case is being re-run from this step. */
  rerunning: boolean;
  setRerunning: (on: boolean) => void;
};

/** The section of a prompt that says how the step decides: one titled for its decision or report, else the first. */
function decisionSection(text: string) {
  const secs = promptSections(text);
  return secs.find((s) => /decision|decide|report|outcome|verdict/i.test(s.title)) ?? secs[0] ?? null;
}

/** A command with its inserted values set apart. */
function Command({ text }: { text: string }) {
  const parts = text.split(/(\$[\w.]+)/g);
  return <pre className="lw-cmd rp-cmd">{parts.map((p, i) => (i % 2 ? <span key={i} className="rp-var">{p}</span> : p))}</pre>;
}

/** What a station was handed, in full: read only once someone opens it. */
function StationBrief({ sessionId, runId }: { sessionId: string; runId: string }) {
  const brief = useStationInput(sessionId, runId);
  if (brief === undefined) return <p className="rp-quiet"><span className="lw-spin" aria-hidden /> Reading its brief</p>;
  if (!brief?.found) return <p className="rp-quiet">Its brief is not readable here.</p>;
  return (
    <>
      <pre className="rp-brief">{brief.text}</pre>
      {brief.truncated && <p className="rp-quiet">The brief goes on; <a href={`/conversation/${sessionId}`}>its session</a> holds the rest.</p>}
    </>
  );
}

function Received({ visit, runId }: { visit: LineVisit; runId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rp-card rp-inputs" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><h3><span className="lw-chev" aria-hidden />What it was handed</h3><span className="rp-sum-lead">{visit.received.summary}</span></summary>
      <div className="rp-inputs-body">
        <p className="rp-handed">{visit.received.summary}</p>
        {open && visit.received.sessionId && <StationBrief sessionId={visit.received.sessionId} runId={runId} />}
        {visit.received.href && <a className="lw-link" href={visit.received.href}>Open its session</a>}
      </div>
    </details>
  );
}

function MarkBox({ outcomes, current, onCancel, onSave }: { outcomes: string[]; current: string | null; onCancel: () => void; onSave: (should: string | null, why: string) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const others = outcomes.filter((o) => o !== current);
  return (
    <div className="rp-markbox" data-replay-markbox>
      <h4>What should it have decided?</h4>
      <div className="rp-opts">
        {others.map((o) => <button key={o} type="button" className="rp-opt" aria-pressed={pick === o} onClick={() => setPick(o)}>{outcomeWords(o)}</button>)}
        {current && <button type="button" className="rp-opt" aria-pressed={pick === current} onClick={() => setPick(current)}>{outcomeWords(current)}, for the wrong reason</button>}
      </div>
      <textarea className="rp-note" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why, in a line (optional)" rows={2} autoFocus={!others.length} />
      <div className="rp-row">
        <span className="lw-spacer" />
        <button type="button" className="lw-act" onClick={onCancel}>Cancel</button>
        <button type="button" className="lw-act" data-primary="" disabled={!pick && !why.trim()} onClick={() => onSave(pick === current ? null : pick, pick === current && !why.trim() ? "Right outcome, wrong reason." : why)}>Add to the test set</button>
      </div>
    </div>
  );
}

function PromptCard({ step, openStep, onRerun, rerunning }: { step: LineStep; openStep: (id: string) => void; onRerun: (() => void) | null; rerunning: boolean }) {
  const draft = useStepDraft(step.id);
  const prompt = step.prompt!;
  const text = draft ?? prompt.text;
  const sec = useMemo(() => decisionSection(text), [text]);
  const lines = text.split("\n").length;
  const edit = () => { requestDrawerTab(step.id, "prompt", { edit: true }); openStep(step.id); };
  const read = () => { requestDrawerTab(step.id, "prompt"); openStep(step.id); };
  const ask = () => { requestDrawerTab(step.id, "ask"); openStep(step.id); };
  return (
    <div className="rp-card rp-prompt" data-replay-prompt>
      <div className="rp-card-head">
        <h3>Prompt</h3>
        <span className="rp-file">{prompt.file?.split("/").pop() ?? "in the graph"}{prompt.version ? ` · ${prompt.version.hash.slice(0, 6)}` : ""}</span>
        {draft != null && draft !== prompt.text && <span className="rp-dirty">your edit</span>}
        <span className="lw-spacer" />
        {LINE_ACTIONS.Ask && <button type="button" className="lw-act" onClick={ask}>Ask an agent</button>}
        <button type="button" className="lw-act" onClick={edit}>{draft != null ? "Open your edit" : "Edit"}</button>
        {/* The one filled action, in the drawer's Try color: re-running the case is Try on one case. */}
        {onRerun && !rerunning && <button type="button" className="lw-act rp-go" data-hot="" onClick={onRerun} data-replay-rerun><RotateCcw className="w-3.5 h-3.5" />Re-run this case from here</button>}
      </div>
      {sec && <div className="rp-sec-name">{sec.title}</div>}
      <div className="lw-peek rp-peek" role="button" tabIndex={0} onClick={read} onKeyDown={(e) => { if (e.key === "Enter") read(); }} title="Read the whole prompt">
        <PromptView prompt={prompt} text={sec?.body ?? text} layout="flat" />
      </div>
      <button type="button" className="lw-link rp-more" onClick={read}>The whole prompt, {lines} lines</button>
    </div>
  );
}

export function ReplayStep({ model, run, visit: v, openStep, onNext, onJump, rerunning, setRerunning }: ReplayStepProps) {
  const step = model.steps[v.node];
  const [marking, setMarking] = useState(false);
  // The Timeline asked to mark this decision wrong (a close that did not hold): open the box, once.
  const markAsk = useMarkRequest();
  useWatchEffect(() => {
    if (!markAsk || markAsk.run !== run.id || markAsk.step !== v.node) return;
    takeMarkRequest(markAsk.n);
    if (markAsk.mark) setMarking(true);
  }, [markAsk, run.id, v.node]);
  const decision = useMemo(() => step?.decisions.find((d) => d.id === decisionId(run.id, v.node)) ?? null, [step, run.id, v.node]);
  const outcomes = useMemo(() => (step ? stepOutcomes(model, step) : []), [model, step]);
  const draft = useStepDraft(v.node);
  if (!step) return <div className="lw-empty"><b>{v.label}</b>This step is not in the graph drawn here.</div>;

  const k = step.kind;
  const Try = LINE_ACTIONS.Try;
  const label = decision?.label ?? null;
  const mineWrong = label?.mine && label.verdict === "wrong";
  const took = durationWords(v.durationMs);
  const facts = [k === "agent" && step.model ? `${KIND_LINE[k]} · ${step.model}` : KIND_LINE[k], took && v.status !== "waiting" ? took : null, v.inferred ? "an earlier round" : null].filter(Boolean).join(" · ");
  const newest = v.inferred ? run.visits.reduce((j, x, i) => (x.node === v.node && !x.inferred ? i : j), -1) : -1;
  const said = v.decided.words;
  const why = v.why && v.why.trim() !== said.trim() ? v.why : null;
  // A session cut off (killed, timed out) decided nothing: there is nothing to grade.
  const cutOff = !v.inferred && decisionKey(v) === "cut off";
  const canLabel = !v.inferred && !cutOff && (k === "agent" || k === "person") && v.status !== "live" && v.status !== "waiting";
  const label_ = (verdict: "right" | "wrong" | null, note?: string) => useInboxStore.getState().labelDecision(run.id, v.node, verdict, note ?? null);
  const nextVisit = run.visits[v.index + 1];
  const canRerun = !!Try && k === "agent" && !!step.prompt && step.prompt.kind === "prompt" && !v.inferred && v.status !== "live";

  return (
    <div className="rp-ins" data-replay-step={v.node}>
      {rerunning && Try && (
        <div className="rp-branch" data-replay-branch>
          <RotateCcw className="w-3.5 h-3.5" aria-hidden />
          <span>Re-running {step.label} on this case {draft != null && draft !== step.prompt?.text ? "with your edit" : "as the prompt stands"}</span>
          <span className="lw-spacer" />
          <button type="button" onClick={() => setRerunning(false)}>Close</button>
        </div>
      )}
      <div className="rp-step-head">
        <div className="rp-big-glyph" data-kind={k} aria-hidden />
        <div className="rp-step-title">
          <div className="rp-kind-line">{facts}</div>
          <h1>
            {step.label}
            {label && <span className="lw-labelmark" data-verdict={label.verdict} title={label.note ?? undefined}>{label.verdict === "wrong" ? "marked wrong" : "marked right"}{label.byName && !label.mine ? ` by ${label.byName}` : ""}</span>}
          </h1>
          <p className="rp-does">{step.purpose}</p>
        </div>
        {cutOff && !label && (k === "agent" || k === "person") && <p className="rp-nograde" data-replay-cutoff>The session was cut off; nothing to grade.</p>}
        {canLabel && !label && (
          <div className="rp-step-actions">
            {decision?.closed && !decision.closed.held && <span className="rp-suspect" title={decision.closed.words ?? undefined}>Came back, likely wrong</span>}
            <button type="button" className="lw-act" onClick={() => label_("right")} title="Add this decision to the step's test set as right">Right</button>
            <button type="button" className="lw-act rp-wrongbtn" aria-pressed={marking} onClick={() => setMarking((m) => !m)} data-replay-mark>Mark wrong</button>
          </div>
        )}
      </div>

      {label && (
        <div className="rp-marked" data-verdict={label.verdict}>
          <span className="rp-marked-l">{label.verdict === "wrong" ? "Wrong" : "Right"}</span>
          <span className="rp-marked-b">{label.note ?? (label.verdict === "wrong" ? "No note." : "In the step's test set.")}</span>
          {label.mine && <button type="button" className="lw-act" onClick={() => label_(null)}>{mineWrong ? "Unmark" : "Take back"}</button>}
        </div>
      )}
      {marking && !label && (
        <MarkBox
          outcomes={outcomes}
          current={v.decided.outcome}
          onCancel={() => setMarking(false)}
          onSave={(should, note) => { label_("wrong", wrongNote(should, note)); setMarking(false); }}
        />
      )}

      {v.inferred && (
        <div className="rp-hint">
          <span>This is an earlier round of a loop. The run keeps what a step decided only for its newest visit.</span>
          {newest >= 0 && <button type="button" className="lw-act" onClick={() => onJump(newest)}>Go to the newest</button>}
        </div>
      )}

      <div className="rp-flow">
        {k === "agent" && (
          <>
            {rerunning && Try ? (
              <div className="rp-compare">
                <div className="rp-card">
                  <h3>Before, what ran</h3>
                  <div className="rp-decided"><span className="rp-outcome" data-tone={outcomeTone(v.decided.outcome ?? said, v.status)} data-strike="">{outcomeWords(v.decided.outcome, v.status)}</span></div>
                  <p className="rp-why">{said}</p>
                </div>
                <div className="rp-card rp-after" data-replay-after>
                  <h3>After, re-run now</h3>
                  <Try model={model} step={step} draft={draft != null && draft !== step.prompt?.text ? draft : null} runs={[run.id]} />
                </div>
              </div>
            ) : (
              <div className="rp-card rp-dec" data-replay-decided>
                <h3>Decided</h3>
                <div className="rp-decided">
                  <span className="rp-outcome" data-tone={closedTone(decision?.closed) ?? outcomeTone(v.decided.outcome ?? said, v.status)}>
                    {v.status === "live" && <span className="lw-spin" aria-hidden />}
                    {outcomeWords(v.decided.outcome, v.status)}
                  </span>
                  <CameBackTag closed={decision?.closed} />
                  {outcomes.length > 1 && (
                    <span className="rp-of">could have said {outcomes.map((o) => <code key={o} data-is={o === v.decided.outcome ? "" : undefined}>{outcomeWords(o)}</code>)}</span>
                  )}
                </div>
                {v.inferred ? null : <p className="rp-why">{said}</p>}
                {v.decided.result && Object.keys(v.decided.result).some((f) => f !== "outcome" && f !== "summary") && (
                  <details className="rp-more"><summary>What it reported</summary><ResultFields result={v.decided.result} /></details>
                )}
                {why && <details className="rp-more"><summary>Its reasoning</summary><p className="lw-reason">{why}</p></details>}
              </div>
            )}
            {step.prompt && step.prompt.kind === "prompt" && <PromptCard step={step} openStep={openStep} onRerun={canRerun ? () => setRerunning(true) : null} rerunning={rerunning} />}
          </>
        )}

        {k === "person" && (
          <>
            <div className="rp-card">
              <h3>Asked</h3>
              {step.prompt ? <div className="rp-asked"><PromptView prompt={step.prompt} layout="flat" /></div> : <p className="rp-why">{v.received.summary}</p>}
            </div>
            <div className="rp-card">
              <h3>{v.status === "waiting" ? "Waiting" : "Answered"}</h3>
              <div className="rp-decided">
                <span className="rp-outcome" data-tone="person">{v.status === "waiting" ? "waiting for an answer" : v.decided.toWords ?? outcomeWords(v.decided.outcome, v.status)}</span>
                {step.answers.length > 1 && <span className="rp-of">of {step.answers.map((a) => <code key={a.answer} data-is={a.answer === v.decided.toWords ? "" : undefined}>{a.answer}</code>)}</span>}
              </div>
              {why && <p className="lw-reason">{why}</p>}
              {took && v.durationMs != null && v.durationMs > 60_000 && <p className="rp-of">Waited {took} for a person.</p>}
            </div>
          </>
        )}

        {(k === "script" || k === "end") && (
          <div className="rp-card">
            <h3>{k === "end" ? "Ended" : "Ran"}</h3>
            {step.prompt?.kind === "script" && <Command text={step.prompt.text} />}
            <div className="rp-decided" style={{ marginTop: 12 }}>
              <span className="rp-outcome" data-tone={v.status === "failed" ? "bad" : "script"}>{v.status === "failed" ? "failed" : v.decided.outcome ?? "done"}</span>
              {said && !/^(Done|Failed|Running)$/.test(said) && <span className="rp-of">{said}</span>}
            </div>
            <ResultFields result={v.decided.result} />
          </div>
        )}

        {!v.inferred && <Received visit={v} runId={run.id} />}
      </div>

      {nextVisit ? (
        <div className="rp-next">
          <ArrowRight className="w-4 h-4 rp-next-arrow" aria-hidden />
          <span className="rp-next-to">{nextVisit.label}</span>
          {v.decided.toWords && <span className="rp-next-when">{v.decided.toWords}</span>}
          <button type="button" className="lw-act" onClick={onNext}>Step</button>
        </div>
      ) : (
        <div className="rp-next" data-end="">
          {run.live ? <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /> : <Square className="w-3.5 h-3.5 rp-next-arrow" aria-hidden />}
          <span className={`rp-next-to ${outcomeToneClass(run.outcome.tone)}`}>{run.outcome.text}</span>
        </div>
      )}
    </div>
  );
}
