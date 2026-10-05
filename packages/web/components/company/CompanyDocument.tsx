"use client";
// /company: the whole company read top to bottom like a document
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows").
// The company and why it exists, each goal with who drives it and how it is
// going, the projects that carry it, the projects no goal carries, then the
// roles and the people. Every name is a link to the thing it names.
//
// Paints from the store: the joining is companyModel (pure), over the same
// goal outline the chart's Goals lens draws. An open proposal's changes are
// drawn in place, in ghost chrome, each with its own Accept and Skip, which
// run the store action the org page runs.
import { useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, milestoneCounts, nextMilestone } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useIsPhone, useMinWidth } from "../../hooks/useIsPhone";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { initiativeHref } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { ProjectLeadChip } from "../charter/ProjectLeadChip";
import { HealthChip, MetricTile, NextMilestoneChip, OwnerChip, StatusGlyph, TargetDate, shortDate } from "../initiatives/InitiativeAtoms";
import { OrgButton } from "../org/OrgButton";
import { Face, NodeLine } from "../org/ProposalCard";
import { RoleFace } from "../org/RoleFace";
import { GhostTag, StatusPill } from "../org/ghostChrome";
import { CHIP_STATUS, GHOST } from "../org/orgMeta";
import { joinProposals, type OrgProposalChange, type OrgProposalRow } from "../org/orgStaffingTypes";
import { proposalSeen } from "../org/proposalHooks";
import { openProposals, proposalWorkspace, sameWorkspace } from "../org/staffingModel";
import { companyDoc, tallyLine, type CompanyDoc, type CompanyProject, type DocChange, type DocGoal, type DocPerson, type DocProject, type DocRef, type DocRole } from "./companyModel";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const SERIF = { fontFamily: "var(--font-serif)" } as const;
const LINK = "no-underline hover:underline decoration-1 underline-offset-[3px]";
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.updated_at}|${p.task_counts?.total ?? 0}/${p.task_counts?.done ?? 0}`;

type Decide = (change: DocChange, verdict: "accept" | "skip") => void;
type ProposalLink = Pick<OrgProposalRow, "_id" | "short_id" | "title">;

/** Feeds one open proposal's changes into the store. */
function ProposalFeed({ shortId }: { shortId: string }) {
  useSyncOrgProposal(shortId);
  return null;
}

export function CompanyDocument() {
  // The feeders the goal page mounts, plus the workspace's proposals.
  const { tree } = useSyncOrgTree();
  useSyncProjects();
  useSyncOrgProposals();
  const initiatives = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const roster = useTeamRosterIdentity();
  const teamName = useInboxStore((s) => { const id = s.clientState.ui?.active_team_id; return id ? ((s.teams ?? []) as { _id?: string; name?: string }[]).find((t) => t?._id === id)?.name ?? null : null; });
  const proposalRows = useInboxStore((s) => s.orgProposals);
  const proposalChanges = useInboxStore((s) => s.orgProposalChanges);
  const now = useCoarseNow(60_000);
  const phone = useIsPhone();
  const wide = useMinWidth(1100);

  const workspace = tree?.workspace;
  const open = useMemo<OrgProposalRow[]>(
    () => (workspace ? openProposals(joinProposals(proposalRows, proposalChanges)).filter((p) => sameWorkspace(proposalWorkspace(p), workspace)) : []),
    [proposalRows, proposalChanges, workspace?.kind, workspace?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const changes = useMemo<OrgProposalChange[]>(() => open.flatMap((p) => p.changes), [open]);
  const doc = useMemo(() => companyDoc({ tree, workspaceName: teamName, initiatives, projects: projects as CompanyProject[], roster, changes }), [tree, teamName, initiatives, projects, roster, changes]);
  const decide = useCallback<Decide>((change, verdict) => {
    useInboxStore.getState().decideOrgProposalChange(change.row.change_id, verdict, undefined, proposalSeen(changes.filter((c) => c.proposal_id === change.proposal_id)));
  }, [changes]);

  return (
    <>
      {open.map((p) => <ProposalFeed key={p._id} shortId={p.short_id} />)}
      <CompanyDocumentView doc={doc} now={now} phone={phone} wide={wide} proposals={doc.waiting > 0 ? open : NO_PROPOSALS} onDecide={decide} />
    </>
  );
}
const NO_PROPOSALS: ProposalLink[] = [];

const scrollTo = (id: string) => (e: React.MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
};

export function CompanyDocumentView({ doc, now, phone, wide, proposals, onDecide }: { doc: CompanyDoc; now: number; phone: boolean; wide: boolean; proposals: readonly ProposalLink[]; onDecide: Decide }) {
  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-company-document data-company-layout={phone ? "phone" : wide ? "wide" : "page"}>
      <style>{`
        @keyframes company-rise { from { opacity: 0; transform: translateY(4px); } }
        .company-part { animation: company-rise .24s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .company-part { animation: none; } }
      `}</style>
      <div className={cn("mx-auto flex w-full max-w-[1040px] items-start justify-center gap-12", phone ? "px-4 pt-5 pb-16" : "px-8 pt-10 pb-24")}>
        <article className="min-w-0 w-full max-w-[760px] text-[13px] leading-[1.65]">
          <header className="company-part scroll-mt-6" id="company" data-company-section="company">
            <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.015em]" style={SERIF} data-company-name>{doc.name}</h1>
            {doc.purpose.length > 0 ? (
              <div className="mt-3 max-w-[64ch] space-y-2" data-company-purpose>
                {doc.purpose.map((why, i) => <p key={i}>{why}</p>)}
              </div>
            ) : (
              <p className="mt-3 italic" style={{ color: "var(--sol-text-dim)" }} data-company-purpose="none">No purpose written yet</p>
            )}
            <p className="mt-3 text-[12px] tabular-nums" style={{ color: "var(--sol-text-muted)" }} data-company-tally>{tallyLine(doc.tally)}</p>
            {proposals.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]" style={{ color: GHOST.color }} data-company-proposals={doc.waiting}>
                <span>{doc.waiting} proposed {doc.waiting === 1 ? "change is" : "changes are"} drawn in place, from</span>
                {proposals.map((p, i) => (
                  <span key={p._id} className="inline-flex gap-x-1.5">
                    {i > 0 && <span>and</span>}
                    <Link href={`/org?proposal=${p.short_id}`} className={cn(LINK, "font-medium")} style={{ color: GHOST.color }} title={p.title}>{p.short_id}</Link>
                  </span>
                ))}
              </p>
            )}
          </header>

          <Section id="goals" title="Goals" count={doc.tally.goals} delay={1}>
            {doc.goals.length === 0 ? (
              <Quiet>No goals yet. Set the first one on the <Link href="/initiatives" className={LINK} style={{ color: "var(--sol-text-secondary)" }}>initiatives page</Link>.</Quiet>
            ) : doc.goals.map((g) => <Goal key={g.id} goal={g} now={now} phone={phone} onDecide={onDecide} />)}
          </Section>

          <Section id="projects" title="Projects not under a goal" count={doc.unfiled.length} delay={2}>
            {doc.unfiled.length === 0
              ? <Quiet>{doc.tally.projects === 0 ? "No projects yet." : "Every project is under a goal."}</Quiet>
              : <ProjectList projects={doc.unfiled} now={now} phone={phone} />}
          </Section>

          <Section id="people" title="People and roles" count={doc.tally.people + doc.tally.roles} delay={3}>
            {doc.staffing.map((c) => <StaffingChange key={c.row.change_id} change={c} onDecide={onDecide} className="mt-3" />)}
            {doc.roles.map((r) => <Role key={r.role._id} entry={r} onDecide={onDecide} />)}
            {doc.people.map((p) => <Person key={p.id} person={p} />)}
            {doc.roles.length + doc.people.length + doc.staffing.length === 0 && <Quiet>Nobody here yet.</Quiet>}
          </Section>
        </article>

        {wide && !phone && (
          <nav aria-label="Contents" className="company-part sticky top-10 w-[208px] shrink-0 border-l pl-4 text-[12px] leading-[1.5]" style={{ borderColor: HAIRLINE, color: "var(--sol-text-muted)" }} data-company-toc>
            <a href="#company" onClick={scrollTo("company")} className={cn(LINK, "block truncate font-medium")} style={{ color: "var(--sol-text)" }}>{doc.name}</a>
            <a href="#goals" onClick={scrollTo("goals")} className={cn(LINK, "mt-2.5 block")} style={{ color: "inherit" }}>Goals</a>
            {doc.goals.map((g) => (
              <a key={g.id} href={`#goal-${g.id}`} onClick={scrollTo(`goal-${g.id}`)} className={cn(LINK, "mt-1 block truncate pl-3")} style={{ color: g.row ? "var(--sol-text-dim)" : GHOST.color }} title={g.title} data-company-toc-goal={g.short_id ?? g.id}>{g.title}</a>
            ))}
            <a href="#projects" onClick={scrollTo("projects")} className={cn(LINK, "mt-2.5 block")} style={{ color: "inherit" }}>Projects not under a goal</a>
            <a href="#people" onClick={scrollTo("people")} className={cn(LINK, "mt-2.5 block")} style={{ color: "inherit" }}>People and roles</a>
          </nav>
        )}
      </div>
    </div>
  );
}

function Section({ id, title, count, delay, children }: { id: string; title: string; count: number; delay: number; children: ReactNode }) {
  return (
    <section id={id} className="company-part mt-10 scroll-mt-6 border-t pt-4" style={{ borderColor: HAIRLINE, animationDelay: `${delay * 45}ms` }} data-company-section={id}>
      <h2 className="flex items-baseline gap-2 text-[12px] font-medium" style={{ color: "var(--sol-text-muted)" }}>
        {title}
        <span className="font-normal tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{count}</span>
      </h2>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="mt-3 italic" style={{ color: "var(--sol-text-dim)" }}>{children}</p>;

// ---------------------------------------------------------------- goals

function Goal({ goal, now, phone, onDecide }: { goal: DocGoal; now: number; phone: boolean; onDecide: Decide }) {
  const top = goal.depth === 1;
  return (
    <section id={`goal-${goal.id}`} className={cn("scroll-mt-6", top ? "mt-9 first-of-type:mt-5" : "mt-5")} data-company-goal={goal.short_id ?? goal.id} data-company-depth={goal.depth} data-company-goal-kind={goal.row ? "live" : goal.proposed ? "proposed" : "unknown"}>
      {goal.row ? <LiveGoalHead goal={goal} now={now} phone={phone} /> : <ProposedGoalHead goal={goal} phone={phone} onDecide={onDecide} />}
      {goal.changes.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {goal.changes.map((c) => <GoalChange key={c.row.change_id} change={c} onDecide={onDecide} />)}
        </div>
      )}
      {goal.projects.length > 0 && <ProjectList projects={goal.projects} now={now} phone={phone} className="mt-3" />}
      {goal.refs.length > 0 && (
        <p className="mt-2 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-company-refs={goal.refs.length}>
          Also carries{" "}
          {/* A purpose over every project would repeat the whole list: past a few, the count says it. */}
          {goal.refs.length > REFS_NAMED ? `${goal.refs.length} projects` : goal.refs.map((r, i) => (
            <span key={r.project.id}>{i > 0 && ", "}<Link href={`/projects/${r.project.id}`} className={LINK} style={{ color: "var(--sol-text-muted)" }} title={`Listed under ${r.under}`}>{r.project.title}</Link></span>
          ))}
          , listed under the {goal.refs.length === 1 ? "goal" : "goals"} nearest the work.
        </p>
      )}
      {goal.goals.length > 0 && (
        <div className={cn("mt-1 border-l", phone ? "ml-0.5 pl-3" : "ml-[3px] pl-5")} style={{ borderColor: HAIRLINE }} data-company-subgoals={goal.goals.length}>
          {goal.goals.map((g) => <Goal key={g.id} goal={g} now={now} phone={phone} onDecide={onDecide} />)}
        </div>
      )}
    </section>
  );
}

/** How many projects listed elsewhere a goal names before it counts them. */
const REFS_NAMED = 3;

const headingClass = (depth: number) => cn("min-w-0 font-semibold", depth === 1 ? "text-[17px] leading-[1.3] tracking-[-0.01em]" : "text-[14px] leading-[1.4]");

/** A goal the store holds: its name, who drives it, how it is going, and why. */
function LiveGoalHead({ goal, now, phone }: { goal: DocGoal; now: number; phone: boolean }) {
  const row = goal.row!;
  const Heading = goal.depth === 1 ? "h3" : "h4";
  const reading = metricReadings(row)[0];
  const ended = row.status === "completed" || row.status === "cancelled";
  const owner = <OwnerChip owner={row.owner} size={goal.depth === 1 ? 18 : 16} />;
  const why = row.why?.trim() || row.description?.trim().split(/\n\s*\n/)[0];
  return (
    <>
      <header className="flex items-baseline justify-between gap-5">
        <Heading className={headingClass(goal.depth)} style={SERIF} data-company-goal-title>
          <Link href={initiativeHref(row)} className={LINK} style={{ color: "inherit" }}>{goal.title}</Link>
        </Heading>
        {!phone && <span className="shrink-0 translate-y-[-1px]" data-company-byline>{owner}</span>}
      </header>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1" data-company-chips>
        {phone && owner}
        <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--sol-text-secondary)" }} data-company-status={row.status}>
          <StatusGlyph status={row.status} className="w-3 h-3" />
          {INITIATIVE_STATUS_LABEL[row.status]}
        </span>
        <HealthChip health={row.health} at={row.health_at} now={now} />
        {reading && <MetricTile reading={reading} trend={metricTrends(row)[reading.key]} now={now} size="line" />}
        <NextMilestoneChip milestone={nextMilestone(row)} now={now} counts={milestoneCounts(row)} />
        {row.target_date ? (
          <span className="inline-flex items-center gap-1 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>
            due <TargetDate ts={row.target_date} now={now} done={ended} />
          </span>
        ) : null}
      </div>
      {why && <p className="mt-2.5 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-why>{why}</p>}
      {row.done_when?.trim() && (
        <p className="mt-1.5 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-done-when>
          <span className="italic" style={{ ...SERIF, color: "var(--sol-text-muted)" }}>Done when</span>{" "}{row.done_when.trim()}
        </p>
      )}
    </>
  );
}

/** A ghost row's frame: dashed and tinted while it waits, solid in the accepted colour after. */
const ghostFrame = (status: DocChange["row"]["status"]) => ({
  border: CHIP_STATUS[status].border,
  background: status === "proposed" ? GHOST.fill : status === "failed" ? "color-mix(in srgb, var(--sol-red) 7%, transparent)" : "transparent",
});

function Verdict({ change, onDecide }: { change: DocChange; onDecide: Decide }) {
  const { row } = change;
  if (row.status !== "proposed" && row.status !== "failed") return <StatusPill status={row.status} />;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <OrgButton primary size="sm" onClick={() => onDecide(change, "accept")} title={row.line} data-company-accept={row.change_id}><Check className="h-3 w-3" /> {row.status === "failed" ? "Retry" : "Accept"}</OrgButton>
      <OrgButton size="sm" onClick={() => onDecide(change, "skip")} data-company-skip={row.change_id}><X className="h-3 w-3" /> Skip</OrgButton>
    </span>
  );
}

const FailedNote = ({ change }: { change: DocChange }) => (change.note ? <p className="mt-1 basis-full text-[11px]" style={{ color: CHIP_STATUS.failed.color }} data-company-change-note>{change.note}</p> : null);

/** A goal a proposal sets, where it would sit: a dashed heading while it
 *  waits, solid in the accepted colour until the store carries the goal. A
 *  goal a change names that nothing answers to is said as a warning. */
function ProposedGoalHead({ goal, phone, onDecide }: { goal: DocGoal; phone: boolean; onDecide: Decide }) {
  const Heading = goal.depth === 1 ? "h3" : "h4";
  const change = goal.proposed;
  if (!change) {
    return (
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Heading className={headingClass(goal.depth)} style={{ ...SERIF, color: "var(--sol-text-muted)" }} data-company-goal-title>{goal.title}</Heading>
        <GhostTag label="unknown" status="failed" />
      </header>
    );
  }
  const { row } = change;
  const waiting = row.status === "proposed" || row.status === "failed";
  return (
    <div className="rounded-lg px-3.5 py-3" style={ghostFrame(row.status)} title={row.line} data-company-goal-ghost={row.change_id} data-company-change={row.change_id} data-company-change-status={row.status} data-company-change-kind={row.kind}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <Heading className={cn(headingClass(goal.depth), "flex-1 basis-[260px]")} style={{ ...SERIF, color: waiting ? `color-mix(in srgb, ${CHIP_STATUS[row.status].color} 42%, var(--sol-text))` : "var(--sol-text)" }} data-company-goal-title>{goal.title}</Heading>
        {!phone && <Verdict change={change} onDecide={onDecide} />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} data-company-chips>
        <GhostTag label={row.status === "accepted" ? "accepted goal" : "proposed goal"} status={row.status} />
        {goal.owner ? (
          <span className="inline-flex min-w-0 items-center gap-1.5" data-company-ghost-owner={goal.owner.id}>
            <Face face={goal.owner} size={16} />
            <span className="truncate" style={row.unresolved ? { color: CHIP_STATUS.failed.color } : undefined}>{goal.owner.name}</span>
          </span>
        ) : <span className="italic" style={{ color: "var(--sol-text-dim)" }}>No owner</span>}
        {goal.measures.map((m) => <span key={m} className="min-w-0" data-company-ghost-measure>{m}</span>)}
      </div>
      {goal.description?.trim() && <p className="mt-2 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-why>{goal.description.trim()}</p>}
      {/* On a phone the verdict follows what it decides. */}
      {phone && <div className="mt-2.5"><Verdict change={change} onDecide={onDecide} /></div>}
      <FailedNote change={change} />
    </div>
  );
}

/** A change to a goal that exists, as one dashed line under it: its new
 *  place, how it is measured, who owns it, a project it gains. */
function GoalChange({ change, onDecide }: { change: DocChange; onDecide: Decide }) {
  const { row } = change;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2.5 py-1.5 text-[12px]" style={ghostFrame(row.status)} title={row.line} data-company-change={row.change_id} data-company-change-status={row.status} data-company-change-kind={row.kind}>
      <span className="flex min-w-0 flex-1 basis-[220px] flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--sol-text-secondary)" }}>
        <GhostTag label={row.tag} status={row.status} />
        {row.owner && (
          <span className="inline-flex min-w-0 items-center gap-1.5" data-company-ghost-owner={row.owner.id}>
            <Face face={row.owner} size={16} />
            <span className="truncate" style={row.unresolved ? { color: CHIP_STATUS.failed.color } : undefined}>{row.owner.name}</span>
          </span>
        )}
        {change.under && <span className="min-w-0" data-company-change-under>under {change.under}</span>}
        {row.detail && <span className="min-w-0">{row.detail}</span>}
        {row.from && <span style={{ color: "var(--sol-text-dim)" }}>was under {row.from.name}</span>}
      </span>
      <Verdict change={change} onDecide={onDecide} />
      <FailedNote change={change} />
    </div>
  );
}

// ---------------------------------------------------------------- projects

function ProjectList({ projects, now, phone, className }: { projects: readonly DocProject[]; now: number; phone: boolean; className?: string }) {
  return (
    <ul className={cn("m-0 list-none p-0", className ?? "mt-2")} data-company-projects={projects.length}>
      {projects.map((p) => <ProjectLine key={p.id} project={p} now={now} phone={phone} />)}
    </ul>
  );
}

/** One project as a row: its name, who leads it, its status, when it last
 *  changed and how much of it is done. A row a proposal adds is dashed. */
function ProjectLine({ project, now, phone }: { project: DocProject; now: number; phone: boolean }) {
  const ghost = project.ghost && !project.ghost.solid ? project.ghost : null;
  const title = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span aria-hidden className="w-2 shrink-0 translate-y-[-3px] border-t" style={{ borderColor: ghost ? GHOST.color : "var(--sol-text-dim)", borderTopStyle: ghost ? "dashed" : "solid" }} />
      <Link href={`/projects/${project.id}`} className={cn(LINK, "min-w-0 truncate")} style={{ color: "var(--sol-text)" }} title={project.title}>{project.title}</Link>
      {ghost?.tag && <GhostTag label={ghost.tag} status={ghost.status} />}
      {project.proposedUnder && <span className="min-w-0 truncate text-[11px]" style={{ color: GHOST.color }} title={`A proposal would put it under ${project.proposedUnder}`} data-company-proposed-under>proposed under {project.proposedUnder}</span>}
    </span>
  );
  const status = project.status ? <span className="text-[11.5px] capitalize" style={{ color: "var(--sol-text-muted)" }} data-company-project-status>{project.status}</span> : <span />;
  const activity = project.updated_at ? <span className="text-[11.5px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} title="Last changed" data-company-project-activity>{shortDate(project.updated_at, now)}</span> : <span />;
  const counts = project.counts ? <span className="text-[11.5px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} data-company-project-counts={`${project.counts.open}/${project.counts.done}`}>{project.counts.open} open, {project.counts.done} done</span> : <span />;
  const lead = <ProjectLeadChip projectId={project.id} size="xs" />;
  return (
    <li className={cn("min-w-0 py-[5px]", !phone && "grid grid-cols-[minmax(0,1fr)_150px_58px_52px_112px] items-baseline gap-x-3")} data-company-project={project.short_id ?? project.id} data-company-project-ghost={ghost ? ghost.status : undefined}>
      {title}
      {phone ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4" data-company-project-meta>{lead}{status}{activity}{counts}</div>
      ) : (
        <>
          <span className="min-w-0 self-center">{lead}</span>
          {status}
          <span className="text-right">{activity}</span>
          <span className="text-right">{counts}</span>
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- people and roles

/** A role or record change that sits on no goal: the proposal card's own line, with its verdict. */
function StaffingChange({ change, onDecide, className }: { change: DocChange; onDecide: Decide; className?: string }) {
  const { row } = change;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2.5 py-1.5", className)} style={ghostFrame(row.status)} title={row.line} data-company-change={row.change_id} data-company-change-status={row.status} data-company-change-kind={row.kind}>
      <div className="min-w-0 flex-1 basis-[220px]">
        <NodeLine row={row} />
        {row.detail && <span className="mt-0.5 block truncate pl-1 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{row.detail}</span>}
      </div>
      <Verdict change={change} onDecide={onDecide} />
      <FailedNote change={change} />
    </div>
  );
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline gap-2 text-[12px]">
    <span className="w-[44px] shrink-0" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">{children}</span>
  </div>
);

const Goals = ({ goals }: { goals: readonly DocRef[] }) => (
  <>{goals.map((g) => (g.short_id ? <EntityIdPill key={g.id} type="initiative" id={g.short_id} label={g.title} /> : <Link key={g.id} href={`/initiatives/${g.id}`} className={LINK} style={{ color: "var(--sol-text-secondary)" }}>{g.title}</Link>))}</>
);

function Role({ entry, onDecide }: { entry: DocRole; onDecide: Decide }) {
  const { role } = entry;
  return (
    <div className="mt-5 flex gap-3" data-company-role={role.short_id}>
      <span className="shrink-0 pt-[1px]"><RoleFace role={role} size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-[14px] font-semibold leading-[1.4]" style={SERIF}><Link href={`/org/${role.short_id}`} className={LINK} style={{ color: "inherit" }}>{role.name}</Link></h4>
          <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>@{role.handle}</span>
          {role.status === "paused" && <span className="text-[11.5px]" style={{ color: "var(--sol-yellow)" }}>paused</span>}
          {entry.reportsTo && <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>reports to {entry.reportsTo}</span>}
        </div>
        {entry.charter && <p className="mt-0.5 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-charter>{entry.charter}</p>}
        <div className="mt-1 space-y-0.5">
          {entry.leads.length > 0 && (
            <Fact label="Leads">
              {entry.leads.map((p) => <Link key={p.id} href={`/projects/${p.id}`} className={LINK} style={{ color: "var(--sol-text-secondary)" }} data-company-leads={p.short_id ?? p.id}>{p.title}</Link>)}
            </Fact>
          )}
          {entry.goals.length > 0 && <Fact label="Owns"><Goals goals={entry.goals} /></Fact>}
          {entry.leads.length + entry.goals.length === 0 && <p className="text-[12px] italic" style={{ color: "var(--sol-text-dim)" }} data-company-role-idle>Owns no goal and leads no project</p>}
        </div>
        {entry.changes.map((c) => <StaffingChange key={c.row.change_id} change={c} onDecide={onDecide} className="mt-2" />)}
      </div>
    </div>
  );
}

function Person({ person }: { person: DocPerson }) {
  return (
    <div className="mt-5 flex gap-3" data-company-person={person.id}>
      <span className="shrink-0"><Face face={{ kind: "person", id: person.id, name: person.name, image: person.image, me: person.me }} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-[14px] font-semibold leading-[1.4]" style={SERIF}>
            {person.username ? <Link href={`/team/${person.username}`} className={LINK} style={{ color: "inherit" }}>{person.name}</Link> : person.name}
          </h4>
          {person.me && <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>you</span>}
        </div>
        <div className="mt-1 space-y-0.5">
          {person.roles.length > 0 && (
            <Fact label="Roles">
              {person.roles.map((r) => <Link key={r._id} href={`/org/${r.short_id}`} className={LINK} style={{ color: "var(--sol-text-secondary)" }} data-company-reports={r.short_id}>{r.name}</Link>)}
            </Fact>
          )}
          {person.goals.length > 0 && <Fact label="Owns"><Goals goals={person.goals} /></Fact>}
          {person.roles.length + person.goals.length === 0 && <p className="text-[12px] italic" style={{ color: "var(--sol-text-dim)" }}>Owns no goal yet</p>}
        </div>
      </div>
    </div>
  );
}
