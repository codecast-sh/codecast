"use client";

/**
 * Chapter 8, Automate: the triggers page's horizon rail and rows, then the
 * workflow the CI trigger starts, as its graph and its run panel, and the
 * lead's pinned state once the run waits at the review gate. The fire badge
 * counts down with the film; Pause and Resume flip the row locally.
 */

import { useMemo, useState } from "react";
import { ThreadStatePanel } from "@/components/ThreadStatePanel";
import { TriggerRowItem, type TriggerVerbAction } from "@/components/TriggerRow";
import { HorizonRail } from "@/components/triggers/HorizonRail";
import { WorkflowGraphView } from "@/components/WorkflowGraphView";
import { WorkflowRunPanel } from "@/components/WorkflowContextPanel";
import type { TaskRow } from "@/components/triggerTasks";
import { nodeStatuses, triggerRows, WAITING_STATE, WORKFLOW, workflowRun, type RunPhase, type TriggerEdits } from "../fixtures/automation";
import { SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { DeskRouter } from "./desk";
import { AUTO_AT, phaseAt } from "./automation.motion";
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

/** The graph is React Flow: a fixed box its measurements can trust, and no pointer, since its hit testing is wrong under the camera's transform. */
const GRAPH = { width: 470, height: 196 };

export function AutomationSurface({ now }: PartProps) {
  // The countdown's seconds, then the run's phase: each a discrete step of the film.
  // Ten minutes out until the surface comes into view, then the last seconds.
  const fireIn = useFilmTime((t) => (t < AUTO_AT.fires - 4 ? 600 : Math.max(0, Math.ceil(AUTO_AT.fires - t))));
  const phase = useFilmTime(phaseAt);
  const before = useFilmTime((t) => t < AUTO_AT.fires - 6);
  const [edits, setEdits] = useState<TriggerEdits>({});
  if (before && Object.keys(edits).length > 0) setEdits({});

  // The fire badge measures from its own clock, read when it mounts, so the
  // countdown row mounts afresh each step with run_at taken from the same clock.
  const step = `${phase}:${fireIn}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wall = useMemo(() => Date.now(), [step]);
  const rows = triggerRows(now, wall, phase, fireIn, edits);
  const run = workflowRun(now, phase);
  const statuses = useMemo(() => nodeStatuses(phase), [phase]);

  const act: TriggerVerbAction = (id, verb) => setEdits((e) => ({ ...e, [id]: { ...e[id], status: VERB_STATUS[verb] } }));

  return (
    <DeskRouter>
      <div className="flex h-full flex-col text-sol-text">
        <div className="px-5 pt-3" {...fly("auto/automation.rail")}>
          <HorizonRail tasks={rows.map((r) => r.task)} now={wall} onOpenPastRun={noop} />
        </div>
        <div className="mt-2 border-t border-sol-border/30">
          {rows.map((row, i) => (
            <div key={row.task._id} data-hero-live="" {...fly(`auto/automation.row:${i}`)}>
              <TriggerRowItem key={i === 0 ? step : undefined} row={row} variant="page" isNext={i === 0 && phase === "armed"} onOpen={noop} actions={act} />
            </div>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 gap-4 px-5 pt-3">
          <div
            className="shrink-0 overflow-hidden rounded-lg border border-sol-border/40"
            style={{ ...GRAPH, pointerEvents: "none" }}
            {...fly("auto/automation.graph")}
          >
            <WorkflowGraphView nodes={WORKFLOW.nodes} edges={WORKFLOW.edges} nodeStatuses={statuses} currentNodeId={run.current_node_id} chrome={false} />
          </div>
          <div className="min-w-0 flex-1 overflow-hidden" {...fly("auto/automation.run")}>
            <div className="overflow-hidden rounded-lg border border-sol-border/40">
              <WorkflowRunPanel run={run} workflow={WORKFLOW} defaultExpanded />
            </div>
          </div>
        </div>
        {(phase === "gate" || phase === "rearmed") && (
          <div className="px-3 pb-2" {...fly("auto/automation.state")}>
            <ThreadStatePanel
              conversationId={SESSIONS.lead.id}
              threadState={WAITING_STATE.text}
              threadStateAt={wall - 4_000}
              threadStateMsgCount={WAITING_STATE.messages}
              threadStateStatus={WAITING_STATE.status}
              messageCount={WAITING_STATE.messages}
              canClear={false}
            />
          </div>
        )}
      </div>
    </DeskRouter>
  );
}
