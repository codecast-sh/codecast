"use client";
// The Flows stage (doc "Signals to shipped: one pipeline"): the team's live
// flows, one switch over a family of library flows (the main flow, its
// variants, the judge flow), each source routed to one of them. Its head holds
// the switch, the load against its capacity, what is stalled and queued, and
// its hold. Under it three columns: the flows (each with its counts and the
// stations holding work), the drawn flow's map (or its steps table), and what
// the runs just did. Full view gives the map the whole stage. The queue sits
// below. A team with no live flow lands on the library; an address that names
// the steps (their view, a flow, a step or a run) draws them.
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Maximize, Minimize } from "lucide-react";
import { useFlowMapRow } from "../../../../../hooks/useFlowMap";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../../../hooks/useMountEffect";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { processKeyOf } from "../../../../../lib/line/lineGraphs";
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { LIVE_ENTRY, type LiveAtStep } from "../graph/GraphCanvas";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { KeyCap } from "../../../../KeyCap";
import { ProcessView } from "../ProcessView";
import { StepPage } from "../../step/StepPage";
import { StationDrawer } from "../../stages/LineDrawer";
import { FlowsView, LiveFlowHead, LiveFlowWork } from "./FlowsView";
import { FlowList } from "./FlowList";
import { FlowActivity, type ActivityFilter } from "./FlowActivity";
import { useFlowLibrary, type FlowRun } from "../../../../../hooks/useFlowLibrary";
import type { LineViewProps } from "../types";
import "./flowsStage.css";

export const FlowsStage = memo(function FlowsStage(props: LineViewProps) {
  const { space, select, href, workspace, model, selection } = props;
  const { live, runsOf } = useFlowLibrary(space);
  const map = useFlowMapRow(space);
  const [full, setFull] = useState(false);
  const [activity, setActivity] = useState<ActivityFilter>("all");
  // The runs of every flow in the live family, for the activity rail, each named by its flow when the family has more than one.
  const laneLabel = useMemo(() => new Map((map?.lanes ?? []).map((l) => [l.key, l.label])), [map?.lanes]);
  const runs = useMemo(() => {
    const keys = map?.lanes.length ? map.lanes.map((l) => l.key) : live ? [live.flow.slug] : [];
    return keys.flatMap((k) => runsOf.get(k) ?? []);
  }, [map?.lanes, live, runsOf]);
  // The drawn flow's live runs by station, keyed by its graph's node ids (and by label, for a station the graph names
  // under another id), so the map badges each step that holds work.
  const drawnLane = map?.lanes.find((l) => processKeyOf(l.key) === model.graphKey) ?? null;
  const liveAt = useMemo(() => {
    if (!drawnLane) return undefined;
    const byLabel = new Map(model.graph.nodes.map((n) => [model.steps[n.id]?.label ?? n.id, n.id]));
    const out = new Map<string, LiveAtStep>();
    for (const s of drawnLane.steps) {
      if (!s.running && !s.waiting) continue;
      // Runs that have not reached a step yet stand at the entry, which the map draws apart from the steps.
      // A step inside a segment (deploy__wait) stands on the segment the map draws (deploy).
      const id = s.id === LIVE_ENTRY ? LIVE_ENTRY : model.steps[s.id] ? s.id : model.steps[segmentTopOf(s.id)] ? segmentTopOf(s.id) : byLabel.get(s.label);
      if (!id) continue;
      const had = out.get(id);
      out.set(id, had ? { running: had.running + s.running, stalled: had.stalled + s.stalled, waiting: had.waiting + s.waiting } : { running: s.running, stalled: s.stalled, waiting: s.waiting });
    }
    return out;
  }, [drawnLane, model.graph.nodes, model.steps]);
  // A run is tagged with its flow only when that is not the flow drawn beside it.
  const drawnSlug = drawnLane?.key ?? null;
  const flowLabel = useCallback((r: FlowRun) => (laneLabel.size > 1 && r.workflow_slug !== drawnSlug ? laneLabel.get(r.workflow_slug ?? "") ?? null : null), [laneLabel, drawnSlug]);
  // Esc leaves full view once nothing nearer (the step drawer, a lit run, a popover) takes it.
  const drawer = !!selection.step;
  useWatchEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || drawer || selection.run || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      e.preventDefault();
      setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, drawer, selection.run]);
  // With no live flow the landing is the library; an address that names the steps (their view, a flow, a step or a
  // run) draws them.
  const { landing, graph, step, run } = selection;
  if (!live) return landing && !graph && !step && !run ? <FlowsView {...props} /> : <div className="fs"><div className="fs-map" data-mode={selection.mode}><ProcessView {...props} /></div></div>;
  const library: LineSelectionPatch = { view: "flows", item: null, run: null };
  const stalled = (map?.liveFlow?.stalled ?? 0) + (map?.off.stalled ?? 0);
  const drawnFigs = drawnLane ? { running: drawnLane.steps.reduce((n, x) => n + x.running, 0), waiting: drawnLane.steps.reduce((n, x) => n + x.waiting, 0), stalled: drawnLane.steps.reduce((n, x) => n + x.stalled, 0) } : null;
  const expand = (
    <>
    {full && drawnLane && drawnFigs ? (
      <span className="fs-full-name" data-flows-full-name={drawnLane.key}>
        <b>{drawnLane.label}</b>
        {drawnFigs.running ? <span><b className="lw-num">{drawnFigs.running}</b> running</span> : null}
        {drawnFigs.waiting ? <a data-tone="you" href={href({ view: "foryou", process: model.graphKey, step: null, show: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "foryou", process: model.graphKey, step: null, show: null }); }}><b className="lw-num">{drawnFigs.waiting}</b> on a person</a> : null}
        {drawnFigs.stalled ? <span data-tone="bad"><b className="lw-num">{drawnFigs.stalled}</b> stalled</span> : null}
      </span>
    ) : null}
    <button type="button" className="lwg-btn fs-full-btn" data-ghost="" aria-pressed={full} onClick={() => setFull(!full)} title={full ? "Back to every flow (Esc)" : "Full view"} aria-label={full ? "Exit full view" : "Full view"} data-flows-full={full ? "on" : "off"}>
      {full ? <><Minimize className="w-3.5 h-3.5" aria-hidden />Exit <KeyCap size="xs">Esc</KeyCap></> : <><Maximize className="w-3.5 h-3.5" aria-hidden /><span className="fs-full-label">Full view</span></>}
    </button>
    </>
  );
  return (
    <div className="fs" data-flows-stage={live.flow.slug}>
      <section className="fll-live fs-live" data-live-flow={live._id} data-on={live.on ? "" : undefined}>
        <LiveFlowHead live={live} workspace={workspace} stalled={stalled} onStalled={() => setActivity("stalled")} flows={map?.lanes.length} onOpenFlow={(slug) => select({ view: "flows", item: slug, run: null })}>
          <a className="lw-chip fs-lib" href={href(library)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(library); }} data-flows-library-link><BookOpen className="w-3.5 h-3.5" aria-hidden />Library</a>
        </LiveFlowHead>
      </section>
      <div className="fs-app">
        {map ? <FlowList map={map} drawn={model.graphKey} select={select} href={href} /> : null}
        {/* In full view the map moves to the window's own layer (FullView); its place here stays, so leaving puts it back. */}
        <div className="fs-map" data-mode={selection.mode}>{full ? null : <ProcessView {...props} expand={expand} live={liveAt} />}</div>
        <FlowActivity runs={runs} flowLabel={flowLabel} now={workspace.now} href={href} filter={activity} onFilter={setActivity} />
      </div>
      <section className="fll-live fs-work" id="fs-queue"><LiveFlowWork live={live} workspace={workspace} href={href} /></section>
      {full ? (
        <FullView step={selection.step && model.steps[selection.step] ? selection.step : null} model={model} select={select}
          drawer={<StepPage model={model} workspace={workspace} selection={selection} select={select} href={href} pinned={!!props.pinned} />}>
          <div className="fs-map" data-mode={selection.mode}><ProcessView {...props} expand={expand} live={liveAt} /></div>
        </FullView>
      ) : null}
    </div>
  );
});

/** Full view: the map over the whole window, on a layer of its own (a portal, since the stage's containment would hold a
 *  fixed box inside it), with the station a person opens beside it. Esc, or Exit, puts it back. */
function FullView({ step, model, select, drawer, children }: { step: string | null; model: LineViewProps["model"]; select: LineViewProps["select"]; drawer: ReactNode; children: ReactNode }) {
  // The page's own station drawer sits under this layer while it is up: marked, so it draws nothing there.
  useMountEffect(() => {
    document.documentElement.toggleAttribute("data-flows-full", true);
    return () => document.documentElement.toggleAttribute("data-flows-full", false);
  });
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="lw-widget fs-full" data-drawer={step ? "" : undefined} data-flows-full-layer="">
      {children}
      {step ? <StationDrawer key={`step:${step}`} model={model} at={step} select={select}>{drawer}</StationDrawer> : null}
    </div>,
    document.body,
  );
}
