"use client";
// The cells a line draws, one component each, so a line, a sheet's head and
// a summary say a fact in the same words (cohesive build spec §6, D13). The
// facts are put together in lineFacts.ts; the lines themselves live beside
// this file. State words are lowercase in every cell, so one column reads
// as one vocabulary ("on track", "active", "paused", "working").
import { useMemo, type ReactNode } from "react";
import { Flag } from "lucide-react";
import { INITIATIVE_STATUSES, metricReadings, metricTrends, type InitiativeOwner, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../../../store/inboxStore";
import { useRolesAndPeopleOptions } from "../../../hooks/useRolesAndPeopleOptions";
import { useTeamRosterIdentity } from "../../../hooks/useTeamRoster";
import { ownerId } from "../../../lib/initiatives";
import { projectDotClass } from "../../../lib/projectColors";
import { projectStatusOf } from "../../../lib/projectStatus";
import { cn } from "../../../lib/utils";
import { ProjectLeadChip } from "../../charter/ProjectLeadChip";
import { HealthChip, MetricTile, OwnerChip, StatusGlyph } from "../../initiatives/InitiativeAtoms";
import { IntentPickChip } from "../../initiatives/IntentHeader";
import { StateWords } from "../stateWords";
import { GOAL_ENDED, GOAL_STATUS_WORD, goalSaysHealth, goalStateWord } from "./goalWords";
import { RoleFace } from "../RoleFace";
import { PRESENCE_COLOR, standingLineOf } from "../orgMeta";
import type { OrgPerson, OrgRole } from "../orgTypes";
import type { LineProject } from "./lineData";

const DIM = "var(--sol-text-dim)";

// ---------------------------------------------------------------- goals

export const GoalGlyph = ({ ghost }: { ghost?: boolean }) => <Flag className="h-3.5 w-3.5" style={{ color: ghost ? "var(--sol-violet)" : "var(--sol-text-muted)" }} />;

export { GOAL_ENDED };

/** The goal's state as a face: its health chip once its owner has said how it
 *  is going (until it ends), else its status glyph and word. The words are
 *  goalStateWord's, so the line, the map card and the state line agree. */
export function GoalStateFace({ goal, now, dated = true, className }: { goal: InitiativeRow; now: number; /** The health's date after its word (a line); a tight card leaves it out. */ dated?: boolean; className?: string }) {
  if (goalSaysHealth(goal)) return <HealthChip health={goal.health} at={dated ? goal.health_at : undefined} now={now} lower className={className} />;
  return <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap", className)} style={{ color: "var(--sol-text-secondary)" }} data-goal-status={goal.status}><StatusGlyph status={goal.status} className="h-3 w-3" />{goalStateWord(goal)}</span>;
}

/** The goal's status, read and set in place: the one status picker the line,
 *  the sheet and the goal's page share. Once its owner has said how it is
 *  going (its health and when) that word is what it shows, whatever its
 *  status, until the goal ends: the same word the company's state line counts
 *  and the document opens on. Otherwise the status itself. A surface that
 *  draws the health on its own passes its face. */
export function GoalStatusPick({ goal, now, editable = true, children }: { goal: InitiativeRow; now: number; editable?: boolean; children?: ReactNode }) {
  const options = useMemo(() => INITIATIVE_STATUSES.map((s) => ({ key: s, label: GOAL_STATUS_WORD[s], face: <StatusGlyph status={s} /> })), []);
  const face = children ?? <GoalStateFace goal={goal} now={now} />;
  if (!editable) return face;
  return (
    <IntentPickChip data-initiative-pick="status" options={options} value={goal.status} width="w-44" onPick={(key) => { if (key && key !== goal.status) useInboxStore.getState().updateInitiative(goal._id, { status: key as InitiativeStatus }); }}>
      {face}
    </IntentPickChip>
  );
}

/** Who owns the goal, a person or a role from one list (R5), set in place:
 *  the one owner picker the line, the sheet and the goal's page share. */
export function GoalOwnerPick({ goal, editable = true, size = 16 }: { goal: InitiativeRow; editable?: boolean; size?: number }) {
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const options = useMemo(() => [{ key: "", label: "No owner" }, ...roles, ...people], [roles, people]);
  const roleIds = useMemo(() => new Set(roles.map((r) => r.key)), [roles]);
  if (!editable) return <OwnerChip owner={goal.owner} size={size} />;
  const pick = (key: string) => {
    if (key === (ownerId(goal.owner) ?? "")) return;
    const owner: InitiativeOwner | null = !key ? null : roleIds.has(key) ? { kind: "role", role_id: key } : { kind: "user", user_id: key };
    useInboxStore.getState().updateInitiative(goal._id, { owner });
  };
  return (
    <IntentPickChip data-initiative-pick="owner" options={options} value={ownerId(goal.owner) ?? ""} onPick={pick}>
      <OwnerChip owner={goal.owner} size={size} />
    </IntentPickChip>
  );
}

/** The number a goal is read by, now against its target, with its trend; nothing when it has none. */
export function GoalMeasure({ goal, now }: { goal: InitiativeRow; now: number }) {
  const reading = metricReadings(goal)[0];
  if (!reading) return null;
  return <MetricTile reading={reading} trend={metricTrends(goal)[reading.key]} now={now} size="line" named={false} />;
}

// ---------------------------------------------------------------- projects

/** How much of the board is done: "12 of 21 tasks". */
export function ProjectWork({ counts }: { counts: LineProject["counts"] }) {
  if (counts === "counting") return <span className="italic" style={{ color: DIM }} title="Counting: the task cache is still filling" data-project-work="counting">counting</span>;
  if (!counts) return null;
  const total = counts.open + counts.done;
  return <span style={{ color: "var(--sol-text-secondary)" }} data-project-work={`${counts.done}/${total}`}>{counts.done} <span style={{ color: DIM }}>of</span> {total} <span style={{ color: DIM }}>tasks</span></span>;
}

/** Whether a project's status says something: "active" is the default every
 *  project starts in, so only paused, planning and done are worth a word. */
export const projectStatusSays = (status: string | null | undefined): boolean => !!status && status !== "active";

/** What is moving in it now, in the map's words; else its status when that
 *  says something, with a dot the way a goal's health has one. Empty for a
 *  quiet active project, so the column only speaks when something happens. */
export function ProjectState({ project }: { project: Pick<LineProject, "sessions" | "status"> }) {
  const live = project.sessions && (project.sessions.working || project.sessions.needs_input);
  if (live) return <StateWords counts={project.sessions!} max={1} className="!text-[11.5px]" />;
  if (!projectStatusSays(project.status)) return null;
  const s = projectStatusOf(project.status);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap" style={{ color: "var(--sol-text-secondary)" }} data-project-status={project.status}>
      <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full bg-current", s.color)} aria-hidden />
      {s.label.toLowerCase()}
    </span>
  );
}

/** The lead: the editable chip when the project is in the store, its face and name otherwise. */
export function ProjectLead({ project, editable }: { project: Pick<LineProject, "id" | "lead">; editable: boolean }) {
  if (editable) return <ProjectLeadChip projectId={project.id} size="xs" editable className="max-w-full" />;
  if (!project.lead) return <span className="italic text-[11.5px]" style={{ color: DIM }} data-project-lead="none">No lead</span>;
  return <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-secondary)" }} data-project-lead={project.lead.handle}><RoleFace role={project.lead} size={14} /><span className="truncate">{project.lead.name}</span></span>;
}

export const ProjectGlyph = ({ project, ghost }: { project: Pick<LineProject, "color" | "title">; ghost?: boolean }) => (
  <span className={cn("h-2 w-2 rotate-45 rounded-[2px]", ghost ? "" : projectDotClass(project))} style={ghost ? { background: "var(--sol-violet)" } : undefined} data-project-glyph />
);

// ---------------------------------------------------------------- roles

/** Its state in one word and colour: paused, the standing agent's declared word, or its sessions. */
export function RoleState({ role }: { role: OrgRole }) {
  if (role.status === "paused") return <span style={{ color: "var(--sol-yellow)" }} data-role-state="paused">paused</span>;
  const standing = standingLineOf(role.standing);
  if (standing) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={standing.text ?? undefined} data-role-state={standing.label}>
        <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: standing.color }} aria-hidden />
        <span className="truncate" style={{ color: standing.color }}>{standing.label.toLowerCase()}</span>
      </span>
    );
  }
  return <StateWords counts={role.counts} max={1} className="!text-[11.5px]" />;
}

// ---------------------------------------------------------------- people

export function PersonPresence({ presence }: { presence?: OrgPerson["presence"] }) {
  if (!presence) return null;
  return (
    <span className="inline-flex items-center gap-1.5" data-person-presence={presence}>
      <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[presence] }} aria-hidden />
      <span style={{ color: presence === "offline" ? DIM : "var(--sol-text-muted)" }}>{presence}</span>
    </span>
  );
}
