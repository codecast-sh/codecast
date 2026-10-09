"use client";
// A project or plan as the canvas draws it (essence spec §4.2 item 4): its
// title ("plan" muted), "70 of 145 · 4 in progress" linking to its board, a
// 3px progress rule, and "for <goal>" for each adopted goal it serves. Inside
// its lead's card, or as a card of its own in the No lead band.
import type { MouseEvent } from "react";
import Link from "next/link";
import type { PanelRef } from "../panelTarget";
import type { CanvasProject } from "./canvasModel";
import { isOpenTarget } from "./canvasModel";
import { onCardKey } from "./cardParts";

const stop = (e: MouseEvent) => e.stopPropagation();

/** "70 of 145 · 4 in progress". */
export const workWords = (w: NonNullable<CanvasProject["work"]>) => `${w.done} of ${w.total}${w.inProgress ? ` · ${w.inProgress} in progress` : ""}`;

export function ProjectBlock({ project, onOpen }: { project: CanvasProject; onOpen: (ref: PanelRef) => void }) {
  // A plan is not an object of the Org panel: its title opens its page.
  const open = (e: MouseEvent) => { e.stopPropagation(); onOpen({ kind: "project", ref: project.ref }); };
  return (
    <div className="oc-pj" data-canvas-project={project.id}>
      <div className="oc-pj-top">
        {project.kind === "plan"
          ? <Link href={project.href} className="oc-pj-title" onClick={stop}>{project.title}</Link>
          : <button type="button" className="oc-pj-title" onClick={open}>{project.title}</button>}
        {project.kind === "plan" && <span className="oc-pj-kind">plan</span>}
        {project.status && <span className="oc-pj-kind">{project.status}</span>}
        {project.work && (
          <Link href={project.href} className="oc-pj-count" onClick={stop} title={project.counting ? "Still counting" : "Open its board"} {...(project.counting ? { "data-counting": "" } : {})}>
            {workWords(project.work)}
          </Link>
        )}
      </div>
      {project.work && <div className="oc-bar" aria-hidden><span style={{ width: `${Math.round((project.work.done / project.work.total) * 100)}%` }} /></div>}
      {project.goals.length > 0 && (
        <div className="oc-pj-for">
          for{" "}
          {project.goals.map((g, i) => (
            <span key={g.id}>
              {i > 0 && ", "}
              <button type="button" onClick={(e) => { e.stopPropagation(); onOpen({ kind: "initiative", ref: g.ref }); }}>{g.title}</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A project nobody leads, as a card of its own: the block, then "No lead · Pick a lead". */
export function UnledCard({ project, openRef, onOpen }: { project: CanvasProject; openRef: PanelRef | null | undefined; onOpen: (ref: PanelRef) => void }) {
  const isOpen = isOpenTarget(openRef, "project", project.ref, project.id);
  const openIt = () => onOpen({ kind: "project", ref: project.ref });
  return (
    <div
      role="button" tabIndex={0} className="oc-card oc-unled" data-canvas-open-key={`project:${project.id}`}
      {...(isOpen ? { "data-open": "" } : {})}
      onClick={openIt}
      onKeyDown={onCardKey(openIt)}
    >
      <ProjectBlock project={project} onOpen={onOpen} />
      <div className="oc-pj-for">
        No lead ·{" "}
        <button type="button" className="oc-pick" onClick={(e) => { e.stopPropagation(); onOpen({ kind: "project", ref: project.ref, intent: "pick-lead" }); }}>Pick a lead</button>
      </div>
    </div>
  );
}
