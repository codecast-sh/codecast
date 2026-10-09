"use client";
// The Org canvas (essence spec §4): one scrolling page that answers who
// carries the work, what it is for, and what waits on the viewer. Top to
// bottom: Waits on you (its slot), the mission, the adopted goals with the
// projects that serve them, then a band per person with the roles that answer
// to them, and a No lead band. Paints from the store: the screen mounts the
// feeders, and a skeleton shows only while the cache is cold.
import "./canvas.css";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useInboxStore, type PlanItem, type ProjectItem } from "../../../store/inboxStore";
import { useBoardTasks, useInitiatives, useTasksBackfilled } from "../../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { lineTreeSig } from "../lines/lineTree";
import type { OrgTree } from "../orgTypes";
import { Band } from "./Band";
import { panelKey, type PanelRef } from "../panelTarget";
import { canvasModel, canvasTreeSig, isOpenTarget, type CanvasGhosts, type CanvasModel } from "./canvasModel";
import { DraftsTile, GoalTile, GoalUpdateFeeder } from "./GoalTile";
import { MissionLine } from "./MissionLine";
import { PersonHeader } from "./PersonHeader";
import { UnledCard } from "./ProjectBlock";
import { RoleCard } from "./RoleCard";

export type OrgCanvasProps = {
  /** What the panel holds now: its card wears the ring and is scrolled into view. */
  openRef: PanelRef | null | undefined;
  onOpen: (ref: PanelRef) => void;
  /** An open proposal's changes, drawn in place while it is open. */
  ghosts?: CanvasGhosts | null;
  /** The Waits on you list, drawn first. */
  waits?: ReactNode;
  /** Roles with a row in that list: their cards say Waiting on you. */
  waitingRoleIds?: ReadonlySet<string>;
};

const NO_WAITING: ReadonlySet<string> = new Set();
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.updated_at}`;
const planSig = (p: PlanItem) => `${p.title}|${p.status}|${p.short_id}|${p.owner_role_id ?? ""}|${p.progress?.done ?? ""}/${p.progress?.total ?? ""}/${p.progress?.in_progress ?? ""}`;

/** The org tree, repainting only when something the canvas draws changed. */
function useCanvasTree(): OrgTree | null {
  const sig = useInboxStore((s) => lineTreeSig(s.orgTree) + canvasTreeSig(s.orgTree));
  return useMemo(() => useInboxStore.getState().orgTree ?? null, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useCanvasModel(ghosts: CanvasGhosts | null | undefined, waitingRoleIds: ReadonlySet<string>): { model: CanvasModel; cold: boolean } {
  const tree = useCanvasTree();
  const goals = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const plans = useWorkspaceCollection<PlanItem>("plans", planSig);
  const tasks = useBoardTasks();
  const tasksCounted = useTasksBackfilled();
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const model = useMemo(
    () => canvasModel({ tree, goals, projects, plans, tasks, tasksCounted, waitingRoleIds, viewerId, ghosts }),
    [tree, goals, projects, plans, tasks, tasksCounted, waitingRoleIds, viewerId, ghosts],
  );
  // The tree says who leads what: without it every project would read as
  // unled, so nothing paints until it arrives.
  return { model, cold: !tree };
}

export function OrgCanvas({ openRef, onOpen, ghosts, waits, waitingRoleIds = NO_WAITING }: OrgCanvasProps) {
  const { model, cold } = useCanvasModel(ghosts, waitingRoleIds);
  const now = useCoarseNow(60_000);
  const scroller = useRef<HTMLDivElement>(null);
  const openKey = panelKey(openRef);

  // The open object's card is scrolled into view, only as far as it takes,
  // again once a cold load's real cards mount.
  useEffect(() => {
    if (!openKey) return;
    const el = scroller.current?.querySelector<HTMLElement>("[data-open]");
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [openKey, cold]);

  if (cold) return <CanvasSkeleton waits={waits} />;
  const { mission, goals, drafts, bands, unled } = model;
  return (
    <div ref={scroller} className="oc-scroll" data-org-canvas>
      <div className="oc-in">
        {waits ? <div className="oc-waits">{waits}</div> : null}
        {mission && <MissionLine mission={mission} />}
        {(goals.length > 0 || drafts > 0) && (
          <div className="oc-goals">
            {goals.map((g) => <GoalTile key={g.id} goal={g} open={isOpenTarget(openRef, "initiative", g.ref, g.id)} onOpen={onOpen} />)}
            <DraftsTile count={drafts} />
          </div>
        )}
        {goals.filter((g) => g.latestUpdateId).map((g) => <GoalUpdateFeeder key={g.id} id={g.id} />)}
        {bands.map(({ person, roles }) => (
          <Band
            key={person.id}
            id={person.id}
            header={<PersonHeader person={person} roles={roles.length} open={isOpenTarget(openRef, "person", person.ref, person.id)} onOpen={() => onOpen({ kind: "person", ref: person.ref })} />}
          >
            {roles.length ? roles.map((r) => <RoleCard key={r.id} role={r} now={now} open={isOpenTarget(openRef, "role", r.ref, r.id)} onOpen={onOpen} />) : null}
          </Band>
        ))}
        {unled.length > 0 && (
          <Band unled id="unled" header={<div className="oc-phead"><span className="oc-pname">No lead yet</span></div>}>
            {unled.map((p) => <UnledCard key={p.id} project={p} openRef={openRef} onOpen={onOpen} />)}
          </Band>
        )}
      </div>
    </div>
  );
}

/** The canvas's shape while the cache is cold: never shown over cached rows. */
function CanvasSkeleton({ waits }: { waits?: ReactNode }) {
  return (
    <div className="oc-scroll" data-org-canvas data-canvas-skeleton aria-busy="true">
      <div className="oc-in">
        {waits ? <div className="oc-waits">{waits}</div> : null}
        <div className="oc-skel" style={{ height: 26, width: "min(560px, 80%)", marginBottom: 14 }} />
        <div className="oc-goals">{[0, 1, 2].map((i) => <div key={i} className="oc-skel" style={{ height: 132 }} />)}</div>
        {[0, 1].map((b) => (
          <div key={b} className="oc-band">
            <div className="oc-skel" style={{ height: 40, width: 260, marginBottom: 12, borderRadius: 999 }} />
            <div className="oc-grid">{[0, 1, 2].map((i) => <div key={i} className="oc-skel" style={{ height: 180, position: "relative" }} />)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
