"use client";
// A project as one line (cohesive build spec §6): who leads it, what is
// moving in it now, how much of its board is done, and its target day. The
// lead is the chip the project's sheet and board use, so naming one here is
// the same act as naming one there. Opened in place, it says where it stands
// in its lead's own words and what it says against itself.
import { RoleFace } from "../RoleFace";
import { StandingLine } from "../stateWords";
import type { LineProject } from "./lineData";
import { ProjectGlyph } from "./lineAtoms";
import { projectFacts, projectSays } from "./lineFacts";
import { LineBody, ObjectLine, type LineGhost, type ObjectLineProps } from "./ObjectLine";

export { ProjectGlyph, ProjectLead, ProjectState, ProjectWork } from "./lineAtoms";
export type { LineProject } from "./lineData";

const DIM = "var(--sol-text-dim)";

function ProjectBody({ says }: { says: NonNullable<ReturnType<typeof projectSays>> }) {
  return (
    <>
      {says.standing && <div className="flex min-w-0 items-center gap-2 text-[12px]" data-project-standing><span className="shrink-0" style={{ color: DIM }}>Where it stands</span><StandingLine standing={says.standing} size="md" className="min-w-0" /></div>}
      {says.trouble && <p className="mt-1 text-[12px]" style={{ color: "var(--sol-orange)" }} data-project-trouble>{says.trouble.charAt(0).toUpperCase() + says.trouble.slice(1)}</p>}
    </>
  );
}

export type ProjectLineProps = {
  project: LineProject;
  now: number;
  /** The lead picker: on for a project the store holds. */
  editable?: boolean;
  ghost?: LineGhost;
  /** The title opens the project's sheet: on unless the line is a proposal's
   *  project that does not exist yet. A real project a proposal would move
   *  opens like any other. */
  opens?: boolean;
} & Pick<ObjectLineProps, "depth" | "expanded" | "onToggle" | "sub" | "selected">;

export function ProjectLine({ project, now, editable = true, ghost, opens = !ghost, expanded, onToggle, depth = 0, ...rest }: ProjectLineProps) {
  const says = expanded && !ghost ? projectSays(project, now) : null;
  return (
    <>
      <ObjectLine
        kind="project"
        id={project.id}
        target={opens ? { kind: "project", ref: project.short_id || project.id } : undefined}
        glyph={<ProjectGlyph project={project} ghost={!!ghost} />}
        title={project.title}
        {...projectFacts(project, now, editable && !ghost)}
        face={project.lead ? <RoleFace role={project.lead} size={16} /> : null}
        ghost={ghost}
        depth={depth}
        expanded={expanded}
        onToggle={onToggle}
        data-line-ref={project.short_id || undefined}
        {...rest}
      />
      {says && <LineBody depth={depth} data-project-body={project.short_id ?? project.id}><ProjectBody says={says} /></LineBody>}
    </>
  );
}
