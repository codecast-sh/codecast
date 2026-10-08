"use client";
// The cells a line draws, one component each, so a line, a sheet's head and
// a summary say a fact in the same words (cohesive build spec §6, D13). The
// facts are put together in lineFacts.ts; the lines themselves live beside
// this file. State words are lowercase in every cell, so one column reads
// as one vocabulary ("on track", "active", "paused", "working").
import { useMemo, type ReactNode } from "react";
import { Flag } from "lucide-react";
import { INITIATIVE_STATUSES, INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, type InitiativeOwner, type InitiativeRow, type InitiativeStatus } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../../../store/inboxStore";
import { useRolesAndPeopleOptions } from "../../../hooks/useRolesAndPeopleOptions";
import { useTeamRosterIdentity } from "../../../hooks/useTeamRoster";
import { ownerId } from "../../../lib/initiatives";
import { projectDotClass } from "../../../lib/projectColors";
import { cn } from "../../../lib/utils";
import { ProjectLeadChip } from "../../charter/ProjectLeadChip";
import { HealthChip, MetricTile, OwnerChip, StatusGlyph } from "../../initiatives/InitiativeAtoms";
import { IntentPickChip } from "../../initiatives/IntentHeader";
import { StateWords } from "../stateWords";
import { RoleFace } from "../RoleFace";
import { PRESENCE_COLOR, standingLineOf } from "../orgMeta";
import type { OrgPerson, OrgRole } from "../orgTypes";
import type { LineProject } from "./lineData";

const DIM = "var(--sol-text-dim)";

// ---------------------------------------------------------------- goals

export const GoalGlyph = ({ ghost }: { ghost?: boolean }) => <Flag className="h-3.5 w-3.5" style={{ color: ghost ? "var(--sol-violet)" : "var(--sol-text-muted)" }} />;

/** A goal's status in the words this screen uses. "Proposed" names an open
 *  proposal everywhere here, so a goal nobody has started says so plainly. */
const GOAL_STATUS_WORD: Record<InitiativeStatus, string> = { ...INITIATIVE_STATUS_LABEL, proposed: "Not started" };
/** A goal that has ended: completed or cancelled. */
export const GOAL_ENDED: ReadonlySet<string> = new Set<InitiativeStatus>(["completed", "cancelled"]);

/** The goal's status, read and set in place: the one status picker the line,
 *  the sheet and the goal's page share. Once its owner has said how it is
 *  going (its health and when) that word is what it shows, whatever its
 *  status, until the goal ends: the same word the company's state line counts
 *  and the document opens on. Otherwise the status itself. A surface that
 *  draws the health on its own passes its face. */
export function GoalStatusPick({ goal, now, editable = true, children }: { goal: InitiativeRow; now: number; editable?: boolean; children?: ReactNode }) {
  const options = useMemo(() => INITIATIVE_STATUSES.map((s) => ({ key: s, label: GOAL_STATUS_WORD[s], face: <StatusGlyph status={s} /> })), []);
  const face = children ?? (goal.health !== "none" && !GOAL_ENDED.has(goal.status)
    ? <HealthChip health={goal.health} at={goal.health_at} now={now} lower />
    : <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-secondary)" }} data-goal-status={goal.status}><StatusGlyph status={goal.status} className="h-3 w-3" />{GOAL_STATUS_WORD[goal.status].toLowerCase()}</span>);
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

/** What is moving in it now, in the map's words; its status when nothing is. */
export function ProjectState({ project }: { project: Pick<LineProject, "sessions" | "status"> }) {
  const live = project.sessions && (project.sessions.working || project.sessions.needs_input);
  if (live) return <StateWords counts={project.sessions!} max={1} className="!text-[11.5px]" />;
  return project.status ? <span style={{ color: DIM }} data-project-status={project.status}>{project.status.replace(/_/g, " ").toLowerCase()}</span> : null;
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
