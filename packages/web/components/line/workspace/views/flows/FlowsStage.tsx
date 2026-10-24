"use client";
// The Flows stage (doc "Signals to shipped: one pipeline"): the team's live
// flow. Its head holds the switch, its load against its capacity, what is
// stalled and its hold; then a lane per flow of its family (the spine, each
// variant, the judge flow) with the sources that feed it and the runs standing
// at each step, the problems running off the flow, and the sources that file
// nowhere; then the drawn lane's map (or its steps table), and the queue. A
// lane's name draws its map; a step of the drawn lane opens that step. The
// library is one press in. A team with no live flow lands on the library; an
// address that names the steps (their view, a flow, a step or a run) draws them.
import { memo, useMemo, type MouseEvent } from "react";
import { BookOpen } from "lucide-react";
import type { FlowMap, FlowMapLane, FlowMapStep } from "@codecast/shared/contracts/flowMap";
import { useFlowMapRow } from "../../../../../hooks/useFlowMap";
import { processKeyOf } from "../../../../../lib/line/lineGraphs";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { ProcessView } from "../ProcessView";
import { FlowsView, LiveFlowHead, LiveFlowWork } from "./FlowsView";
import { useFlowLibrary } from "../../../../../hooks/useFlowLibrary";
import type { LineViewProps } from "../types";
import "./flowsStage.css";

export const FlowsStage = memo(function FlowsStage(props: LineViewProps) {
  const { space, select, href, workspace, model } = props;
  const { live, runsOf } = useFlowLibrary(space);
  const map = useFlowMapRow(space);
  // With no live flow the landing is the library; an address that names the steps (their view, a flow, a step or a
  // run) draws them.
  const { landing, graph, step, run } = props.selection;
  if (!live) return landing && !graph && !step && !run ? <FlowsView {...props} /> : <div className="fs"><div className="fs-map" data-mode={props.selection.mode}><ProcessView {...props} /></div></div>;
  const library: LineSelectionPatch = { view: "flows", item: null, run: null };
  const stalled = (map?.liveFlow?.stalled ?? 0) + (map?.off.stalled ?? 0);
  return (
    <div className="fs" data-flows-stage={live.flow.slug}>
      <section className="fll-live fs-live" data-live-flow={live._id} data-on={live.on ? "" : undefined}>
        <LiveFlowHead live={live} workspace={workspace} stalled={stalled} onOpenFlow={(slug) => select({ view: "flows", item: slug, run: null })}>
          <a className="lw-chip fs-lib" href={href(library)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(library); }} data-flows-library-link><BookOpen className="w-3.5 h-3.5" aria-hidden />Library</a>
        </LiveFlowHead>
        {map ? <Lanes map={map} drawn={model.graphKey} steps={model.steps} select={select} href={href} /> : null}
      </section>
      <div className="fs-map" data-mode={props.selection.mode}><ProcessView {...props} /></div>
      <section className="fll-live fs-work"><LiveFlowWork live={live} runs={runsOf.get(live.flow.slug) ?? []} workspace={workspace} href={href} /></section>
    </div>
  );
});

/** The live flow's lanes, then the runs off it, then the sources that file nowhere. */
function Lanes({ map, drawn, steps, select, href }: { map: FlowMap; drawn: string; steps: Record<string, unknown>; select: LineViewProps["select"]; href: LineViewProps["href"] }) {
  const label = useMemo(() => new Map(map.sources.map((s) => [s.key, s.label])), [map.sources]);
  const off = map.sources.filter((s) => s.route === "off");
  const unfiled = map.sources.filter((s) => s.route === "unfiled");
  const signals = (patch: LineSelectionPatch = {}): LineSelectionPatch => ({ view: "signals", sig: null, stage: null, item: null, source: null, ...patch });
  return (
    <div className="fs-lanes" data-flow-lanes={map.lanes.length}>
      {map.lanes.map((lane) => {
        const key = processKeyOf(lane.key);
        const isDrawn = key === drawn;
        return (
          <Lane key={lane.key} name={laneName(lane, map.lanes)} kind={lane.kind} drawn={isDrawn} laneKey={lane.key}
            draw={isDrawn ? undefined : { href: href({ graph: key, step: null }), go: () => select({ graph: key, step: null }) }}
            sources={lane.sources.map((k) => label.get(k) ?? k)}
            steps={lane.steps}
            openStep={isDrawn ? (id) => (id in steps ? () => select({ step: id }) : undefined) : undefined}
            edit={{ href: href({ view: "flows", item: lane.key, run: null }), go: () => select({ view: "flows", item: lane.key, run: null }) }} />
        );
      })}
      {map.off.steps.length || off.length ? (
        <Lane name="Off the flow" kind="off" laneKey="off" sources={off.map((s) => `${s.label} ${s.outcomes.total.toLocaleString()}`)} steps={map.off.steps}
          sourcesHref={{ href: href(signals()), go: () => select(signals()) }} />
      ) : null}
      {unfiled.length ? (
        <Lane name="Not filed" kind="unfiled" laneKey="unfiled" sources={unfiled.map((s) => s.label)} steps={[]}
          sourcesHref={{ href: href(signals()), go: () => select(signals()) }} />
      ) : null}
    </div>
  );
}

/** A lane as its card names it: the card already names the flow, so the spine is Main and a variant is what sets it
 *  apart ("Union fix flow for system errors" reads "For system errors"). */
function laneName(lane: FlowMapLane, lanes: ReadonlyArray<FlowMapLane>): string {
  if (lane.kind === "spine") return "Main";
  const spine = lanes.find((l) => l.kind === "spine")?.label;
  const rest = spine && lane.label.toLowerCase().startsWith(spine.toLowerCase()) ? lane.label.slice(spine.length).replace(/^[\s:·-]+/, "") : "";
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : lane.label;
}

type Go = { href: string; go: () => void };
const follow = (to: Go) => (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); to.go(); };

function Lane({ name, kind, laneKey, drawn = false, draw, edit, sources, sourcesHref, steps, openStep }: {
  name: string; kind: FlowMapLane["kind"] | "off" | "unfiled"; laneKey: string; drawn?: boolean; draw?: Go; edit?: Go;
  sources: string[]; sourcesHref?: Go; steps: FlowMapStep[]; openStep?: (id: string) => (() => void) | undefined;
}) {
  const running = steps.reduce((n, s) => n + s.running, 0);
  const stalled = steps.reduce((n, s) => n + s.stalled, 0);
  const waiting = steps.reduce((n, s) => n + s.waiting, 0);
  return (
    <div className="fs-lane" data-kind={kind} aria-current={drawn ? "true" : undefined} data-flow-lane={laneKey}>
      <div className="fs-lane-id">
        {draw ? <a className="fs-lane-name" href={draw.href} onClick={follow(draw)} title="Draw its map">{name}</a> : <span className="fs-lane-name">{name}</span>}
        <span className="fs-lane-sub">
          {kind === "variant" ? <span className="fll-tag">Variant</span> : kind === "judge" ? <span className="fll-tag">Judges</span> : null}
          {running > 0 ? <span><b className="lw-num">{running}</b> running</span> : null}
          {waiting > 0 ? <span data-tone="you"><b className="lw-num">{waiting}</b> on a person</span> : null}
          {stalled > 0 ? <span data-tone="bad"><b className="lw-num">{stalled}</b> stalled</span> : null}
          {edit ? <a className="fs-lane-edit" href={edit.href} onClick={follow(edit)}>Edit steps</a> : null}
        </span>
      </div>
      <div className="fs-lane-src">
        {sources.map((s) => (sourcesHref ? <a key={s} className="flv-chip flv-chip-btn" href={sourcesHref.href} onClick={follow(sourcesHref)}>{s}</a> : <span key={s} className="flv-chip">{s}</span>))}
      </div>
      {steps.length ? (
        <ol className="fs-steps">
          {steps.map((s) => {
            const open = openStep?.(s.id);
            // Running counts the runs working at the step; those waiting on a person and those stalled are named beside it.
            const body = <><span className="fs-step-n lw-num" data-zero={s.running ? undefined : ""}>{s.running}</span><span className="fs-step-l">{s.label}</span>{s.waiting ? <span className="fs-step-wait lw-num" title={`${s.waiting} waiting on a person`}>{s.waiting} on a person</span> : null}{s.stalled ? <span className="fs-step-stall lw-num" title={`${s.stalled} with no progress for 8 hours or more`}>{s.stalled} stalled</span> : null}</>;
            return (
              <li key={s.id} data-stalled={s.stalled ? "" : undefined} data-flow-step={s.id}>
                {open ? <button type="button" className="fs-step" onClick={open}>{body}</button> : <span className="fs-step">{body}</span>}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
