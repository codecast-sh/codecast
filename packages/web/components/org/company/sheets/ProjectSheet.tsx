"use client";
// A project's sheet (cohesive build spec §5.3), in the order every project
// reads: the frame's head (lead, status, tasks done, target day; the goals it
// serves; Ask its lead), then What it is for, Where it stands in its lead's
// own dated words, Now, Carried by, Work with the way to the board, and
// folded at the foot its Charter and its Activity. The board keeps the daily
// work (D10); this is the project read whole.
import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import { parseStandingSection, standingLineAgeDays, standingLineFor, standingLineStale } from "@codecast/shared/contracts/briefStanding";
import { personRefOf } from "@codecast/shared/entities";
import { projectTaskCounts } from "@codecast/shared/tasks";
import { useInboxStore, type ProjectItem } from "../../../../store/inboxStore";
import { useBoardTasks, useTasksBackfilled } from "../../../../hooks/useInitiatives";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useProjectLead } from "../../../../hooks/useProjectLead";
import { useRoleBrief } from "../../../../hooks/useScopeQueries";
import { initiativesOfProject } from "../../../../lib/initiatives";
import { charterOf, PRIORITY_META, type CharterFields } from "../../../charter/charterMeta";
import { CharterBlock } from "../../../charter/CharterBlock";
import { ProjectStatusPick } from "../../../initiatives/IntentHeader";
import { WrittenField } from "../../../initiatives/InitiativeRecord";
import { shortDate } from "../../../initiatives/InitiativeAtoms";
import { ProjectTimeline } from "../../../ProjectTimeline";
import { RepositoryLinks } from "../../../repo/RepositoryLinks";
import { InlineEdit } from "../../scope/ScopeEditors";
import { ProjectGlyph, ProjectState } from "../../lines/lineAtoms";
import { projectFacts, projectSays, type LinePerson } from "../../lines/lineFacts";
import { PersonLine } from "../../lines/PersonLine";
import { RoleLine } from "../../lines/RoleLine";
import { lineProjectOf, type LineProject } from "../../lines/lineData";
import { RoleFace } from "../../RoleFace";
import { StandingLine } from "../../stateWords";
import { sessionsUnder } from "../../goalsLayout";
import { rolesInTreeOrder } from "../../staffingModel";
import { countStates, type OrgRole } from "../../orgTypes";
import { findProject, seatFor, type Member } from "../objects";
import { NowBlock } from "../NowBlock";
import { SheetFold, SheetFolds, SheetFrame, SheetSection } from "../SheetFrame";
import type { SheetRef } from "../sheetStack";
import { useCompanyRows, type CompanyRows } from "../useCompanyRows";
import { CarriedLines, NotHere } from "./sheetParts";
import { goalAncestors, goalNamed, peopleOnProject, reportsToNamed, workspaceCrumb, type ProjectPerson } from "./sheetModel";

const DIM = "var(--sol-text-dim)";
const RULE = "color-mix(in srgb, var(--sol-border) 45%, transparent)";
const nameOf = (n: { title: string } | null) => (n ? { name: n.title } : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The charter in a few words, for its fold: "P1 · 2 signs it works · 1 risk". */
function charterHint(c: CharterFields): string {
  return [
    c.priority ? PRIORITY_META[c.priority].label : null,
    c.success_metrics?.length ? plural(c.success_metrics.length, "sign it works", "signs it works") : null,
    c.non_goals?.length ? plural(c.non_goals.length, "non goal", "non goals") : null,
    c.risks?.length ? plural(c.risks.length, "risk", "risks") : null,
  ].filter(Boolean).join(" · ");
}

export function ProjectSheet({ sheet }: { sheet: SheetRef }) {
  const rows = useCompanyRows();
  const now = useCoarseNow(30_000);
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const project = findProject(rows.projects, sheet.ref);
  const roles = useMemo(() => rolesInTreeOrder(rows.tree), [rows.tree]);
  const line = useMemo(() => (project ? lineProjectOf(project, { tree: rows.tree, roles, tasks, tasksCounted: counted }) : null), [project, rows.tree, roles, tasks, counted]);
  const seat = useMemo(() => seatFor(sheet, rows), [sheet, rows]);

  if (!project || !line) {
    return (
      <SheetFrame kind="project" idRef={sheet.ref} glyph={<ProjectGlyph project={{ title: "", color: undefined }} />} title="Project" crumbs={[workspaceCrumb(rows)]} loading={rows.projects.length === 0}>
        <NotHere what="project" />
      </SheetFrame>
    );
  }
  return <ProjectBody key={project._id} project={project} line={line} rows={rows} roles={roles} tasks={tasks} counted={counted} now={now} seat={seat} />;
}

function ProjectBody({ project, line, rows, roles, tasks, counted, now, seat }: {
  project: ProjectItem;
  line: LineProject;
  rows: CompanyRows;
  roles: OrgRole[];
  tasks: ReturnType<typeof useBoardTasks>;
  counted: boolean;
  now: number;
  seat: ReturnType<typeof seatFor>;
}) {
  const router = useRouter();
  const update = (fields: Record<string, unknown>) => useInboxStore.getState().updateProject(project._id, fields);
  const goals = useMemo(() => initiativesOfProject(rows.goals, project._id), [project._id, rows.goals]);
  // Who is on it now: the sessions of the roles whose area holds it, and of
  // the people at work in its folder, once each. Carried by lists the same
  // people, so Now and Carried by never disagree.
  const people = useMemo(() => peopleOnProject(rows.tree, project.project_path), [rows.tree, project.project_path]);
  const sessions = useMemo(() => {
    const all = [...(rows.tree ? sessionsUnder(rows.tree, [project._id]) : []), ...people.flatMap((p) => p.sessions)];
    const seen = new Set<string>();
    return all.filter((x) => !seen.has(x._id) && !!seen.add(x._id));
  }, [project._id, rows.tree, people]);
  const charter = useMemo(() => charterOf(project as unknown as Record<string, unknown>, "project"), [project]);
  const { roles: charterRoles } = useProjectLead(project._id);

  const board = `/projects/${encodeURIComponent(project.short_id || project._id)}`;
  const first = goals[0];
  const facts = projectFacts(line, now, true);

  return (
    <SheetFrame
      kind="project"
      idRef={project.short_id || null}
      glyph={<ProjectGlyph project={line} />}
      title={project.title}
      // A project still a stub (New ▸ Project, the server not answered yet) has nothing to rename on the server: its name was just typed.
      onRename={project.client_key && project._id === project.client_key ? undefined : (title) => update({ title })}
      crumbs={[workspaceCrumb(rows), ...(first ? [...goalAncestors(rows.goals, first), first].map(goalNamed) : [])]}
      facts={{ ...facts, state: <ProjectStatusPick status={project.status} onPick={(status) => update({ status })} face={<ProjectState project={line} />} data-project-pick="status" /> }}
      serves={goals.map(goalNamed)}
      talk={seat}
      ask={seat ? { seat } : null}
      menu={[{ label: "Open the board", onSelect: () => router.push(board) }]}
    >
      <div data-project-sheet={project.short_id || project._id}>
        <div className="mt-5" data-sheet-purpose>
          <WrittenField name="purpose" label="What it is for" value={project.goal ?? ""} fallback={project.description} onSave={(goal) => update({ goal })} rows={4} placeholder="What this project is for, in one paragraph a new hire could act on." />
        </div>
        <WhereItStands project={project} line={line} now={now} />
        <NowBlock subject={{ keys: [`project:${project._id}`, ...(project.short_id ? [`project:${project.short_id}`] : [])], refs: project.short_id ? [project.short_id] : [] }} sessions={sessions} rows={rows} />
        <ProjectCarriedBy project={project} people={people} rows={rows} roles={roles} now={now} />
        <ProjectWorkSection projectId={project._id} tasks={tasks} counted={counted} board={board} />
        <SheetFolds>
          <SheetFold title="Charter" hint={charterHint(charter) || undefined}>
            <CharterBlock kind="project" title={project.title} charter={charter} canEdit onChange={update} roles={charterRoles} hideOwner hideGoal plain />
            <div className="mt-3 flex items-center gap-1.5 text-[11.5px]" style={{ color: DIM }} title="The folder this project's work lives in. It holds no session: a lead takes a session only for the task or plan it is bound to, or when someone files it there." data-project-folder>
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="shrink-0">Folder</span>
              <InlineEdit value={project.project_path ?? ""} placeholder="none" canEdit ariaLabel="Project folder" className="font-mono text-[11px] text-sol-text-dim w-auto min-w-[8rem] max-w-full truncate" onSave={(v) => { const next = v.trim(); if (next !== (project.project_path ?? "")) update({ project_path: next || null }); }} />
            </div>
            <RepositoryLinks projectId={project._id} />
          </SheetFold>
          <SheetFold title="Activity">
            <div className="-mx-2 max-h-[560px] overflow-y-auto"><ProjectTimeline projectId={project._id} composer={false} /></div>
          </SheetFold>
        </SheetFolds>
      </div>
    </SheetFrame>
  );
}

/** Where the project stands in its lead's own words: the line the lead wrote
 *  for it in its brief, with the day it was written, else the lead's pinned
 *  state; then what the project says against itself. Not drawn when neither
 *  speaks. */
function WhereItStands({ project, line, now }: { project: ProjectItem; line: LineProject; now: number }) {
  const lead = line.lead;
  const { data: brief } = useRoleBrief(lead?._id ?? null);
  const written = useMemo(() => (brief?.narrative ? standingLineFor(parseStandingSection(brief.narrative), project) : null), [brief?.narrative, project]);
  const says = projectSays(line, now);
  if (!written && !says) return null;
  const stale = written ? standingLineStale(written, now) : false;
  const days = written ? standingLineAgeDays(written, now) : null;
  return (
    <SheetSection title="Where it stands" data="stands">
      {written ? (
        <div className="flex items-start gap-2" data-project-stands>
          {lead && <RoleFace role={lead} size={16} className="mt-[2px] shrink-0" />}
          <p className="min-w-0 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>
            {written.text}
            {written.written_at !== null && (
              <span className="ml-1.5 whitespace-nowrap text-[11.5px]" style={{ color: stale ? "var(--sol-yellow)" : DIM }} data-project-stands-day={days ?? undefined}>
                {stale && days !== null ? `written ${days} days ago` : shortDate(written.written_at, now)}
              </span>
            )}
          </p>
        </div>
      ) : says?.standing ? (
        <StandingLine standing={says.standing} size="md" />
      ) : null}
      {says?.trouble && <p className="mt-1 text-[12px]" style={{ color: "var(--sol-orange)" }} data-project-trouble>{says.trouble.charAt(0).toUpperCase() + says.trouble.slice(1)}</p>}
    </SheetSection>
  );
}

/** Who carries it: the roles whose area holds it, then the people with
 *  sessions at work in its folder, on the sheet's compact grid. */
function ProjectCarriedBy({ project, people, rows, roles, now }: { project: ProjectItem; people: ProjectPerson[]; rows: CompanyRows; roles: OrgRole[]; now: number }) {
  const carriers = roles.filter((r) => r.scope.project_ids.includes(project._id));
  if (carriers.length === 0 && people.length === 0) return null;
  const member = (id: string) => (rows.members as Member[]).find((m) => String(m._id) === id);
  return (
    <SheetSection title="Carried by">
      <CarriedLines>
        {carriers.map((r) => <RoleLine key={r._id} line={{ role: r, reportsTo: nameOf(reportsToNamed(rows.tree, rows.members, r)), leads: [], goals: [], charter: r.charter }} now={now} />)}
        {people.map(({ person, sessions }) => {
          const p: LinePerson = {
            id: person.user_id, name: person.name, image: person.image, me: person.is_me,
            ref: personRefOf({ _id: person.user_id, github_username: member(person.user_id)?.github_username }),
            access: person.role, presence: person.presence, sessions: countStates([...sessions]), roles: [], goals: [],
          };
          return <PersonLine key={person.user_id} person={p} now={now} />;
        })}
      </CarriedLines>
    </SheetSection>
  );
}

/** The board's work in words, counted by the board's own rule, and the way there. */
function ProjectWorkSection({ projectId, tasks, counted, board }: { projectId: string; tasks: ReturnType<typeof useBoardTasks>; counted: boolean; board: string }) {
  const n = useMemo(() => projectTaskCounts(tasks, [projectId]), [tasks, projectId]);
  const open = (
    <Link href={board} className="inline-flex h-[22px] items-center gap-1 rounded-md border px-2 text-[11.5px] no-underline hover:bg-sol-bg-highlight/60" style={{ borderColor: RULE, color: "var(--sol-text-secondary)" }} data-sheet-open-board>
      Open the board <ArrowUpRight className="h-3 w-3" />
    </Link>
  );
  return (
    <SheetSection title="Work" action={open}>
      {!counted && n.total === 0 ? (
        <p className="text-[12px]" style={{ color: DIM }} data-sheet-work="counting">Counting the tasks…</p>
      ) : n.total === 0 ? null : (
        <>
          <div className="h-[5px] overflow-hidden rounded-[3px]" style={{ background: "var(--sol-bg-highlight)" }}>
            <div className="h-full" style={{ width: `${Math.round((n.done / n.total) * 100)}%`, background: "var(--sol-green)" }} />
          </div>
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--sol-text-muted)" }} data-sheet-work={`${n.done}/${n.total}`}>
            {n.done} of {n.total} tasks done{n.in_progress ? ` · ${n.in_progress} in progress` : ""}{!counted ? " so far" : ""}
          </p>
        </>
      )}
    </SheetSection>
  );
}
