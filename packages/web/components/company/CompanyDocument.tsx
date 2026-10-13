"use client";
// The Org screen's Read lens: the company read top to bottom like a document
// (docs/architecture/initiatives-projects-role-page.md I5, cohesive build
// spec §4.3). Its name and one line of how it stands; its goals, each one
// line that opens in place to why it matters, what its owner last said, and
// the projects and goals that carry it; the projects no goal carries; then
// the people, each with the roles they host or that report to them.
//
// Every row is one of the four lines (components/org/lines) on the one grid,
// so the Goals, Projects and People filters line up column for column. A
// line's title opens its sheet; its background or chevron opens it in place,
// and what is open is the person's own (`clientState.ui.org_expanded`), kept
// across reloads and windows. The company is drawn as it is; an open
// proposal stands beside it in violet (a goal it would set, a project or a
// goal it would bring under a goal, a live goal it would move) and says
// where it is answered: the conversation, never here (S41, D8). The counts
// are the live ones, with what a proposal would add said apart.
//
// Paints from the store: the joining is companyModel (pure), over the same
// goal outline the map's Goals lens draws, assembled by useCompanyDoc, which
// a goal's sheet reads too.
import { Fragment, useMemo, type ReactNode } from "react";
import { CornerDownRight } from "lucide-react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiativeUpdates, useSyncInitiativeUpdates } from "../../hooks/useInitiatives";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { cn } from "../../lib/utils";
import { useCompanyDoc } from "./useCompanyDoc";
import { UpdateLine } from "../initiatives/InitiativeAtoms";
import { Face } from "../org/ProposalSubjectCard";
import { RoleFace } from "../org/RoleFace";
import { GhostTag } from "../org/ghostChrome";
import { GoalGlyph, GoalLine } from "../org/lines/GoalLine";
import { LineBody, ObjectLine, type LineGhost } from "../org/lines/ObjectLine";
import { LINE_SCOPE } from "../org/lines/lineData";
import { PersonLine } from "../org/lines/PersonLine";
import { ProjectGlyph, ProjectLine } from "../org/lines/ProjectLine";
import { projectSays } from "../org/lines/lineFacts";
import { RoleLine } from "../org/lines/RoleLine";
import { useLineOpen } from "../org/lines/lineOpen";
import { defaultOpenGoal, flatGoals, goalProjects, stateClauses, type CompanyDoc, type DocArrival, type DocChange, type DocGoal, type DocPeopleRow, type DocProject, type ProposalRef } from "./companyModel";

const HAIRLINE = "var(--cc-panel-rule, color-mix(in srgb, var(--sol-border) 45%, transparent))";
const SERIF = { fontFamily: "var(--font-serif)" } as const;
const DIM = "var(--sol-text-dim)";
const VIOLET = "var(--sol-violet)";

/** Which part of the company the document shows: the filter row the Read and Map lenses share. */
export type CompanyFilter = "everything" | "goals" | "projects" | "people";

/** Feeds one open proposal's changes into the store. */
function ProposalFeed({ shortId }: { shortId: string }) {
  useSyncOrgProposal(shortId);
  return null;
}

export function CompanyDocument({ filter = "everything", selected }: { filter?: CompanyFilter; selected?: string | null }) {
  // The roles feeder (org.roles: roles, seats and people, no session read);
  // on the Org screen the map's full tree feeds the same home, and the lines
  // pick up the live state words from it.
  useSyncOrgTreeFeeder();
  useSyncProjects();
  useSyncOrgProposals();
  const { doc, open } = useCompanyDoc();
  const now = useCoarseNow(60_000);

  return (
    <>
      {open.map((p) => <ProposalFeed key={p._id} shortId={p.short_id} />)}
      <CompanyDocumentView doc={doc} now={now} filter={filter} selected={selected} />
    </>
  );
}

// ---------------------------------------------------------------- what is open

/** How many open lines the synced list keeps, newest last. */
const EXPANDED_MAX = 200;

type Expansion = { isOpen: (id: string) => boolean; toggle: (id: string) => void };

/** The lines opened in place, the person's own and synced. Before they have
 *  opened or folded anything, the document opens on its most pressing goal. */
function useExpansion(doc: CompanyDoc): Expansion {
  const saved = useInboxStore((s) => s.clientState.ui?.org_expanded);
  const fallback = useMemo(() => defaultOpenGoal(doc.goals), [doc.goals]);
  const open = useMemo(() => new Set(saved ?? (fallback ? [fallback] : [])), [saved, fallback]);
  return useMemo(() => ({
    isOpen: (id: string) => open.has(id),
    toggle: (id: string) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id); else next.add(id);
      // One list for every workspace and device, so an id this window does not
      // know (another workspace's line, a row not synced here yet) stays as
      // written and simply opens nothing. Only the oldest fall off the end.
      useInboxStore.getState().updateClientUI({ org_expanded: [...next].slice(-EXPANDED_MAX) });
    },
  }), [open]);
}

// ---------------------------------------------------------------- the document

export function CompanyDocumentView({ doc, now, filter = "everything", selected }: { doc: CompanyDoc; now: number; filter?: CompanyFilter; selected?: string | null }) {
  const x = useExpansion(doc);
  const goalRows = useMemo(() => new Map(flatGoals(doc.goals).flatMap((g) => (g.row ? [[g.id, g.row] as const] : []))), [doc.goals]);
  const ctx: Ctx = { x, now, selected: selected ?? null, goalRows };
  const people = doc.people.length + doc.roles.length > 0;
  const showGoals = filter === "everything" || filter === "goals";
  const showPeople = (filter === "everything" || filter === "people") && people;
  const { state } = doc;
  // On the Goals page a single goal every other one serves is the mission: it
  // reads as one line under the title, and the goals it carries are the list.
  const mission = filter === "goals" && doc.goals.length === 1 && doc.goals[0].goals.length > 0 ? doc.goals[0] : null;
  const listed = mission ? mission.goals : doc.goals;
  const title = filter === "goals" ? "Goals" : filter === "projects" ? "Projects" : doc.name;
  const told = filter === "goals" ? { ...state, projects: { ...state.projects, total: 0 }, people: 0, roles: 0 }
    : filter === "projects" ? { ...state, goals: { ...state.goals, total: 0 }, people: 0, roles: 0 }
    : state;
  let delay = 0;
  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-company-document data-company-filter={filter}>
      <style>{`
        @keyframes company-rise { from { opacity: 0; transform: translateY(4px); } }
        .company-part { animation: company-rise .3s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .company-part { animation: none; } }
      `}</style>
      {/* The article is the lines' container: their breakpoints measure the room inside its padding, not the pane. */}
      <article className={cn("mx-auto w-full max-w-[920px] px-5 pt-7 pb-20 text-[13px] leading-[1.5]", LINE_SCOPE)} data-company-article>
        <header className="company-part px-1.5" data-company-section="company">
          <h1 className="text-[26px] font-medium leading-[1.2] tracking-[-0.01em]" style={SERIF} data-company-name>{title}</h1>
          {mission && <p className="mt-1 text-[13.5px]" style={{ color: "var(--sol-text-muted)" }} data-company-mission>All serve <a href={mission.short_id ? `/goals/${mission.short_id}` : undefined} className="hover:underline" style={{ color: "var(--sol-text)" }}>{mission.title}</a></p>}
          <StateLine clauses={stateClauses(told)} />
        </header>

        {showGoals && listed.length > 0 && (() => {
          const rows = <Rows items={listed.map((g) => ({ key: g.id, proposal: g.row ? undefined : g.proposed?.proposal, draw: (quiet) => <GoalRows goal={g} depth={0} ctx={ctx} quiet={quiet} /> }))} />;
          // The Goals page is titled Goals already: its list needs no second heading.
          return filter === "goals"
            ? <div className="company-part mt-6" data-company-section="goals">{rows}</div>
            : <Section id="goals" title="Goals" count={<Count live={state.goals.total} proposed={state.proposed.goals} />} delay={++delay}>{rows}</Section>;
        })()}

        {filter === "everything" && doc.unfiled.length > 0 && (
          <Section id="unfiled" title="Projects not under a goal" count={<Count live={doc.unfiled.length} />} delay={++delay}>
            {doc.unfiled.map((p) => <ProjectRow key={p.id} project={p} openKey={p.id} depth={0} ctx={ctx} />)}
          </Section>
        )}

        {filter === "projects" && state.projects.total > 0 && <ProjectsByGoal doc={doc} ctx={ctx} delay={++delay} />}

        {showPeople && (
          <Section id="people" title="People and roles" count={[doc.people.length ? plural(doc.people.length, "person", "people") : null, doc.roles.length ? plural(doc.roles.length, "role", "roles") : null].filter(Boolean).join(" · ")} delay={++delay}>
            <Rows items={doc.outline.map((row) => ({ key: `${row.kind}:${row.id}`, proposal: row.kind === "ghost" ? row.change.proposal : undefined, draw: (quiet) => <PeopleRow row={row} ctx={ctx} quiet={quiet} /> }))} />
          </Section>
        )}

        {/* A filter with nothing to show says so in two words; New in the header makes the first one. */}
        {filter === "goals" && doc.goals.length === 0 && doc.unfiled.length === 0 && <Quiet>No goals.</Quiet>}
        {filter === "projects" && state.projects.total === 0 && <Quiet>No projects.</Quiet>}
        {filter === "people" && !people && <Quiet>Nobody here.</Quiet>}
      </article>
    </div>
  );
}

/** How the company stands. Each comma part is kept whole, so a wide pane
 *  breaks between clauses and a narrow one at a comma, never inside a word. */
function StateLine({ clauses }: { clauses: readonly (readonly string[])[] }) {
  if (!clauses.length) return null;
  return (
    <p className="mt-2 tabular-nums" style={{ color: "var(--sol-text-muted)" }} data-company-state>
      {clauses.map((c, i) => (
        <Fragment key={c.join(" ")}>
          {c.map((part, j) => (
            <Fragment key={j}>
              <span className="whitespace-nowrap">{part}{i < clauses.length - 1 && j === c.length - 1 ? " ·" : ""}</span>
              {j < c.length - 1 || i < clauses.length - 1 ? " " : null}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </p>
  );
}

/** A section's count: the live ones, and what open proposals would add, in violet beside them. */
function Count({ live, proposed = 0 }: { live: number; proposed?: number }) {
  return (
    <>
      {live}
      {proposed > 0 && <span style={{ color: VIOLET }} data-company-count-proposed={proposed}> · {proposed} proposed</span>}
    </>
  );
}

type RowItem = { key: string; proposal?: ProposalRef; draw: (quiet: boolean) => ReactNode };

/** Sibling rows in order. A proposal's line says where it is answered once:
 *  the lines that follow it from the same proposal leave that cell empty. */
function Rows({ items, after = null }: { items: readonly RowItem[]; /** The proposal of the line just above these rows. */ after?: string | null }) {
  let last: string | null = after;
  return (
    <>
      {items.map((it) => {
        const id = it.proposal?.short_id ?? null;
        const quiet = !!id && id === last;
        last = id;
        return <Fragment key={it.key}>{it.draw(quiet)}</Fragment>;
      })}
    </>
  );
}

type Ctx = { x: Expansion; now: number; selected: string | null; goalRows: ReadonlyMap<string, InitiativeRow> };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isSelected = (ctx: Ctx, ...refs: (string | undefined)[]) => !!ctx.selected && refs.includes(ctx.selected);

function Section({ id, title, count, delay, children }: { id: string; title: string; count: ReactNode; delay: number; children: ReactNode }) {
  return (
    <section className="company-part mt-8" style={{ animationDelay: `${delay * 40}ms` }} data-company-section={id}>
      <h2 className="mb-1 flex items-baseline gap-2 border-b px-1.5 pb-1.5 text-[16px] font-medium leading-[1.3]" style={{ ...SERIF, borderColor: HAIRLINE }}>
        {title}
        {count && <span className="text-[12px] font-normal tabular-nums" style={{ fontFamily: "var(--font-ui)", color: DIM }} data-company-count>{count}</span>}
      </h2>
      <div role="tree" aria-label={title}>{children}</div>
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="mt-8 px-1.5" style={{ color: DIM }} data-company-empty>{children}</p>;

const ghostOf = (change: DocChange | undefined, quiet = false): LineGhost | undefined => (change ? { ...(change.proposal ? { proposal: change.proposal } : {}), changeIds: [change.row.change_id], ...(quiet ? { quiet } : {}) } : undefined);

// ---------------------------------------------------------------- goals

/** A goal's line, and, opened, why it matters, what its owner last said, and
 *  what carries it: its projects, then what a proposal would bring here (a
 *  project, a goal that would move under it, a change to its numbers or its
 *  owner), then the goals that feed it, each a line of its own one level in. */
function GoalRows({ goal, depth, ctx, quiet = false }: { goal: DocGoal; depth: number; ctx: Ctx; quiet?: boolean }) {
  const row = goal.row;
  const live = goal.projects.filter((p) => !p.ghost);
  const brought = goal.projects.filter((p) => p.ghost);
  const opens = !!(goal.purpose || goal.record || row?.latest_update_id || goal.projects.length || goal.goals.length || goal.changes.length || goal.arriving.length);
  const open = opens && ctx.x.isOpen(goal.id);
  const toggle = opens ? () => ctx.x.toggle(goal.id) : undefined;
  const waiting = [...goal.changes.map((c) => c.row.status), ...brought.map((p) => p.ghost!.status), ...goal.arriving.map((a) => a.change.row.status)].filter((st) => st === "proposed" || st === "failed").length;
  // A live goal says on its own line what a proposal would do to it: that it
  // would move (an arrow; where to is in its title and on the line it moves
  // to, as "moves here"), else how many changes wait on it.
  const sub = !row ? undefined
    : goal.move ? <span className="inline-flex items-center" style={{ color: VIOLET }} title={`${goal.move.proposal?.short_id ?? "A proposal"} would move it under ${goal.move.under ?? "the top"}`} aria-label={`moves under ${goal.move.under ?? "the top"}`} data-company-goal-move={goal.move.row.change_id}><CornerDownRight className="h-3 w-3" aria-hidden /></span>
    : waiting > 0 && !open ? <span style={{ color: VIOLET }} data-company-goal-proposed={waiting}>{plural(waiting, "change proposed", "changes proposed")}</span>
    : undefined;
  const items: RowItem[] = open ? [
    ...live.map((p) => ({ key: `p:${p.id}`, draw: () => <ProjectRow project={p} openKey={placedKey(goal.id, p.id)} depth={depth + 1} ctx={ctx} /> })),
    ...brought.map((p) => ({ key: `bp:${p.id}`, proposal: p.ghost!.proposal, draw: (q: boolean) => <BroughtProject project={p} depth={depth + 1} ctx={ctx} quiet={q} /> })),
    ...goal.arriving.map((a) => ({ key: `ag:${a.goal.id}`, proposal: a.change.proposal, draw: (q: boolean) => <ArrivingGoal arrival={a} depth={depth + 1} quiet={q} /> })),
    ...goal.changes.map((c) => ({ key: `c:${c.row.change_id}`, proposal: c.proposal, draw: (q: boolean) => <ChangeLine change={c} depth={depth + 1} quiet={q} /> })),
    ...goal.goals.map((g) => ({ key: `g:${g.id}`, proposal: g.row ? undefined : g.proposed?.proposal, draw: (q: boolean) => <GoalRows goal={g} depth={depth + 1} ctx={ctx} quiet={q} /> })),
  ] : [];
  return (
    <div data-company-goal={goal.short_id ?? goal.id} data-company-depth={depth + 1} data-company-goal-kind={row ? "live" : goal.proposed ? "proposed" : "unknown"} data-company-open={open || undefined}>
      {row
        ? <GoalLine goal={row} now={ctx.now} depth={depth} expanded={open} onToggle={toggle} sub={sub} selected={isSelected(ctx, goal.id, row.short_id)} />
        : <ProposedGoalLine goal={goal} depth={depth} expanded={open} onToggle={toggle} quiet={quiet} />}
      {open && (
        <>
          <GoalBody goal={goal} depth={depth} ctx={ctx} />
          <Rows items={items} after={row ? null : goal.proposed?.proposal?.short_id ?? null} />
        </>
      )}
    </div>
  );
}

/** What a goal says opened in place: why it matters, then its owner's latest word. */
function GoalBody({ goal, depth, ctx }: { goal: DocGoal; depth: number; ctx: Ctx }) {
  const record = goal.record;
  const measures = goal.row ? [] : goal.measures;
  const hasWords = goal.purpose || record?.done_when || record?.milestones.length || measures.length || goal.row?.latest_update_id;
  if (!hasWords) return null;
  return (
    <LineBody depth={depth} data-company-goal-body={goal.short_id ?? goal.id}>
      {goal.purpose && <p style={{ lineHeight: 1.55 }} data-company-why>{goal.purpose}</p>}
      {record?.done_when && <p className="mt-1.5 text-[12px]" data-company-done-when><span style={{ color: DIM }}>Done when</span> {record.done_when}</p>}
      {record?.milestones.length ? <p className="mt-1 text-[12px]" data-company-milestones={record.milestones.length}><span style={{ color: DIM }}>{record.milestones.length === 1 ? "Milestone" : "Milestones"}</span> {record.milestones.join("; ")}</p> : null}
      {measures.length > 0 && <p className="mt-1 text-[12px]" data-company-measures><span style={{ color: DIM }}>Measured by</span> {measures.join("; ")}</p>}
      {goal.row?.latest_update_id && <LatestUpdate goal={goal.row} now={ctx.now} />}
    </LineBody>
  );
}

/** The owner's latest update: fed for this goal while it is open. */
function LatestUpdate({ goal, now }: { goal: InitiativeRow; now: number }) {
  useSyncInitiativeUpdates(goal._id);
  const updates = useInitiativeUpdates(goal._id);
  const latest = updates.find((u) => u._id === goal.latest_update_id) ?? updates[0];
  if (!latest) return null;
  return <div className="mt-2 flex min-w-0" data-company-update={latest._id}><UpdateLine update={latest} now={now} className="!text-[12px]" /></div>;
}

/** A goal a proposal sets, where it would sit, in violet; or a name a change
 *  gives that nothing answers to, said as a warning. */
function ProposedGoalLine({ goal, depth, expanded, onToggle, quiet = false }: { goal: DocGoal; depth: number; expanded: boolean; onToggle?: () => void; quiet?: boolean }) {
  const change = goal.proposed;
  const owner = goal.owner && goal.owner.kind !== "unknown"
    ? <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-secondary)" }}><Face face={goal.owner} size={16} dim /><span className="truncate">{goal.owner.name}</span></span>
    : null;
  return (
    <ObjectLine
      kind="goal"
      id={goal.id}
      glyph={<GoalGlyph ghost={!!change} />}
      title={goal.title}
      sub={change ? change.row.tag || "proposed" : <GhostTag label="unknown" status="failed" quiet />}
      owner={owner}
      ghost={ghostOf(change, quiet)}
      depth={depth}
      expanded={expanded}
      onToggle={onToggle}
      data-company-goal-ghost={change?.row.change_id}
    />
  );
}

/** A change proposed on a goal (its numbers, its owner, its record), as a violet line under it. */
function ChangeLine({ change, depth, quiet }: { change: DocChange; depth: number; quiet: boolean }) {
  const words = change.sentence ?? change.row.detail ?? change.row.chip ?? change.row.line;
  return <ObjectLine kind="goal" id={change.row.change_id} glyph={<GoalGlyph ghost />} title={words} sub={change.row.tag || undefined} ghost={ghostOf(change, quiet)} depth={depth} data-company-change={change.row.change_id} />;
}

/** A live goal a proposal would move under this one: its own line stays where it is today; here it is named, and opens. */
function ArrivingGoal({ arrival, depth, quiet }: { arrival: DocArrival; depth: number; quiet: boolean }) {
  const ref = arrival.goal.short_id ?? arrival.goal.id;
  return <ObjectLine kind="goal" id={`arriving:${arrival.goal.id}`} target={{ kind: "initiative", ref }} glyph={<GoalGlyph ghost />} title={arrival.goal.title} sub="moves here" ghost={ghostOf(arrival.change, quiet)} depth={depth} data-company-arriving={ref} />;
}

// ---------------------------------------------------------------- projects

/** A project line's expansion key: where it is drawn, since one project can sit under two goals. */
const placedKey = (goalId: string, projectId: string) => `${goalId}/${projectId}`;

/** A project's line. `openKey` is where it is drawn (placedKey under a goal, its bare id when no goal carries it). */
function ProjectRow({ project, openKey, depth, ctx, sub }: { project: DocProject; openKey: string; depth: number; ctx: Ctx; sub?: ReactNode }) {
  const opens = !!projectSays(project, ctx.now);
  return (
    <ProjectLine
      project={project}
      now={ctx.now}
      depth={depth}
      sub={sub}
      expanded={opens && ctx.x.isOpen(openKey)}
      onToggle={opens ? () => ctx.x.toggle(openKey) : undefined}
      selected={isSelected(ctx, project.id, project.short_id)}
    />
  );
}

/** A project a proposal would bring under this goal, beside its own line
 *  wherever it is today. One that exists opens; a new one is named only. */
function BroughtProject({ project, depth, ctx, quiet }: { project: DocProject; depth: number; ctx: Ctx; quiet: boolean }) {
  const ghost = project.ghost!;
  const exists = !project.unborn;
  const word = ghost.unresolved ? "not found" : exists ? (ghost.kind === "initiative_projects" ? "added here" : "moves here") : ghost.tag ?? "new";
  return (
    <ProjectLine
      project={project}
      now={ctx.now}
      depth={depth}
      editable={false}
      opens={exists}
      ghost={{ ...(ghost.proposal ? { proposal: ghost.proposal } : {}), changeIds: [ghost.change_id], ...(quiet ? { quiet } : {}) }}
      sub={<GhostTag label={word} status={ghost.unresolved ? "failed" : ghost.status} quiet />}
      selected={exists && isSelected(ctx, project.id, project.short_id)}
    />
  );
}

/** The Projects filter: every live project line, under the heading of the
 *  goal it is listed under, then the ones no goal carries. A project under a
 *  second goal says where it first appeared, so the lines add up to the count. */
function ProjectsByGoal({ doc, ctx, delay }: { doc: CompanyDoc; ctx: Ctx; delay: number }) {
  const { onLinkClick } = useLineOpen();
  const groups = goalProjects(doc.goals).filter((g) => g.goal.row);
  const firstUnder = new Map<string, string>();
  for (const { goal, projects } of groups) for (const p of projects) if (!firstUnder.has(p.id)) firstUnder.set(p.id, goal.id);
  const titleOf = new Map(groups.map(({ goal }) => [goal.id, goal.title]));
  const alsoUnder = (goalId: string, projectId: string) => {
    const first = firstUnder.get(projectId);
    return first && first !== goalId ? <span title={`Also listed under ${titleOf.get(first)}`} data-company-also-under={first}>also under {titleOf.get(first)}</span> : undefined;
  };
  return (
    // Only the Projects page draws this, and it is titled Projects already.
    <div className="company-part mt-4" style={{ animationDelay: `${delay * 40}ms` }} data-company-section="projects">
      {groups.map(({ goal, projects }) => (
        <div key={goal.id} className="mt-3 first:mt-1" data-company-project-group={goal.short_id ?? goal.id}>
          {/* The heading's flag sits in the glyph column of the lines under it. */}
          <h3 className="flex items-center gap-2 pb-1 pl-[28px] pr-1.5 text-[11.5px] font-medium" style={{ color: "var(--sol-text-muted)" }}>
            <span className="inline-flex w-5 shrink-0 justify-center"><GoalGlyph /></span>
            <a href={objectHref("initiative", goal.row!.short_id || goal.row!._id)} onClick={onLinkClick({ kind: "initiative", ref: goal.row!.short_id || goal.row!._id })} className="truncate no-underline hover:underline underline-offset-[3px]" style={{ color: "inherit" }}>{goal.title}</a>
          </h3>
          {projects.map((p) => <ProjectRow key={p.id} project={p} openKey={placedKey(goal.id, p.id)} sub={alsoUnder(goal.id, p.id)} depth={0} ctx={ctx} />)}
        </div>
      ))}
      {doc.unfiled.length > 0 && (
        <div className="mt-3" data-company-project-group="unfiled">
          <h3 className="pb-1 pl-[56px] pr-1.5 text-[11.5px] font-medium" style={{ color: DIM }}>Not under a goal</h3>
          {doc.unfiled.map((p) => <ProjectRow key={p.id} project={p} openKey={p.id} depth={0} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- people and roles

function PeopleRow({ row, ctx, quiet }: { row: DocPeopleRow; ctx: Ctx; quiet: boolean }) {
  if (row.kind === "person") {
    const p = row.person;
    const goals = p.goals.flatMap((g) => { const r = ctx.goalRows.get(g.id); return r ? [r] : []; });
    const opens = goals.length > 0;
    const open = opens && ctx.x.isOpen(p.id);
    return (
      <div data-company-person={p.id}>
        <PersonLine person={p} now={ctx.now} rolesShown expanded={open} onToggle={opens ? () => ctx.x.toggle(p.id) : undefined} selected={isSelected(ctx, p.id, p.ref)} />
        {open && goals.map((g) => <GoalLine key={g._id} goal={g} now={ctx.now} depth={1} />)}
      </div>
    );
  }
  if (row.kind === "role") {
    return <div data-company-role={row.role.role.short_id}><RoleLine line={row.role} now={ctx.now} depth={row.depth} underReportsTo={row.underReportsTo} selected={isSelected(ctx, row.role.role._id, row.role.role.short_id)} /></div>;
  }
  return <HireLine change={row.change} depth={row.depth} quiet={quiet} />;
}

/** A role a proposal would hire, where it would sit; or a change it proposes
 *  on a role, as a line under that role's own, which already names it: the
 *  change says only what it does ("would lead Callers & Call Management"). */
function HireLine({ change, depth, quiet }: { change: DocChange; depth: number; quiet: boolean }) {
  const r = change.row;
  const node = r.node;
  if (r.kind !== "role") {
    const glyph = r.kind === "scope" ? <ProjectGlyph project={{ title: "" }} ghost /> : <span className="h-[6px] w-[6px] rounded-full" style={{ background: VIOLET }} />;
    return (
      <div data-company-ghost-role={r.change_id}>
        <ObjectLine kind="role" id={r.change_id} glyph={glyph} title={change.sentence ?? r.chip ?? r.line} ghost={ghostOf(change, quiet)} depth={depth} />
      </div>
    );
  }
  const glyph = node.kind === "role" ? <RoleFace role={{ handle: node.handle, name: node.name, avatar: node.avatar }} size={18} /> : <Face face={node} size={18} dim />;
  // A hire sits right under whom it would report to whenever they are here
  // (peopleOutline), so only one drawn at the top names them.
  const owner = r.parent && depth === 0 ? <span className="truncate" style={{ color: "var(--sol-text-muted)" }}>↳ {r.parent.name}</span> : null;
  return (
    <div data-company-ghost-role={r.change_id}>
      <ObjectLine kind="role" id={r.change_id} glyph={glyph} title={node.name} sub={r.tag || "new role"} owner={owner} ghost={ghostOf(change, quiet)} depth={depth} />
    </div>
  );
}
