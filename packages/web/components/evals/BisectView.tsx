// One bisect, live or finished (docs/architecture/evals-ui.md 4.5): the commit
// ruler in the middle, a rail with spend against budget, probes left, elapsed
// time, the tmux session, Stop, a stall flag and the log tail, and once it
// answers, the result: the culprit as a CommitPanel with its confirmation and
// the tier that produced it, a range when it is unsure, or the plain drift
// banner when the controls did not reproduce. Props only.

import type { BisectResponse, BisectState, BisectStep } from "@codecast/shared/contracts/evalsApi";
import { formatDuration } from "../../lib/conversationFormat";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { EVALS_STALL_MS } from "../../lib/evals/hooks";
import { AttributionAnswerCard, AttributionEvidence, CandidateList } from "./AttributionView";
import { BisectRuler } from "./BisectRuler";
import { CommitPanel } from "./CommitPanel";
import { CopyCommand, EvalsLink, SeparationMark, VerdictGlyph, shortSha, usd, type VerdictState } from "./parts";
import { bisectStatusWord, isBisectLive, rulerModel, tierWord, type RulerModel } from "./bisectModel";
import { evalsHref } from "./evalsPaths";
import "./bisect.css";

export function bisectGlyph(state: Pick<BisectState, "status" | "answer">): VerdictState {
  if (isBisectLive(state.status)) return "unscored";
  if (state.answer?.kind === "culprit") return "fail";
  if (state.answer?.kind === "range") return "mixed";
  if (state.status === "failed") return "crash";
  return "dry";
}

const elapsed = (from: number, to: number) => formatDuration(from, to) || "under a minute";

/** Stalled: the server says so, or a live bisect has written no step for five minutes. */
export function isStalled(data: Pick<BisectResponse, "state" | "stalled">, now: number): boolean {
  return isBisectLive(data.state.status) && (data.stalled || now - Date.parse(data.state.updatedAt) > EVALS_STALL_MS);
}

function Rail({ state, model, logTail, stalled, now, onStop, stopping }: { state: BisectState; model: RulerModel; logTail: string[]; stalled: boolean; now: number; onStop: () => void; stopping: boolean }) {
  const live = isBisectLive(state.status);
  const pct = state.budgetUsd > 0 ? Math.min(100, (state.spentUsd / state.budgetUsd) * 100) : 0;
  const end = state.finishedAt ? Date.parse(state.finishedAt) : now;
  return (
    <aside className="ev-card evb-rail evb-area-rail" data-evb-rail>
      <h2>
        <VerdictGlyph state={bisectGlyph(state)} size={11} />
        {live ? "Running" : "Finished"}
      </h2>
      <div className="evb-spend">
        <div className="evb-spend-figs">
          <span className="evb-answer-num">{usd(state.spentUsd)}</span>
          <span className="text-[12px] ev-quiet">of {usd(state.budgetUsd)} budget</span>
        </div>
        <div className="evb-spend-track" role="img" aria-label={`${Math.round(pct)}% of the budget spent`}>
          <div className="evb-spend-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {stalled && (
        <div className="evb-stall" role="status" data-evb-stalled>
          <VerdictGlyph state="dry" size={12} />
          <span>
            Stalled? No new step for {formatDuration(Date.parse(state.updatedAt), now) || "a while"}. Check the tmux session or the log.
          </span>
        </div>
      )}
      <dl className="evb-facts">
        <dt>Status</dt>
        <dd>{bisectStatusWord(state.status)}</dd>
        <dt>Probes left</dt>
        <dd>{live ? (model.probesLeft ? `about ${model.probesLeft}, then confirmation` : state.status === "confirming" ? "none, confirming" : "none") : "none"}</dd>
        <dt>Classes left</dt>
        <dd>{model.classesLeft}</dd>
        <dt>{live ? "Elapsed" : "Took"}</dt>
        <dd>{elapsed(Date.parse(state.startedAt), end)}</dd>
        <dt>Tier</dt>
        <dd>{tierWord(state.tier)}</dd>
      </dl>
      {state.tmux ? <CopyCommand command={`tmux attach -t ${state.tmux}`} /> : live ? <span className="text-[11.5px] ev-quiet">Running detached; it writes log.txt in its bisect folder.</span> : null}
      {live && (
        <button type="button" className="evb-btn evb-btn--stop self-start" onClick={onStop} disabled={stopping} data-evb-stop>
          {stopping ? "Stopping between reps..." : "Stop"}
        </button>
      )}
      {logTail.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] ev-quiet">Log tail</span>
          <pre className="evb-log" data-evb-log>
            {logTail.join("\n")}
          </pre>
        </div>
      )}
    </aside>
  );
}

/** What the bisect answered. */
export function BisectResult({ state, now }: { state: BisectState; now: number }) {
  const ans = state.answer;
  if (!ans) {
    if (isBisectLive(state.status)) return null;
    return (
      <section className="ev-card evb-result" data-evb-result="none">
        <div className="evb-answer-say">
          It {bisectStatusWord(state.status)} before an answer, with {state.candidates.length} candidates searched down to the bracketed range above. Start it again from the attribution page to carry on; its recorded probes count as evidence.
        </div>
      </section>
    );
  }
  if (ans.kind === "drift") {
    return (
      <div className="evb-drift" role="status" data-evb-result="drift">
        <VerdictGlyph state="dry" size={16} />
        <div>
          <strong>Does not reproduce on today's tool and judge: drift, not source.</strong>
          <span className="evb-note">{ans.detail}</span>
        </div>
      </div>
    );
  }
  if (ans.kind === "unreplayable") {
    return (
      <section className="ev-card evb-result" data-evb-result="unreplayable">
        <div className="evb-reason">{ans.detail}</div>
      </section>
    );
  }
  if (ans.kind === "attribution") {
    return (
      <div className="flex flex-col gap-3" data-evb-result="attribution">
        <span className="ev-chip self-start">{tierWord(0)}</span>
        <AttributionAnswerCard attribution={{ ...state.plan.attribution, answer: ans.answer }} now={now} />
      </div>
    );
  }
  return (
    <section className="ev-card evb-result" data-evb-result={ans.kind}>
      <div className="evb-result-head">
        <VerdictGlyph state={ans.kind === "culprit" ? "fail" : "mixed"} size={16} />
        <span className="evb-answer-num">{ans.kind === "culprit" ? shortSha(ans.commit.sha) : `${ans.candidates.length} commits`}</span>
        <span className="evb-answer-say">{ans.kind === "culprit" ? ans.commit.subject : "render alike or would not separate: the answer is this range."}</span>
      </div>
      <div className="flex items-center gap-3 flex-wrap text-[12px]">
        <span className="ev-quiet">Confirmation</span>
        {ans.separation ? <SeparationMark result={ans.separation} showWord /> : <span className="ev-quiet">not run</span>}
        <span className="ev-chip">{tierWord(ans.tier)}</span>
      </div>
      {ans.kind === "culprit" ? <CommitPanel sha={ans.commit.sha} surface={state.surface} /> : <CandidateList candidates={ans.candidates} now={now} />}
      <AttributionEvidence attribution={state.plan.attribution} />
    </section>
  );
}

function Steps({ steps }: { steps: BisectStep[] }) {
  if (!steps.length) return null;
  return (
    <section className="evb-section">
      <h2>What it did</h2>
      <ol className="evb-steps" data-evb-steps={steps.length}>
        {steps.map((s) => (
          <li key={s.seq} className="evb-step" data-kind={s.kind}>
            <span className="evb-step-at">{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="evb-step-kind">{s.kind}</span>
            <span className="evb-step-text">{s.text}</span>
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
  onStop: () => void;
  stopping: boolean;
}

export function BisectView({ data, steps, now, onStop, stopping }: BisectViewProps) {
  const { state } = data;
  const model = rulerModel(state);
  const stalled = isStalled(data, now);
  return (
    <div className="evb-page" data-evb-bisect={state.id} data-evb-status={state.status}>
      <header className="evb-head">
        <VerdictGlyph state={bisectGlyph(state)} size={14} />
        <h1>Bisect {state.id}</h1>
        <EvalsLink className="ev-chip" href={evalsHref.surface(state.surface)}>
          {state.surface}
        </EvalsLink>
        <span className="ev-chip">
          {shortSha(state.range.good)} to {shortSha(state.range.bad)}
        </span>
        <span className="evb-sub">
          started {formatTimeAgo(Date.parse(state.startedAt), now)} ago, {state.plan.freezes.length} freezes at {state.plan.reps} reps
        </span>
        <span className="flex-1" />
        <EvalsLink className="evb-link text-[12px]" href={evalsHref.bisectNew({ surface: state.surface, good: state.plan.good.batch ?? state.range.good, bad: state.plan.bad.batch ?? state.range.bad })}>
          Its attribution
        </EvalsLink>
      </header>
      <div className="evb-live-grid">
        <div className="evb-area-ruler min-w-0">
          <BisectRuler state={state} stalled={stalled} model={model} />
        </div>
        <Rail state={state} model={model} logTail={data.logTail} stalled={stalled} now={now} onStop={onStop} stopping={stopping} />
        <div className="evb-area-rest flex flex-col gap-4 min-w-0">
          <BisectResult state={state} now={now} />
          <Steps steps={steps} />
        </div>
      </div>
    </div>
  );
}
