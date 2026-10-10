"use client";
// One step as a card (line-workspace.md LW3), the chat's step object: who
// does it and what it is for, where it sends work and how often, a peek of
// its prompt, and what it decided lately, each row opening that decision.
// The workspace's drawer is the full step; this card is how a step appears
// in a conversation, a notebook margin or a fence.
import { memo, useMemo } from "react";
import type { LineModel, StepDecision } from "../../../lib/line/lineModel";
import { DecisionList } from "./DecisionCard";
import { PromptView } from "./PromptView";
import { KindTag, NavLink, dayWords, useLineNav } from "./parts";
import { tallyWords } from "./tallyWords";

export type StepCardProps = {
  model: LineModel;
  stepId: string;
  /** How many recent decisions to list. */
  recent?: number;
  /** What a decision row does; by default it opens the step on that run. */
  onDecision?: (d: StepDecision) => void;
};

export const StepCard = memo(function StepCard({ model, stepId, recent = 4, onDecision }: StepCardProps) {
  const nav = useLineNav();
  const step = model.steps[stepId];
  const summary = useMemo(() => (step ? tallyWords(step.tally, 3) : ""), [step]);
  if (!step) return null;
  const nodes = model.graph.nodes;
  const open = () => nav.openStep(step.id);
  const ver = step.prompt?.version;

  return (
    <div className="lw-obj" data-line-widget="step" data-line-step={step.id}>
      <div className="lw-obj-head">
        <KindTag kind={step.kind} />
        <span className="lw-obj-title">{step.label}</span>
        {ver && <span className="lw-ver" data-new={ver.earlier ? "" : undefined} title={`This text since ${dayWords(ver.since)}, ${ver.runs} ${ver.runs === 1 ? "run" : "runs"}`}>{ver.hash.slice(0, 6)}</span>}
        <span className="lw-spacer" />
        {step.prompt?.file && <span className="lw-obj-meta lw-file">{step.prompt.file.split("/").pop()}</span>}
      </div>
      <div className="lw-obj-body">
        <p className="lw-step-does">{step.purpose}</p>
        {step.outcomes.length > 0 && (
          <div className="lw-then">
            {step.outcomes.map((o, i) => (
              <button key={`${o.key}#${i}`} type="button" className="lw-then-row" onClick={() => nav.openStep(o.to)}>
                <span aria-hidden>{o.kind === "loop" ? "↺" : "→"}</span>
                <span className="lw-then-to" data-kind={model.steps[o.to]?.kind}>{o.toLabel}</span>
                <span>{o.words !== "next" ? o.words : ""}</span>
                {o.count > 0 && <span className="lw-then-n">{o.count}×</span>}
              </button>
            ))}
          </div>
        )}
        {step.kind === "person" && step.answers.length > 0 && (
          <div className="lw-sec">
            <div className="lw-sec-head">Your answers</div>
            <div className="lw-then">
              {step.answers.map((a) => <div key={a.answer} className="lw-then-row" style={{ cursor: "default" }}><b style={{ color: "var(--lw-person-deep)" }}>{a.answer}</b>{a.does && <span>{a.does}</span>}</div>)}
            </div>
          </div>
        )}
        {step.prompt && step.kind !== "person" && (
          <div className="lw-sec">
            <div className="lw-sec-head"><span>{step.prompt.kind === "script" ? "Its command" : "Its prompt"}</span><span className="lw-spacer" /><NavLink className="lw-link" href={nav.stepHref(step.id)} onOpen={open}>Read all</NavLink></div>
            <div className="lw-peek" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === "Enter") open(); }} aria-label={`Read ${step.label}'s prompt`}>
              <PromptView prompt={step.prompt} nodes={nodes} layout="flat" />
            </div>
          </div>
        )}
        {step.decisions.length > 0 && (
          <div className="lw-sec">
            <div className="lw-sec-head"><span>What it decided</span><span className="lw-spacer" /><span style={{ fontWeight: 400, color: "var(--lw-ink-3)" }}>{step.decisions.length} {step.decisions.length === 1 ? "case" : "cases"}: {summary}</span></div>
            <DecisionList step={step} compact limit={recent} onOpen={onDecision ?? ((d) => nav.openRun(d.runId, d.caseId))} />
          </div>
        )}
      </div>
      <div className="lw-obj-foot">
        <NavLink className="lw-act" href={nav.stepHref(step.id)} onOpen={open}>Open the step</NavLink>
      </div>
    </div>
  );
});
