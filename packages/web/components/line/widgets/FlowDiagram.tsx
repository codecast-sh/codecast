"use client";
// A flow drawn for reading at a glance (docs/architecture/flows.md FL6): the
// passing path left to right, each segment a frame holding its own steps, and
// a run's state on every step. Where a stage sends work back to the session
// the change came from, the path opens on that Session and a rail runs back
// to it under the steps that return there, each return a short chip on the
// rail. A branch that ends the run is an end of its own, shaped like the
// flow's end; a loop to another station names that station. The model is
// lib/line/flowDiagram.ts; this only draws it.
import { memo, useMemo } from "react";
import { flowDiagram, routeTail, runReached, SESSION_WORDS, stepStates, type DiagramStep, type SideRoute, type StepState } from "../../../lib/line/flowDiagram";
import type { ShippedFlow } from "../../../lib/line/flowPool";
import { WHO } from "../../../lib/line/flowWho";

type RunLike = Parameters<typeof stepStates>[1];
/** Picking a step: the card opens what that station does under the drawing. */
export type StepPick = { id: string; kind: DiagramStep["kind"] };
type Pick = { picked: string | null; onPick?: (pick: StepPick) => void };

const STATE_MARK: Record<StepState, string> = { idle: "", done: "✓", current: "", stopped: "✕" };

export const FlowDiagram = memo(function FlowDiagram({ flow, run = null, compact = false, picked = null, onPick }: { flow: ShippedFlow; run?: RunLike; compact?: boolean } & Partial<Pick>) {
  const model = useMemo(() => flowDiagram(flow), [flow]);
  const states = useMemo(() => stepStates(model, run), [model, run]);
  const pick: Pick = { picked, onPick };
  // The last step on the path that sends work back to the session: the rail runs from the Session to it.
  const lastReturn = compact ? -1 : model.steps.reduce((at, st, i) => (returnsToSession(st) ? i : at), -1);
  const rail = (i: number) => (lastReturn < 0 ? undefined : i < lastReturn ? "through" : i === lastReturn ? "end" : undefined);
  return (
    <div className="fd" data-compact={compact ? "" : undefined} data-has-run={run ? "" : undefined} data-pickable={onPick ? "" : undefined} data-returns={lastReturn >= 0 ? "" : undefined}>
      <ol className="fd-path">
        {lastReturn >= 0 ? (
          <li className="fd-cell" data-rail="start">
            <div className="fd-cell-main"><span className="fd-session" title="The session the change came from: what a stage finds goes back to it">Session</span></div>
            <span className="fd-rail" aria-hidden />
          </li>
        ) : null}
        {model.steps.map((s, i) => (
          <li key={s.id} className="fd-cell" data-rail={rail(i)}>
            <div className="fd-cell-main">
            {i > 0 || lastReturn >= 0 ? <span className="fd-arrow" aria-hidden /> : null}
            {s.kind === "parallel" ? <Segment step={s} states={states} compact={compact} run={run} pick={pick} parallel />
              : s.kind === "segment" && s.inner.length > 1 ? <Segment step={s} states={states} compact={compact} run={run} pick={pick} />
              : s.kind === "segment" && s.inner.length === 1 ? <Step step={{ ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side], slot: s.slot }} state={states.get(s.inner[0].id) ?? "idle"} compact={compact} run={run} pick={pick} />
              : <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} pick={pick} />}
            </div>
            {rail(i) ? <span className="fd-rail" aria-hidden /> : null}
          </li>
        ))}
        {model.end ? (
          <li className="fd-cell">
            <div className="fd-cell-main">
              <span className="fd-arrow" aria-hidden />
              <span className="fd-end" data-reached={runReached(run, model.endId) ? "" : undefined} title={run ? undefined : "Where the flow ends when every step passes"}>{model.end}</span>
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
});

/** A segment's steps in a row inside its frame; a fan-out's branches stacked, since they run side by side. */
function Segment({ step, states, compact, run, pick, parallel = false }: { step: DiagramStep; states: Map<string, StepState>; compact: boolean; run: RunLike; pick: Pick; parallel?: boolean }) {
  const state = states.get(step.id) ?? "idle";
  const name = <>{step.label}{parallel ? <span className="fd-seg-par"> · {step.inner.length} side by side</span> : null}{written(step) ? <span className="fd-seg-tag">written here</span> : null}</>;
  return (
    <div className="fd-seg" data-state={state} data-parallel={parallel ? "" : undefined} data-written={written(step) ? "" : undefined} data-picked={pick.picked === step.id ? "" : undefined} title={slotTitle(step)}>
      {pick.onPick
        ? <button type="button" className="fd-seg-name" aria-pressed={pick.picked === step.id} onClick={() => pick.onPick!({ id: step.id, kind: step.kind })} data-fd-pick={step.id}>{name}</button>
        : <div className="fd-seg-name">{name}</div>}
      <div className="fd-seg-steps">
        {step.inner.map((s, i) => (
          <div key={s.id} className="fd-seg-cell">
            {i > 0 && !parallel ? <span className="fd-arrow fd-arrow-in" aria-hidden /> : null}
            <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} pick={pick} />
          </div>
        ))}
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

function Step({ step, state, compact, run, pick }: { step: DiagramStep; state: StepState; compact: boolean; run: RunLike; pick: Pick }) {
  const body = (
    <>
      <Who kind={step.kind} />
      <span className="fd-step-name">{step.label}</span>
      {step.slot?.filled === "empty" ? <span className="fd-seg-tag">slot</span> : written(step) ? <span className="fd-seg-tag">written here</span> : null}
      {state !== "idle" ? <span className="fd-dot" aria-label={state}>{STATE_MARK[state]}</span> : null}
    </>
  );
  const attrs = { className: "fd-step", "data-kind": step.kind, "data-state": state, "data-slot": step.slot?.filled === "empty" ? "" : undefined, "data-written": written(step) ? "" : undefined, title: slotTitle(step) ?? `${step.label}: ${WHO[step.kind].word}` };
  return (
    <div className="fd-step-wrap">
      {pick.onPick
        ? <button type="button" {...attrs} aria-pressed={pick.picked === step.id} data-picked={pick.picked === step.id ? "" : undefined} onClick={() => pick.onPick!({ id: step.id, kind: step.kind })} data-fd-pick={step.id}>{body}</button>
        : <div {...attrs}>{body}</div>}
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

/** Steps the flow wrote in place for one of its segments (a backbone's slot it filled). */
const written = (step: DiagramStep) => step.slot?.filled === "generated";
/** A slot says what it must do, on hover. */
const slotTitle = (step: DiagramStep) => (step.slot?.does ? `${step.label}: ${step.slot.does}` : undefined);

function Who({ kind }: { kind: DiagramStep["kind"] }) {
  const { icon: Icon } = WHO[kind];
  return <Icon className="fd-who" aria-hidden strokeWidth={2} />;
}

/** Whether a step, or a step inside it, sends work back to the session. */
const returnsToSession = (step: DiagramStep): boolean => step.side.some((r) => r.leadsTo === SESSION_WORDS) || step.inner.some(returnsToSession);

/**
 * Routes off the path, each drawn as what it is: a return to the session is a chip on the rail back to the Session;
 * a branch that ends the run is an end, shaped like the flow's own; a route to another station names it. The outcome
 * is the chip's words; what it does is its shape (and its title). In a definition every route shows; on a run only the
 * route the run took, red only where it stopped.
 */
function Routes({ routes, run }: { routes: SideRoute[]; run: RunLike }) {
  const shown = run ? routes.filter((r) => runReached(run, r.toId)) : routes;
  if (!shown.length) return null;
  return (
    <ul className="fd-routes">
      {shown.map((r, i) => {
        const form = r.leadsTo === SESSION_WORDS ? "session" : !r.leadsTo ? "end" : r.tone === "back" ? "back" : "on";
        return (
          <li key={i} className="fd-route" data-form={form} data-tone={r.tone} data-taken={run ? "" : undefined} title={`${r.outcome}: ${routeTail(r)}`}>
            {form === "back" ? <><span className="fd-route-mark" aria-hidden>↺</span>{r.leadsTo}<span className="fd-route-why">{r.outcome}</span></>
              : form === "on" ? <>{r.outcome}<span className="fd-route-mark" aria-hidden>→</span>{r.leadsTo}</>
              : form === "session" ? <><span className="fd-route-mark" aria-hidden>↺</span>{r.outcome}</>
              : r.outcome}
          </li>
        );
      })}
    </ul>
  );
}
