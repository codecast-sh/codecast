"use client";

/**
 * Chapter 8, Automate: the workflow the CI trigger starts, as its graph
 * across the top, the trigger rows with the lead's pinned state under them,
 * and the run panel beside them; the pinned state turns to waiting when the
 * run stops at the review gate. The fire badge
 * counts down with the film; Pause and Resume flip the row locally.
 */

import { useMemo, useState } from "react";
import { ThreadStatePanelView } from "@/components/ThreadStatePanel";
import { TriggerRowItem, type TriggerVerbAction } from "@/components/TriggerRow";
import { WorkflowGraphView } from "@/components/WorkflowGraphView";
import { WorkflowRunPanel } from "@/components/WorkflowContextPanel";
import type { TaskRow } from "@/components/triggerTasks";
import { GRAPH_CROP, nodeStatuses, pinnedState, triggerRows, triggerRuns, WORKFLOW, workflowRun, type RunPhase, type TriggerEdits } from "../fixtures/automation";
import { SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { AUTO_AT, PHASE_CUES, PHASES, phaseAt } from "./automation.motion";
import { FilmSwap } from "../film";
import { clamp, fade } from "../timeline";
import type { PartProps } from "./contract";

const noop = () => {};

/** What each verb does to a fixture row: the status the store's action would write. */
const VERB_STATUS: Record<Parameters<TriggerVerbAction>[1], TaskRow["status"]> = {
  pause: "paused",
  resume: "scheduled",
  runNow: "running",
  cancel: "completed",
  reactivate: "scheduled",
};

/**
 * The graph is React Flow: a fixed box its measurements can trust, and no
 * pointer, since its hit testing is wrong under the camera's transform. It
 * shows the run's working stretch (GRAPH_CROP), so the fit lands the node
 * labels at a readable size.
 */
const GRAPH = { width: 860, height: 128 };

/** How long a node takes to hand the run's active style to the next one (s). */
const NODE_FADE = 0.35;

function PhaseGraph({ now, phase }: { now: number; phase: RunPhase }) {
  const statuses = useMemo(() => nodeStatuses(phase), [phase]);
  const current = workflowRun(now, phase).current_node_id;
  return useMemo(
    () => <WorkflowGraphView nodes={GRAPH_CROP.nodes} edges={GRAPH_CROP.edges} nodeStatuses={statuses} currentNodeId={current} chrome={false} fitPadding={0.03} />,
    [statuses, current],
  );
}

/**
 * The graph across a change of phase: the next phase's graph is always laid
 * out over the settled one, unseen, and dissolves in across each cue, so a
 * node's active border and fill hand over to the next node rather than
 * jumping in one frame. Both stay mounted, so React Flow has fitted each long
 * before it shows.
 */
function GraphCrossfade({ now }: { now: number }) {
  const base = useFilmTime((t) => {
    const n = PHASE_CUES.filter((c) => t >= c).length;
    return n > 0 && t < PHASE_CUES[n - 1] + NODE_FADE ? n - 1 : n;
  });
  const k = useFilmTime((t) => {
    const n = PHASE_CUES.filter((c) => t >= c).length;
    if (n === 0) return 0;
    const u = (t - PHASE_CUES[n - 1]) / NODE_FADE;
    return u >= 1 ? 0 : Math.round(fade(clamp(u)) * 40) / 40;
  });
  const next = Math.min(base + 1, PHASES.length - 1);
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0">
        <PhaseGraph now={now} phase={PHASES[base]} />
      </div>
      <div className="absolute inset-0 bg-sol-bg" style={{ opacity: k }} aria-hidden>
        <PhaseGraph now={now} phase={PHASES[next]} />
      </div>
    </div>
  );
}

export function AutomationSurface({ now }: PartProps) {
  // The countdown's seconds, then the run's phase: each a discrete step of the film.
  // Ten minutes out until the surface comes into view, then the last seconds.
  const fireIn = useFilmTime((t) => (t < AUTO_AT.fires - 4 ? 600 : Math.max(0, Math.ceil(AUTO_AT.fires - t))));
  const phase = useFilmTime(phaseAt);
  const before = useFilmTime((t) => t < AUTO_AT.fires - 6);
  const [edits, setEdits] = useState<TriggerEdits>({});
  if (before && Object.keys(edits).length > 0) setEdits({});

  // The fire badge measures from its own clock, read when it mounts, so the
  // countdown row mounts afresh with every new run_at (keyed on the step and
  // the wall clock it was taken from), and the two clocks never drift apart.
  const step = `${phase}:${fireIn}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wall = useMemo(() => Date.now(), [step]);

  const act: TriggerVerbAction = (id, verb) => setEdits((e) => ({ ...e, [id]: { ...e[id], status: VERB_STATUS[verb] } }));

  // The rows, the pinned state and the run panel each cross a change of phase as a dissolve with their height eased (FilmSwap), so a run landing in the trigger's history or a step turning green never reflows them in one frame. The countdown still ticks inside the settled rows.
  const rowsAt = (step: number) => triggerRows(now, wall, PHASES[step], fireIn, edits);
  const trigger = (i: number) => (step: number) => {
    const p = PHASES[step];
    const row = rowsAt(step)[i];
    const runs = triggerRuns(now, wall, p);
    return <TriggerRowItem key={i === 0 ? `${step}:${fireIn}@${wall}` : undefined} row={row} variant="page" isNext={i === 0 && p === "armed"} onOpen={noop} actions={act} history={{ runs: runs[row.task._id] ?? [], open: noop }} />;
  };
  const pinnedView = (step: number) => {
    const p = PHASES[step];
    const pinned = pinnedState(p);
    const gate = p === "gate" || p === "rearmed";
    return (
      <ThreadStatePanelView
        key={gate ? "gate" : "run"}
        conversationId={SESSIONS.lead.id}
        threadState={pinned.text}
        threadStateAt={wall - 4_000}
        threadStateMsgCount={pinned.messages}
        threadStateStatus={pinned.status}
        messageCount={pinned.messages}
        now={wall}
        collapsed={false}
        prStatus={null}
        onToggle={noop}
      />
    );
  };

  return (
    <div className="flex h-full flex-col text-sol-text">
      <div
        className="mx-5 mt-4 shrink-0 overflow-hidden rounded-lg border border-sol-border/40"
        {...fly("auto/automation.graph", { ...GRAPH, pointerEvents: "none" })}
      >
        <GraphCrossfade now={now} />
      </div>
      {/* The trigger that starts the run and the lead's pinned state beside the run it started. */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_420px] items-start gap-4 px-5 pt-3">
        <div className="min-w-0">
          {rowsAt(PHASES.indexOf(phase)).map((row, i) => (
            <div key={row.task._id} data-hero-live="" {...fly(`auto/automation.row:${i}`)}>
              <FilmSwap cues={PHASE_CUES} render={trigger(i)} />
            </div>
          ))}
          <div className="-mx-2 mt-1" {...fly("auto/automation.state")}>
            {/* The state is rewritten, not extended: out, then in (through), so two texts never overlap mid-dissolve. */}
            <FilmSwap cues={PHASE_CUES} through render={pinnedView} />
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-lg border border-sol-border/40" {...fly("auto/automation.run")}>
          <FilmSwap cues={PHASE_CUES} render={(step) => <WorkflowRunPanel run={workflowRun(now, PHASES[step])} workflow={WORKFLOW} defaultExpanded />} />
        </div>
      </div>
    </div>
  );
}
