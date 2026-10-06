// One bisect, live or finished (docs/architecture/evals-ui.md 4.5): the commit
// ruler in the middle, a rail with spend against budget, probes left, elapsed
// time, the tmux session, Stop, a stall flag and the log tail, and once it
// answers, the result: the culprit as a CommitPanel with its confirmation and
// the tier that produced it, a range when it is unsure, or the plain drift
// banner when the controls did not reproduce. Props only.

import { answerStepText, batchLabel, bisectGlyph, bisectOutcomeOf, bisectStatusWord, bisectSummaryWord, endpointLabel, isBisectLive, isStalled, pLabel, plural, rulerModel, shortSha, splitBatchNames, tierWord, usd, type RulerModel } from "../../client";
import type { BisectResponse, BisectState, BisectStep } from "../../contract";
import { useEvalsHost, useEvalsPaths } from "../hooks";
import { CopyCommand, EvalsLink, LogTail, SeparationMark, VerdictGlyph } from "../shell/parts";
import { AttributionAnswerCard, AttributionEvidence, CandidateList } from "./AttributionView";
import { BisectRuler } from "./BisectRuler";
import { CommitPanel } from "./CommitPanel";

function Rail({ state, model, logTail, stalled, now, onStop, stopping }: { state: BisectState; model: RulerModel; logTail: string[]; stalled: boolean; now: number; onStop?: () => void; stopping: boolean }) {
  const { duration } = useEvalsHost().format;
  const live = isBisectLive(state.status);
  const pct = state.budgetUsd > 0 ? Math.min(100, (state.spentUsd / state.budgetUsd) * 100) : 0;
  const end = state.finishedAt ? Date.parse(state.finishedAt) : now;
  return (
    <aside className="ev-card ev-b-rail ev-b-area-rail" data-evb-rail>
      <h2>
        <VerdictGlyph state={bisectGlyph(bisectOutcomeOf(state))} title={bisectSummaryWord(bisectOutcomeOf(state))} size={11} />
        {live ? "Running" : "Finished"}
      </h2>
      <div className="ev-b-spend">
        <div className="ev-b-spend-figs">
          <span className="ev-b-answer-num">{usd(state.spentUsd)}</span>
          <span className="ev-note">of {usd(state.budgetUsd)} budget</span>
        </div>
        <div className="ev-b-spend-track" role="img" aria-label={`${Math.round(pct)}% of the budget spent`}>
          <div className="ev-b-spend-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {stalled && (
        <div className="ev-b-stall" role="status" data-evb-stalled>
          <VerdictGlyph state="dry" size={12} />
          <span>
            Stalled? No new step for {duration(Date.parse(state.updatedAt), now) || "a while"}. Check the tmux session or the log.
          </span>
        </div>
      )}
      <dl className="ev-b-facts">
        <dt>Status</dt>
        <dd>{bisectStatusWord(state.status)}</dd>
        <dt>Probes left</dt>
        <dd>{live ? (model.probesLeft ? `about ${model.probesLeft}, then confirmation` : state.status === "confirming" ? "none, confirming" : "none") : "none"}</dd>
        <dt>Classes left</dt>
        <dd>{model.classesLeft}</dd>
        <dt>{live ? "Elapsed" : "Took"}</dt>
        <dd>{duration(Date.parse(state.startedAt), end) || "under a minute"}</dd>
        <dt>Tier</dt>
        <dd>{tierWord(state.tier)}</dd>
      </dl>
      {/* The tmux session ends with the run, so the attach line is offered only while there is something to attach to. */}
      {live && (state.tmux ? <CopyCommand command={`tmux attach -t ${state.tmux}`} /> : <span className="ev-b-fine ev-quiet">Running detached; it writes job.log in its bisect folder.</span>)}
      {live && onStop && (
        <button type="button" className="ev-btn ev-btn--lg ev-btn--stop ev-b-start" onClick={onStop} disabled={stopping} data-evb-stop>
          {stopping ? "Stopping between reps..." : "Stop"}
        </button>
      )}
      <LogTail lines={logTail} label={state.pending && state.status === "failed" ? "What the job printed before it ended" : "Log tail"} data-evb-log />
    </aside>
  );
}

/** What every answer rests on: the controls on the flipped freezes, and whether the bad end separated from the good. */
function ControlsLine({ controls }: { controls: NonNullable<BisectResponse["controls"]> }) {
  const { good, bad, separation: sep } = controls;
  const words =
    sep.kind === "worse"
      ? `the bad end separated worse, p ${pLabel(sep.p)} on the flipped freezes`
      : sep.kind === "too-few"
        ? `too few reps to separate (${Math.min(good.reps, bad.reps)} a side, 5 needed), so nothing shows the regression reproduces`
        : `they did not separate (${sep.kind === "better" ? "the bad end read better" : "not separated"}, p ${pLabel(sep.p)})`;
  return (
    <div className="ev-b-controls" data-evb-controls={sep.kind}>
      <SeparationMark result={sep} />
      <span>
        <span className="ev-quiet">Controls </span>
        {good.passed} of {good.reps} passed at the good end, {bad.passed} of {bad.reps} at the bad end: {words}.
      </span>
    </div>
  );
}

/** The classes a probe could not load, each with its reason: a gap the answer cannot see into. */
function UnloadedClasses({ state }: { state: BisectState }) {
  const skipped = (state.classes ?? []).filter((c) => c.skip);
  if (!skipped.length) return null;
  return (
    <ul className="ev-b-unloaded" data-evb-unloaded={skipped.length}>
      {skipped.map((c) => (
        <li key={c.n}>
          <span className="ev-mono">{shortSha(c.representative)}</span>
          {c.shas.length > 1 ? ` (and ${plural(c.shas.length - 1, "commit")} that render alike)` : ""} does not load: <span className="ev-mono">{c.skip}</span>
        </li>
      ))}
    </ul>
  );
}

/** Why a bisect ended without an answer, from its one status. */
function endedWords(state: BisectState, steps: readonly BisectStep[]): string {
  // The runner's own stop line names the one halt that ended it (stop file, time limit or budget); the status alone cannot tell time from budget.
  const halt = [...steps].reverse().find((x) => x.text.startsWith("stopped: "))?.text.slice("stopped: ".length);
  if ((state.status === "stopped" || state.status === "budget") && halt) return halt;
  if (state.status === "stopped") return "it was stopped (the stop file was written)";
  if (state.status === "budget") return `its budget of ${usd(state.budgetUsd)} would have been passed`;
  const error = [...steps].reverse().find((x) => x.kind === "error");
  if (state.status === "failed") return `it failed${error ? `: ${error.text}` : ""}`;
  return bisectStatusWord(state.status);
}

export function BisectResult({ state, now, steps = [], controls = null }: { state: BisectState; now: number; steps?: readonly BisectStep[]; controls?: BisectResponse["controls"] }) {
  const href = useEvalsPaths().href;
  const ans = state.answer;
  if (!ans) {
    if (isBisectLive(state.status)) return null;
    const ran = state.probes.some((p) => !p.recorded && p.reps.some((r) => r.runId !== null || r.passed !== null));
    return (
      <section className="ev-card ev-b-result" data-evb-result="none" data-evb-ran={ran}>
        <div className="ev-b-answer-say">
          {ran
            ? `It ended before an answer because ${endedWords(state, steps)}, with ${plural(state.candidates.length, "candidate")} searched down to the bracketed range above, for ${usd(state.spentUsd)}. Start it again from the attribution page to carry on; its recorded probes count as evidence.`
            : `Stopped before any rep ran: ${endedWords(state, steps)}. Nothing was searched and nothing was spent.`}
        </div>
        {controls && <ControlsLine controls={controls} />}
        <UnloadedClasses state={state} />
      </section>
    );
  }
  if (ans.kind === "drift") {
    return (
      <div className="ev-b-drift" role="status" data-evb-result="drift">
        <VerdictGlyph state="dry" size={16} />
        <div>
          <strong>Does not reproduce on today's tool and judge: drift, not source.</strong>
          <span className="ev-b-note">{ans.detail}</span>
        </div>
      </div>
    );
  }
  if (ans.kind === "crashed") {
    return (
      <section className="ev-card ev-b-result" role="status" data-evb-result="crashed">
        <div className="ev-b-reason">
          <strong>No answer: a control could not run a rep.</strong> {ans.detail}
        </div>
        {ans.runIds.length > 0 && (
          <div className="ev-b-runs">
            {ans.runIds.slice(0, 6).map((id) => (
              <EvalsLink key={id} className="ev-chip" href={href.run(id)} title={`${id}: open the crashed rep`}>
                {id}
              </EvalsLink>
            ))}
          </div>
        )}
      </section>
    );
  }
  if (ans.kind === "unreplayable") {
    return (
      <section className="ev-card ev-b-result" data-evb-result="unreplayable">
        <div className="ev-b-reason">{ans.detail}</div>
      </section>
    );
  }
  if (ans.kind === "attribution") {
    return (
      <div className="ev-b-result-attribution" data-evb-result="attribution">
        <span className="ev-chip ev-b-start">{tierWord(state.tier)}</span>
        <AttributionAnswerCard attribution={{ ...state.plan.attribution, answer: ans.answer }} now={now} />
      </div>
    );
  }
  // A range or a culprit is only as good as the controls under it: when they did not separate, say so first.
  const reproduced = !controls || controls.separation.kind === "worse";
  return (
    <section className="ev-card ev-b-result" data-evb-result={ans.kind} data-evb-reproduced={reproduced}>
      {controls && <ControlsLine controls={controls} />}
      {!reproduced && (
        <div className="ev-b-reason" role="status" data-evb-not-reproduced>
          <strong>The controls did not show the regression reproduces.</strong> The {ans.kind === "culprit" ? "culprit" : "range"} below is where the majority reads pointed, not a confirmed answer: run the bisect again with more reps before acting on it.
        </div>
      )}
      <UnloadedClasses state={state} />
      <div className="ev-b-result-head">
        <VerdictGlyph state={ans.kind === "culprit" ? "fail" : "mixed"} size={16} />
        <span className="ev-b-answer-num">{ans.kind === "culprit" ? shortSha(ans.commit.sha) : plural(ans.candidates.length, "candidate")}</span>
        {/* A range's reason is the runner's own answer line, never rebuilt here. */}
        <span className="ev-b-answer-say">{ans.kind === "culprit" ? ans.commit.subject : (answerStepText(steps) ?? "")}</span>
      </div>
      <div className="ev-b-confirmation">
        <span className="ev-quiet">Confirmation</span>
        {ans.separation ? <SeparationMark result={ans.separation} showWord /> : <span className="ev-quiet">not run</span>}
        <span className="ev-chip">{tierWord(ans.tier)}</span>
      </div>
      {ans.kind === "culprit" ? <CommitPanel sha={ans.commit.sha} surface={state.surface} /> : <CandidateList candidates={ans.candidates} surface={state.surface} now={now} />}
      <AttributionEvidence attribution={state.plan.attribution} />
    </section>
  );
}

/** A step's words with each batch name read as every page writes it, linked to that batch on the surface's chart. */
function StepText({ text, surface }: { text: string; surface: string }) {
  const href = useEvalsPaths().href;
  return (
    <span className="ev-b-step-text">
      {splitBatchNames(text).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <EvalsLink key={i} className="ev-b-link" href={href.surface(surface, { batch: part.batch })} title={`Batch ${part.batch}`}>
            {batchLabel(part.batch)}
          </EvalsLink>
        ),
      )}
    </span>
  );
}

function Steps({ steps, surface }: { steps: BisectStep[]; surface: string }) {
  if (!steps.length) return null;
  return (
    <section className="ev-b-section">
      <h2>What it did</h2>
      <ol className="ev-b-steps" data-evb-steps={steps.length}>
        {steps.map((s) => (
          <li key={s.seq} className="ev-b-step" data-kind={s.kind}>
            <span className="ev-b-step-at">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="ev-b-step-kind">{s.kind}</span>
            <StepText text={s.text} surface={surface} />
          </li>
        ))}
      </ol>
    </section>
  );
}

export interface BisectViewProps {
  data: BisectResponse;
  /** Every step so far, oldest first (the page folds each answer's new steps in). */
  steps: BisectStep[];
  now: number;
  /** Stops it between reps; left out, the rail offers no Stop (a host without bisect actions). */
  onStop?: () => void;
  stopping: boolean;
}

export function BisectView({ data, steps, now, onStop, stopping }: BisectViewProps) {
  const { timeAgo } = useEvalsHost().format;
  const href = useEvalsPaths().href;
  const { state } = data;
  const model = rulerModel(state);
  const stalled = isStalled(data, now);
  return (
    <div className="ev-b-page" data-evb-bisect={state.id} data-evb-status={state.status}>
      <header className="ev-b-head">
        <VerdictGlyph state={bisectGlyph(bisectOutcomeOf(state))} title={bisectSummaryWord(bisectOutcomeOf(state))} size={14} />
        <h1 className="ev-page-title">Bisect {state.id}</h1>
        <EvalsLink className="ev-chip" href={href.surface(state.surface)}>
          {state.surface}
        </EvalsLink>
        <span className="ev-chip">
          {endpointLabel(state.range.good)} to {endpointLabel(state.range.bad)}
        </span>
        <span className="ev-b-sub">
          started {timeAgo(Date.parse(state.startedAt), now)} ago, {plural(state.plan.freezes.length, "freeze")} at {plural(state.plan.reps, "rep")}
        </span>
        <span className="ev-grow" />
        <EvalsLink className="ev-b-link ev-small" href={href.bisectNew({ surface: state.surface, good: state.plan.good.batch ?? state.range.good, bad: state.plan.bad.batch ?? state.range.bad })}>
          Its attribution
        </EvalsLink>
      </header>
      <div className="ev-b-live-grid">
        <div className="ev-b-area-ruler">
          <BisectRuler state={state} stalled={stalled} model={model} />
        </div>
        <Rail state={state} model={model} logTail={data.logTail} stalled={stalled} now={now} onStop={onStop} stopping={stopping} />
        <div className="ev-b-area-rest">
          <BisectResult state={state} now={now} steps={steps} controls={data.controls ?? null} />
          <Steps steps={steps} surface={state.surface} />
        </div>
      </div>
    </div>
  );
}
