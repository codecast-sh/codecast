"use client";
// One summary per kind (cohesive build spec D13, D14): the object's name, its
// head line facts in the fixed order (owner · state · measure · date), what
// it serves and how much carries it. The same facts its line shows, read the
// same way, for a hover card, a sheet's head and a map card at middle zoom.
// Read only: the pickers live on the line and the sheet.
import { Fragment, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { ProjectItem } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useBoardTasks, useInitiatives, useTasksBackfilled } from "../../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { initiativesOfProject, subInitiatives } from "../../../lib/initiatives";
import { AssigneeFace } from "../../identity/AssigneeFace";
import { RoleFace } from "../RoleFace";
import { rolesInTreeOrder } from "../staffingModel";
import type { OrgRole } from "../orgTypes";
import { GoalGlyph, ProjectGlyph } from "./lineAtoms";
import { lineProjectOf } from "./lineData";
import { goalFacts, projectFacts, type LineFacts } from "./lineFacts";
import { useLineOpen } from "./lineOpen";
import { useLineTree } from "./lineTree";
import { usePersonHead, useRoleHead } from "./useHeads";

const DIM = "var(--sol-text-dim)";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.color ?? ""}|${p.target_date ?? ""}`;
type Named = { kind: OrgObjectKind; ref: string; title: string };

/** A name in a summary that opens its own sheet. */
function NameLink({ n }: { n: Named }) {
  const { onLinkClick } = useLineOpen();
  return <Link href={objectHref(n.kind, n.ref)} onClick={onLinkClick(n)} className="truncate no-underline hover:underline underline-offset-[3px]" style={{ color: "var(--sol-text-secondary)" }} data-summary-serves-item={n.ref}>{n.title}</Link>;
}

/** The frame every kind shares. */
export function SummaryFrame({ kind, glyph, title, idRef, facts, serves, carried }: { kind: OrgObjectKind; glyph: ReactNode; title: string; idRef?: string; facts: LineFacts; serves: Named[]; carried: string | null }) {
  const cells = [facts.owner, facts.state, facts.measure, facts.date].filter((c) => c != null && c !== false);
  return (
    <div className="min-w-0 text-[12px]" data-object-summary={kind}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex w-5 shrink-0 justify-center" aria-hidden>{glyph}</span>
        <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: "var(--sol-text)" }} data-summary-title>{title}</span>
        {idRef && <span className="shrink-0 font-mono text-[10.5px]" style={{ color: DIM }}>{idRef}</span>}
      </div>
      {cells.length > 0 && (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} data-summary-facts>
          {cells.map((c, i) => <Fragment key={i}>{i > 0 && <span aria-hidden style={{ color: DIM }}>·</span>}<span className="inline-flex min-w-0 items-center">{c}</span></Fragment>)}
        </div>
      )}
      {serves.length > 0 && (
        <div className="mt-1.5 flex min-w-0 items-baseline gap-2" data-summary-serves>
          <span className="shrink-0" style={{ color: DIM }}>Serves</span>
          <span className="flex min-w-0 flex-wrap gap-x-2">{serves.map((n) => <NameLink key={n.ref} n={n} />)}</span>
        </div>
      )}
      {carried && (
        <div className="mt-1 flex min-w-0 items-baseline gap-2" data-summary-carried>
          <span className="shrink-0" style={{ color: DIM }}>Carried by</span>
          <span style={{ color: "var(--sol-text-muted)" }}>{carried}</span>
        </div>
      )}
    </div>
  );
}

const goalNamed = (g: InitiativeRow): Named => ({ kind: "initiative", ref: g.short_id || g._id, title: g.title });

export function GoalSummary({ goal }: { goal: InitiativeRow }) {
  const all = useInitiatives();
  const now = useCoarseNow(60_000);
  const parent = goal.parent_initiative_id ? all.find((g) => g._id === goal.parent_initiative_id) : undefined;
  const subs = subInitiatives(all, goal._id).length;
  const carried = [goal.project_ids.length ? plural(goal.project_ids.length, "project", "projects") : null, subs ? plural(subs, "goal", "goals") : null].filter(Boolean).join(", ");
  return <SummaryFrame kind="initiative" glyph={<GoalGlyph />} title={goal.title} idRef={goal.short_id} facts={goalFacts(goal, now, false)} serves={parent ? [goalNamed(parent)] : []} carried={carried || null} />;
}

export function ProjectSummary({ project }: { project: ProjectItem }) {
  const all = useInitiatives();
  const tree = useLineTree();
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const now = useCoarseNow(60_000);
  const roles = useMemo(() => rolesInTreeOrder(tree), [tree]);
  const line = lineProjectOf(project, { tree, roles, tasks, tasksCounted: counted });
  const working = roles.filter((r) => r.scope.project_ids.includes(project._id) && r.sessions.length > 0);
  return <SummaryFrame kind="project" glyph={<ProjectGlyph project={line} />} title={project.title} idRef={project.short_id} facts={projectFacts(line, now, false)} serves={initiativesOfProject(all, project._id).map(goalNamed)} carried={working.length ? plural(working.length, "role", "roles") : null} />;
}

export function RoleSummary({ role }: { role: OrgRole }) {
  const head = useRoleHead(role);
  return <SummaryFrame kind="role" glyph={<RoleFace role={role} size={18} />} title={role.name} idRef={`@${role.handle}`} facts={head.facts} serves={head.serves} carried={head.carried} />;
}

/** `person` is a user id or a handle. */
export function PersonSummary({ person }: { person: string }) {
  const head = usePersonHead(person);
  if (!head) return null;
  return <SummaryFrame kind="person" glyph={<AssigneeFace info={{ name: head.name, image: head.image }} size={18} hover={false} />} title={head.name} facts={head.facts} serves={head.serves} carried={head.carried} />;
}

/** The summary of whatever a ref names, read from the store; nothing while it has not arrived. */
export function ObjectSummary({ kind, ref }: { kind: OrgObjectKind; ref: string }) {
  const all = useInitiatives();
  const tree = useLineTree();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const r = ref.replace(/^@/, "").toLowerCase();
  if (kind === "initiative") { const g = all.find((x) => x._id === ref || x.short_id === r); return g ? <GoalSummary goal={g} /> : null; }
  if (kind === "project") { const p = projects.find((x) => x._id === ref || x.short_id === r); return p ? <ProjectSummary project={p} /> : null; }
  if (kind === "role") { const role = tree?.roles.find((x) => x._id === ref || x.short_id === r || x.handle === r); return role ? <RoleSummary role={role} /> : null; }
  return <PersonSummary person={ref} />;
}
