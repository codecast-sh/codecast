"use client";
// A flow drawn for reading at a glance (docs/architecture/flows.md FL6): the
// passing path left to right, each segment a frame holding its own steps, the
// routes off the path under the step they leave, and a run's state on every
// step. The model is lib/line/flowDiagram.ts; this only draws it.
import { memo, useMemo } from "react";
import { flowDiagram, stepStates, type DiagramStep, type SideRoute, type StepState } from "../../../lib/line/flowDiagram";
import type { ShippedFlow } from "../../../lib/line/flowPool";

type RunLike = Parameters<typeof stepStates>[1];

const KIND_WORD: Record<DiagramStep["kind"], string> = { agent: "agent", script: "script", person: "you", segment: "segment", call: "model" };
const STATE_MARK: Record<StepState, string> = { idle: "", done: "✓", current: "", stopped: "✕" };
const TONE_MARK: Record<SideRoute["tone"], string> = { stop: "■", back: "↺", out: "↳" };

export const FlowDiagram = memo(function FlowDiagram({ flow, run = null, compact = false }: { flow: ShippedFlow; run?: RunLike; compact?: boolean }) {
  const model = useMemo(() => flowDiagram(flow), [flow]);
  const states = useMemo(() => stepStates(model, run), [model, run]);
  return (
    <div className="fd" data-compact={compact ? "" : undefined} data-has-run={run ? "" : undefined}>
      <ol className="fd-path">
        {model.steps.map((s, i) => (
          <li key={s.id} className="fd-cell">
            {i > 0 ? <span className="fd-arrow" aria-hidden /> : null}
            {s.kind === "segment" ? <Segment step={s} states={states} compact={compact} /> : <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} />}
          </li>
        ))}
        {model.end ? (
          <li className="fd-cell">
            <span className="fd-arrow" aria-hidden />
            <span className="fd-end" data-reached={run?.status === "completed" ? "" : undefined}>{model.end}</span>
          </li>
        ) : null}
      </ol>
    </div>
  );
});

function Segment({ step, states, compact }: { step: DiagramStep; states: Map<string, StepState>; compact: boolean }) {
  const state = states.get(step.id) ?? "idle";
  return (
    <div className="fd-seg" data-state={state}>
      <div className="fd-seg-name">{step.label}</div>
      <div className="fd-seg-steps">
        {step.inner.map((s, i) => (
          <div key={s.id} className="fd-seg-cell">
            {i > 0 ? <span className="fd-arrow fd-arrow-in" aria-hidden /> : null}
            <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} />
          </div>
        ))}
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} /> : null}
    </div>
  );
}

function Step({ step, state, compact }: { step: DiagramStep; state: StepState; compact: boolean }) {
  return (
    <div className="fd-step-wrap">
      <div className="fd-step" data-kind={step.kind} data-state={state} title={`${step.label}: ${KIND_WORD[step.kind]}`}>
        <span className="fd-dot" aria-hidden>{STATE_MARK[state]}</span>
        <span className="fd-step-name">{step.label}</span>
        <span className="fd-step-kind">{KIND_WORD[step.kind]}</span>
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} /> : null}
    </div>
  );
}

/** Routes off the path: the target, and the words for when unless they only restate it. */
function Routes({ routes }: { routes: SideRoute[] }) {
  return (
    <ul className="fd-routes">
      {routes.map((r, i) => {
        const restates = !r.words || r.words === "otherwise" && r.tone === "stop" || r.to.toLowerCase().includes(r.words.toLowerCase()) || r.words.toLowerCase().includes(r.to.toLowerCase());
        return (
          <li key={i} className="fd-route" data-tone={r.tone} title={r.words ? `${r.words}: ${r.to}` : r.to}>
            <span className="fd-route-mark" aria-hidden>{TONE_MARK[r.tone]}</span>
            {restates ? <b>{r.to}</b> : <>{r.words} <span className="fd-route-to">→</span> <b>{r.to}</b></>}
          </li>
        );
      })}
    </ul>
  );
}
