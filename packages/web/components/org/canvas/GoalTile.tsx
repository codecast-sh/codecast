"use client";
// An adopted goal as a tile (essence spec §4.2): its health word once an
// update exists, the owner's face, the title, the latest update in two lines
// at most, then each project that serves it and who leads it. The drafts fold
// into one dashed tile that opens the Goals view.
import Link from "next/link";
import { INITIATIVE_HEALTH_LABEL, type InitiativeUpdateHealth } from "@codecast/shared/contracts/initiative";
import { useInitiativeUpdates, useSyncInitiativeUpdates } from "../../../hooks/useInitiatives";
import type { PanelRef } from "../panelTarget";
import type { CanvasGoal } from "./canvasModel";
import { Face } from "./PersonHeader";
import { onCardKey } from "./cardParts";

/** On track, At risk, Off track: green, yellow, red, the only other colours on the canvas. */
export function HealthWord({ health }: { health: InitiativeUpdateHealth }) {
  return <span className="oc-health" data-health={health}><i aria-hidden />{INITIATIVE_HEALTH_LABEL[health]}</span>;
}

/** Feeds one goal's updates into the store while the canvas shows it. */
export function GoalUpdateFeeder({ id }: { id: string }) {
  useSyncInitiativeUpdates(id);
  return null;
}

/** The goal's latest update, as the store holds it (it may arrive after first paint). */
function LatestUpdate({ goal }: { goal: CanvasGoal }) {
  const updates = useInitiativeUpdates(goal.id);
  const latest = updates.find((u) => u._id === goal.latestUpdateId) ?? updates[0];
  return latest?.body.trim() ? <div className="oc-goal-update" data-canvas-update={latest._id}>{latest.body.trim()}</div> : null;
}

export function GoalTile({ goal, open, onOpen }: { goal: CanvasGoal; open: boolean; onOpen: (ref: PanelRef) => void }) {
  const openIt = () => onOpen({ kind: "initiative", ref: goal.ref });
  return (
    <div role="button" tabIndex={0} className="oc-card oc-goal" data-canvas-open-key={`initiative:${goal.id}`} data-canvas-goal={goal.ref} {...(open ? { "data-open": "" } : {})} onClick={openIt} onKeyDown={onCardKey(openIt)}>
      {(goal.health || goal.owner) && (
        <div className="oc-goal-row">
          {goal.health && <HealthWord health={goal.health} />}
          {goal.owner && <Face face={goal.owner} size={18} />}
        </div>
      )}
      <div className="oc-goal-title">{goal.title}</div>
      <LatestUpdate goal={goal} />
      <div className="oc-goal-serving">
        {goal.serving.length === 0 && <span className="oc-none">No project serves this yet</span>}
        {goal.serving.map((p) => (
          <div key={p.id} className="oc-serve" data-canvas-serving={p.ref}>
            {p.lead && <Face face={p.lead} size={16} />}
            <b>{p.title}</b>
            {p.lead !== undefined && <span className="oc-serve-lead">· {p.lead ? p.lead.name : "No lead"}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "7 draft goals · open in Goals →": absent with no drafts. */
export function DraftsTile({ count }: { count: number }) {
  if (count <= 0) return null;
  return <Link href="/org/goals" className="oc-drafts" data-canvas-drafts={count}>{count} draft {count === 1 ? "goal" : "goals"} · open in Goals →</Link>;
}
