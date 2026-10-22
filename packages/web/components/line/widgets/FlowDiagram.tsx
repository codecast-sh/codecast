"use client";
// A flow drawn for reading at a glance (docs/architecture/flows.md FL6): the
// passing path left to right, each segment a frame holding its own steps, the
// routes off the path under the step they leave, and a run's state on every
// step. The model is lib/line/flowDiagram.ts; this only draws it.
import { memo, useMemo } from "react";
import { Bot, Sparkles, SquareTerminal, User, type LucideIcon } from "lucide-react";
import { flowDiagram, runReached, stepStates, type DiagramStep, type SideRoute, type StepState } from "../../../lib/line/flowDiagram";
import type { ShippedFlow } from "../../../lib/line/flowPool";

type RunLike = Parameters<typeof stepStates>[1];

/** Who does a step, said on the step itself. */
const WHO: Record<DiagramStep["kind"], { icon: LucideIcon; word: string }> = {
  agent: { icon: Bot, word: "An agent session does this" },
  script: { icon: SquareTerminal, word: "A command runs this" },
  person: { icon: User, word: "A person decides this" },
  call: { icon: Sparkles, word: "One model call answers this" },
  segment: { icon: Bot, word: "A segment" },
};
const STATE_MARK: Record<StepState, string> = { idle: "", done: "✓", current: "", stopped: "✕" };
const TONE_MARK: Record<SideRoute["tone"], string> = { stop: "⊣", back: "↺", out: "↳" };

export const FlowDiagram = memo(function FlowDiagram({ flow, run = null, compact = false }: { flow: ShippedFlow; run?: RunLike; compact?: boolean }) {
  const model = useMemo(() => flowDiagram(flow), [flow]);
  const states = useMemo(() => stepStates(model, run), [model, run]);
  return (
    <div className="fd" data-compact={compact ? "" : undefined} data-has-run={run ? "" : undefined}>
      <ol className="fd-path">
        {model.steps.map((s, i) => (
          <li key={s.id} className="fd-cell">
            {i > 0 ? <span className="fd-arrow" aria-hidden /> : null}
            {s.kind === "segment" && s.inner.length > 1 ? <Segment step={s} states={states} compact={compact} run={run} />
              : s.kind === "segment" && s.inner.length === 1 ? <Step step={{ ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side] }} state={states.get(s.inner[0].id) ?? "idle"} compact={compact} run={run} />
              : <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} />}
          </li>
        ))}
        {model.end ? (
          <li className="fd-cell">
            <span className="fd-arrow" aria-hidden />
            <span className="fd-end" data-reached={runReached(run, model.endId) ? "" : undefined}>{model.end}</span>
          </li>
        ) : null}
      </ol>
    </div>
  );
});

function Segment({ step, states, compact, run }: { step: DiagramStep; states: Map<string, StepState>; compact: boolean; run: RunLike }) {
  const state = states.get(step.id) ?? "idle";
  return (
    <div className="fd-seg" data-state={state}>
      <div className="fd-seg-name">{step.label}</div>
      <div className="fd-seg-steps">
        {step.inner.map((s, i) => (
          <div key={s.id} className="fd-seg-cell">
            {i > 0 ? <span className="fd-arrow fd-arrow-in" aria-hidden /> : null}
            <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} />
          </div>
        ))}
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

function Step({ step, state, compact, run }: { step: DiagramStep; state: StepState; compact: boolean; run: RunLike }) {
  return (
    <div className="fd-step-wrap">
      <div className="fd-step" data-kind={step.kind} data-state={state} title={`${step.label}: ${WHO[step.kind].word}`}>
        <Who kind={step.kind} />
        <span className="fd-step-name">{step.label}</span>
        {state !== "idle" ? <span className="fd-dot" aria-label={state}>{STATE_MARK[state]}</span> : null}
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

function Who({ kind }: { kind: DiagramStep["kind"] }) {
  const { icon: Icon } = WHO[kind];
  return <Icon className="fd-who" aria-hidden strokeWidth={2} />;
}

/**
 * Routes off the path, one form each: the outcome, and where it leads when it
 * leads to a station. In a definition they are neutral routes; on a run only
 * the route the run took shows, and red only when it stopped there.
 */
function Routes({ routes, run }: { routes: SideRoute[]; run: RunLike }) {
  const shown = run ? routes.filter((r) => runReached(run, r.toId)) : routes;
  if (!shown.length) return null;
  return (
    <ul className="fd-routes">
      {shown.map((r, i) => (
        <li key={i} className="fd-route" data-tone={r.tone} data-taken={run ? "" : undefined} title={r.leadsTo ? `${r.outcome}: back to ${r.leadsTo}` : `${r.outcome}: the flow ends here`}>
          <span className="fd-route-mark" aria-hidden>{TONE_MARK[r.tone]}</span>
          <span><b>{r.outcome}</b>{r.leadsTo ? <> <span className="fd-route-to">→</span> {r.leadsTo}</> : null}</span>
        </li>
      ))}
    </ul>
  );
}
