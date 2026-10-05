"use client";
// /company: the whole company read top to bottom like a document
// (docs/architecture/initiatives-projects-role-page.md I5 "Where it shows").
// The company and why it exists, each goal with who drives it and how it is
// going, the projects that carry it, the projects no goal carries, then the
// roles and the people. Every name is a link to the thing it names: a goal, a
// project, a role and a person by its page, a goal or a role a proposal sets
// by its place on this page, a proposal by the org page that shows it.
//
// Paints from the store: the joining is companyModel (pure), over the same
// goal outline the chart's Goals lens draws. An open proposal's changes are
// drawn in place, in ghost chrome, each with its own Accept and Skip, which
// run the store action the org page runs.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, milestoneCounts, nextMilestone } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useBoardTasks, useInitiatives, useTasksBackfilled } from "../../hooks/useInitiatives";
import { orgRolesSig } from "../../hooks/useOrgRoles";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { initiativeHref } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { roleHref } from "../charter/charterMeta";
import { EntityIdPill } from "../EntityIdPill";
import { HealthChip, MetricTile, NextMilestoneChip, OwnerChip, StatusGlyph, TargetDate, shortDate } from "../initiatives/InitiativeAtoms";
import { OrgButton } from "../org/OrgButton";
import { Face } from "../org/ProposalSubjectCard";
import { RoleFace } from "../org/RoleFace";
import { GhostTag, StatusPill } from "../org/ghostChrome";
import { CHIP_STATUS, GHOST, changeFrameStyle } from "../org/orgMeta";
import { joinProposals, type OrgProposalChange, type OrgProposalRow } from "../org/orgStaffingTypes";
import { proposalSeen } from "../org/proposalHooks";
import { openProposals, proposalWorkspace, sameWorkspace } from "../org/staffingModel";
import type { OrgTree } from "../org/orgTypes";
import { changeAnchor, companyDoc, flatGoals, goalAnchor, projectHref, proposalHref, tallyLine, type CompanyDoc, type CompanyProject, type DocChange, type DocGoal, type DocPerson, type DocProject, type DocRef, type DocRole } from "./companyModel";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const SERIF = { fontFamily: "var(--font-serif)" } as const;
const LINK = "no-underline hover:underline decoration-1 underline-offset-[3px]";
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.updated_at}`;

/** What the document reads off the org tree: what a name lookup reads
 *  (orgRolesSig), each role's charter, and who the people are. Sessions,
 *  counts and an agent's live state are not in it, so a message in the
 *  workspace repaints nothing here. */
function companyTreeSig(tree: OrgTree | null | undefined): string {
  if (!tree) return "";
  let sig = orgRolesSig(tree);
  for (const r of tree.roles) sig += `\n#${r._id}|${r.charter ?? ""}`;
  for (const p of tree.people) sig += `\n&${p.user_id}|${p.name}|${p.image ?? ""}|${p.is_me ? 1 : 0}`;
  return sig;
}

type Decide = (change: DocChange, verdict: "accept" | "skip") => void;
type ProposalLink = Pick<OrgProposalRow, "_id" | "short_id" | "title">;

/** The layout the document's own width affords, never the window's: the page
 *  sits in a pane beside the sidebar and the session list. Narrow is one
 *  column with a project's facts under its name; wide adds the contents list
 *  beside the article. */
export type CompanyLayout = "narrow" | "page" | "wide";
export const companyLayout = (width: number): CompanyLayout => (width < 720 ? "narrow" : width < 1100 ? "page" : "wide");

function useCompanyLayout(): [React.RefObject<HTMLDivElement | null>, CompanyLayout] {
  const ref = useRef<HTMLDivElement>(null);
  // Unmeasured (the server's render) is the plain page; the measure lands before the first paint.
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width === null ? "page" : companyLayout(width)];
}

/** Feeds one open proposal's changes into the store. */
function ProposalFeed({ shortId }: { shortId: string }) {
  useSyncOrgProposal(shortId);
  return null;
}

export function CompanyDocument() {
  // The feeders the goal page mounts, plus the workspace's proposals. The
  // tree is the roles feeder's (org.roles: roles, seats and people, no
  // session), read under a signature of what the document draws.
  useSyncOrgTreeFeeder();
  useSyncProjects();
  useSyncOrgProposals();
  const treeSig = useInboxStore((s) => companyTreeSig(s.orgTree));
  const tree = useMemo(() => useInboxStore.getState().orgTree, [treeSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const initiatives = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const tasks = useBoardTasks();
  const tasksCounted = useTasksBackfilled();
  const roster = useTeamRosterIdentity();
  const teamName = useInboxStore((s) => { const id = s.clientState.ui?.active_team_id; return id ? ((s.teams ?? []) as { _id?: string; name?: string }[]).find((t) => t?._id === id)?.name ?? null : null; });
  const proposalRows = useInboxStore((s) => s.orgProposals);
  const proposalChanges = useInboxStore((s) => s.orgProposalChanges);
  const now = useCoarseNow(60_000);

  const workspace = tree?.workspace;
  const open = useMemo<OrgProposalRow[]>(
    () => (workspace ? openProposals(joinProposals(proposalRows, proposalChanges)).filter((p) => sameWorkspace(proposalWorkspace(p), workspace)) : []),
    [proposalRows, proposalChanges, workspace?.kind, workspace?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const changes = useMemo<OrgProposalChange[]>(() => open.flatMap((p) => p.changes), [open]);
  const doc = useMemo(() => companyDoc({ tree, workspaceName: teamName, initiatives, projects: projects as CompanyProject[], roster, tasks, tasksCounted, changes, proposals: open }), [tree, teamName, initiatives, projects, roster, tasks, tasksCounted, changes, open]);
  const decide = useCallback<Decide>((change, verdict) => {
    useInboxStore.getState().decideOrgProposalChange(change.row.change_id, verdict, undefined, proposalSeen(changes.filter((c) => c.proposal_id === change.proposal_id)));
  }, [changes]);

  return (
    <>
      {open.map((p) => <ProposalFeed key={p._id} shortId={p.short_id} />)}
      <CompanyDocumentView doc={doc} now={now} proposals={doc.waiting > 0 ? open : NO_PROPOSALS} onDecide={decide} />
    </>
  );
}
const NO_PROPOSALS: ProposalLink[] = [];

/** Scrolls to a part of the page; a compact contents list folds once it has been used. */
const scrollTo = (id: string) => (e: React.MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  (e.currentTarget as HTMLElement).closest("details[data-company-toc]")?.removeAttribute("open");
};

/** A name, as a link when it leads somewhere: a page, or a place on this one. */
function Name({ href, className, style, title, children, ...rest }: { href?: string; className?: string; style?: CSSProperties; title?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const look = { className: cn(href && LINK, className), style: { color: "inherit", ...style }, title, ...rest };
  if (!href) return <span {...look}>{children}</span>;
  if (href.startsWith("#")) return <a href={href} onClick={scrollTo(href.slice(1))} {...look}>{children}</a>;
  return <Link href={href} {...look}>{children}</Link>;
}

export function CompanyDocumentView({ doc, now, proposals, onDecide }: { doc: CompanyDoc; now: number; proposals: readonly ProposalLink[]; onDecide: Decide }) {
  const [ref, layout] = useCompanyLayout();
  const narrow = layout === "narrow";
  const showUnfiled = doc.unfiled.length > 0 || doc.tally.projects === 0;
  const written = doc.purpose.some((p) => !p.status);
  return (
    <div ref={ref} className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-company-document data-company-layout={layout}>
      <style>{`
        @keyframes company-rise { from { opacity: 0; transform: translateY(4px); } }
        .company-part { animation: company-rise .24s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .company-part { animation: none; } }
      `}</style>
      <div className={cn("mx-auto flex w-full max-w-[1040px] items-start justify-center gap-12", narrow ? "px-4 pt-5 pb-16" : "px-8 pt-10 pb-24")}>
        <article className="min-w-0 w-full max-w-[760px] text-[13px] leading-[1.65]">
          <header className="company-part scroll-mt-6" id="company" data-company-section="company">
            <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.015em]" style={SERIF} data-company-name>{doc.name}</h1>
            {doc.purpose.length > 0 ? (
              <div className="mt-3 max-w-[64ch] space-y-2" data-company-purpose={written ? "" : "proposed"}>
                {doc.purpose.map((p, i) => (
                  // A purpose a proposal sets reads in the change's colour, with the one word that says so.
                  <p key={i} style={p.status ? { color: CHIP_STATUS[p.status].color } : undefined} data-company-purpose-line={p.status ?? "written"}>
                    {p.text}{p.status && <> <GhostTag label={p.status === "accepted" ? "accepted" : "proposed"} status={p.status} quiet className="ml-1 align-baseline" /></>}
                  </p>
                ))}
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
                    <Link href={proposalHref(p.short_id)} className={cn(LINK, "font-medium")} style={{ color: GHOST.color }} title={p.title}>{p.short_id}</Link>
                  </span>
                ))}
              </p>
            )}
            {layout !== "wide" && <Contents doc={doc} showUnfiled={showUnfiled} compact />}
          </header>

          <Section id="goals" title="Goals" count={doc.tally.goals} delay={1}>
            {doc.goals.length === 0 ? (
              <Quiet>No goals yet. Set the first one on the <Link href="/initiatives" className={LINK} style={{ color: "var(--sol-text-secondary)" }}>initiatives page</Link>.</Quiet>
            ) : doc.goals.map((g) => <Goal key={g.id} goal={g} now={now} narrow={narrow} onDecide={onDecide} />)}
          </Section>

          {/* Only when something is loose: a section that says "none" reads as a problem to solve. */}
          {showUnfiled && (
            <Section id="projects" title="Projects not under a goal" count={doc.unfiled.length} delay={2}>
              {doc.unfiled.length === 0 ? <Quiet>No projects yet.</Quiet> : <ProjectList projects={doc.unfiled} now={now} narrow={narrow} />}
            </Section>
          )}

          <Section id="people" title="People and roles" count={doc.tally.people + doc.tally.roles} delay={3}>
            {doc.staffing.map((c) => <ChangeLine key={c.row.change_id} change={c} onDecide={onDecide} subject className="mt-3" />)}
            {doc.roles.map((r) => <Role key={r.role._id} entry={r} onDecide={onDecide} />)}
            {doc.people.map((p) => <Person key={p.id} person={p} />)}
            {doc.roles.length + doc.people.length + doc.staffing.length === 0 && <Quiet>Nobody here yet.</Quiet>}
          </Section>
        </article>

        {layout === "wide" && <Contents doc={doc} showUnfiled={showUnfiled} />}
      </div>
    </div>
  );
}

/** The parts of the page by name, every goal under the one it feeds. Beside
 *  the article where there is room; in a narrower document, a line under the
 *  header that opens. */
function Contents({ doc, showUnfiled, compact }: { doc: CompanyDoc; showUnfiled: boolean; compact?: boolean }) {
  const part = (id: string, label: string) => <a href={`#${id}`} onClick={scrollTo(id)} className={cn(LINK, "mt-2.5 block")} style={{ color: "inherit" }}>{label}</a>;
  const list = (
    <>
      {!compact && <a href="#company" onClick={scrollTo("company")} className={cn(LINK, "block truncate font-medium")} style={{ color: "var(--sol-text)" }}>{doc.name}</a>}
      {part("goals", "Goals")}
      {flatGoals(doc.goals).map((g) => (
        <a key={g.id} href={`#${goalAnchor(g.id)}`} onClick={scrollTo(goalAnchor(g.id))} className={cn(LINK, "mt-1 block truncate")} style={{ paddingLeft: g.depth * 12, color: g.row ? "var(--sol-text-dim)" : GHOST.color }} title={g.title} data-company-toc-goal={g.short_id ?? g.id} data-company-toc-depth={g.depth}>{g.title}</a>
      ))}
      {showUnfiled && part("projects", "Projects not under a goal")}
      {part("people", "People and roles")}
    </>
  );
  if (compact) {
    return (
      <details className="mt-3 text-[12px] leading-[1.5]" style={{ color: "var(--sol-text-muted)" }} data-company-toc="compact">
        <summary className="w-fit cursor-pointer select-none">Contents</summary>
        <nav aria-label="Contents" className="mt-1 border-l pb-1 pl-3" style={{ borderColor: HAIRLINE }}>{list}</nav>
      </details>
    );
  }
  return (
    <nav aria-label="Contents" className="company-part sticky top-10 max-h-[calc(100vh-5rem)] w-[208px] shrink-0 overflow-y-auto border-l pl-4 text-[12px] leading-[1.5]" style={{ borderColor: HAIRLINE, color: "var(--sol-text-muted)" }} data-company-toc="beside">
      {list}
    </nav>
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

function Goal({ goal, now, narrow, onDecide }: { goal: DocGoal; now: number; narrow: boolean; onDecide: Decide }) {
  const top = goal.depth === 1;
  const refs = goal.refs.map((r, i) => (
    <span key={r.project.id}>{i > 0 && ", "}<Link href={projectHref(r.project.id)} className={LINK} style={{ color: "var(--sol-text-muted)" }} title={`Listed under ${r.under}`}>{r.project.title}</Link></span>
  ));
  const nearest = `listed under the ${goal.refs.length === 1 ? "goal" : "goals"} nearest the work.`;
  return (
    <section id={goalAnchor(goal.id)} className={cn("scroll-mt-6", top ? "mt-9 first-of-type:mt-5" : "mt-5")} data-company-goal={goal.short_id ?? goal.id} data-company-depth={goal.depth} data-company-goal-kind={goal.row ? "live" : goal.proposed ? "proposed" : "unknown"}>
      {goal.row ? <LiveGoalHead goal={goal} now={now} narrow={narrow} /> : <ProposedGoalHead goal={goal} narrow={narrow} onDecide={onDecide} />}
      {goal.changes.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {goal.changes.map((c) => <ChangeLine key={c.row.change_id} change={c} onDecide={onDecide} />)}
        </div>
      )}
      {goal.projects.length > 0 && <ProjectList projects={goal.projects} now={now} narrow={narrow} className="mt-3" />}
      {/* A purpose over every project would repeat the whole list: past a few, the count says it and opens to the names. */}
      {goal.refs.length > REFS_NAMED ? (
        <details className="mt-2 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-company-refs={goal.refs.length}>
          <summary className="w-fit cursor-pointer">Also carries {goal.refs.length} projects, {nearest}</summary>
          <p className="mt-1 pl-3.5">{refs}</p>
        </details>
      ) : goal.refs.length > 0 ? (
        <p className="mt-2 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-company-refs={goal.refs.length}>Also carries {refs}, {nearest}</p>
      ) : null}
      {goal.goals.length > 0 && (
        <div className={cn("mt-1 border-l", narrow ? "ml-0.5 pl-3" : "ml-[3px] pl-5")} style={{ borderColor: HAIRLINE }} data-company-subgoals={goal.goals.length}>
          {goal.goals.map((g) => <Goal key={g.id} goal={g} now={now} narrow={narrow} onDecide={onDecide} />)}
        </div>
      )}
    </section>
  );
}

/** How many projects listed elsewhere a goal names before it counts them. */
const REFS_NAMED = 3;

const headingClass = (depth: number) => cn("min-w-0 font-semibold", depth === 1 ? "text-[17px] leading-[1.3] tracking-[-0.01em]" : "text-[14px] leading-[1.4]");

/** A goal's written record as its own lines: why it matters, what done looks like, the milestones a change adds. */
function GoalWords({ why, doneWhen, milestones = [], className }: { why?: string | null; doneWhen?: string | null; milestones?: readonly string[]; className?: string }) {
  const label = (text: string) => <span className="italic" style={{ ...SERIF, color: "var(--sol-text-muted)" }}>{text}</span>;
  if (!why?.trim() && !doneWhen?.trim() && milestones.length === 0) return null;
  return (
    <div className={cn("max-w-[66ch] space-y-1.5", className)} style={{ color: "var(--sol-text-secondary)" }}>
      {why?.trim() && <p data-company-why>{why.trim()}</p>}
      {doneWhen?.trim() && <p data-company-done-when>{label("Done when")}{" "}{doneWhen.trim()}</p>}
      {milestones.length > 0 && <p data-company-milestones={milestones.length}>{label(milestones.length === 1 ? "Milestone" : "Milestones")}{" "}{milestones.join("; ")}</p>}
    </div>
  );
}

/** A goal the store holds: its name, who drives it, how it is going, and why. */
function LiveGoalHead({ goal, now, narrow }: { goal: DocGoal; now: number; narrow: boolean }) {
  const row = goal.row!;
  const Heading = goal.depth === 1 ? "h3" : "h4";
  const reading = metricReadings(row)[0];
  const ended = row.status === "completed" || row.status === "cancelled";
  const owner = <Name href={goal.ownerHref} className="inline-flex min-w-0" data-company-owner={row.owner?.kind}><OwnerChip owner={row.owner} size={goal.depth === 1 ? 18 : 16} /></Name>;
  return (
    <>
      <header className="flex items-baseline justify-between gap-5">
        <Heading className={headingClass(goal.depth)} style={SERIF} data-company-goal-title>
          <Link href={initiativeHref(row)} className={LINK} style={{ color: "inherit" }}>{goal.title}</Link>
        </Heading>
        {!narrow && <span className="shrink-0 translate-y-[-1px]" data-company-byline>{owner}</span>}
      </header>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1" data-company-chips>
        {narrow && owner}
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
      <GoalWords why={goal.purpose} doneWhen={row.done_when} className="mt-2.5" />
    </>
  );
}

/** A change's frame, the chart's own (orgMeta changeFrameStyle): a thin outline in the status colour over a soft tint. Never dashed. */
const ghostFrame = (row: DocChange["row"]) => changeFrameStyle(row.status, row.unresolved);

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

/** Who a change makes the owner: the face, and the name as a link when it leads somewhere. */
function ChangeOwner({ face, href, unresolved }: { face: NonNullable<DocChange["row"]["owner"]>; href?: string; unresolved?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" data-company-ghost-owner={face.id}>
      <Face face={face} size={16} />
      <Name href={href} className="min-w-0" style={unresolved ? { color: CHIP_STATUS.failed.color } : undefined}>{face.name}</Name>
    </span>
  );
}

/** A goal a proposal sets, where it would sit: tinted in the proposal's
 *  colour while it waits, outlined in the accepted colour until the store
 *  carries the goal. Its name opens the proposal that sets it. A
 *  goal a change names that nothing answers to is said as a warning. */
function ProposedGoalHead({ goal, narrow, onDecide }: { goal: DocGoal; narrow: boolean; onDecide: Decide }) {
  const Heading = goal.depth === 1 ? "h3" : "h4";
  const change = goal.proposed;
  if (!change) {
    return (
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Heading className={headingClass(goal.depth)} style={{ ...SERIF, color: "var(--sol-text-muted)" }} data-company-goal-title>{goal.title}</Heading>
        <GhostTag label="unknown" status="failed" quiet />
      </header>
    );
  }
  const { row } = change;
  const waiting = row.status === "proposed" || row.status === "failed";
  return (
    <div id={changeAnchor(row.change_id)} className="scroll-mt-6 rounded-lg px-3.5 py-3" style={ghostFrame(row)} title={row.line} data-company-goal-ghost={row.change_id} data-company-change={row.change_id} data-company-change-status={row.status} data-company-change-kind={row.kind}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <Heading className={cn(headingClass(goal.depth), "flex-1 basis-[260px]")} style={{ ...SERIF, color: waiting ? `color-mix(in srgb, ${CHIP_STATUS[row.status].color} 42%, var(--sol-text))` : "var(--sol-text)" }} data-company-goal-title>
          <Name href={change.hrefs.proposal}>{goal.title}</Name>
        </Heading>
        {!narrow && <Verdict change={change} onDecide={onDecide} />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} data-company-chips>
        <GhostTag label={row.status === "accepted" ? "accepted goal" : "proposed goal"} status={row.status} quiet />
        {goal.owner ? <ChangeOwner face={goal.owner} href={goal.ownerHref} unresolved={row.unresolved} /> : <span className="italic" style={{ color: "var(--sol-text-dim)" }}>No owner</span>}
        {goal.measures.map((m) => <span key={m} className="min-w-0" data-company-ghost-measure>{m}</span>)}
      </div>
      {goal.description?.trim() && <p className="mt-2 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-description>{goal.description.trim()}</p>}
      <GoalWords why={goal.record?.why} doneWhen={goal.record?.done_when} milestones={goal.record?.milestones} className="mt-1.5" />
      {/* In a narrow document the verdict follows what it decides. */}
      {narrow && <div className="mt-2.5"><Verdict change={change} onDecide={onDecide} /></div>}
      <FailedNote change={change} />
    </div>
  );
}

/** One proposed change as a tinted line that wraps: the word for it, what it
 *  names, and its verdict. Under a goal or a role the heading above is the
 *  subject, so the line says only what changes; a change that stands alone
 *  (a role to hire, a record to close) names its `subject` first. A row whose
 *  own words leave something unsaid says the change's plain sentence. */
function ChangeLine({ change, onDecide, subject, className }: { change: DocChange; onDecide: Decide; subject?: boolean; className?: string }) {
  const { row, hrefs } = change;
  const node = row.node;
  const worded = subject || !!(row.tag || row.chip || row.owner || change.under || row.detail || row.from);
  return (
    <div id={changeAnchor(row.change_id)} className={cn("flex scroll-mt-6 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2.5 py-1.5 text-[12px]", className)} style={ghostFrame(row)} title={row.line} data-company-change={row.change_id} data-company-change-status={row.status} data-company-change-kind={row.kind}>
      <span className="flex min-w-0 flex-1 basis-[220px] flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--sol-text-secondary)" }}>
        {subject && (
          <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5" data-company-change-node={node.kind}>
            <Face face={node} size={16} />
            <Name href={hrefs.node} className={cn("font-medium", (row.kind === "retire" || row.closes) && "line-through")} style={{ color: "var(--sol-text)" }}>{node.name}</Name>
            {node.kind === "role" && <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>@{node.handle}</span>}
          </span>
        )}
        {row.tag && <GhostTag label={row.tag} status={row.status} quiet />}
        {row.chip && <span className="min-w-0" data-company-change-chip>{row.chip}</span>}
        {row.owner && <ChangeOwner face={row.owner} href={hrefs.owner} unresolved={row.unresolved} />}
        {change.under ? (
          <span className="min-w-0" data-company-change-under>under <Name href={hrefs.parent}>{change.under}</Name></span>
        ) : row.parent && row.parent.kind !== "goal" ? (
          <span className="min-w-0" data-company-change-parent>{node.kind === "session" ? "under" : "reports to"} <Name href={hrefs.parent}>{row.parent.name}</Name></span>
        ) : null}
        {row.detail && <span className="min-w-0" style={subject ? { color: "var(--sol-text-dim)" } : undefined}>{row.detail}</span>}
        {row.from && <span style={{ color: "var(--sol-text-dim)" }}>was under <Name href={hrefs.from}>{row.from.name}</Name></span>}
        {(change.sentence || !worded) && <span className="min-w-0" data-company-change-sentence>{change.sentence ?? row.line}</span>}
      </span>
      <Verdict change={change} onDecide={onDecide} />
      <GoalWords why={change.record?.why} doneWhen={change.record?.done_when} milestones={change.record?.milestones} className="basis-full" />
      <FailedNote change={change} />
    </div>
  );
}

// ---------------------------------------------------------------- projects

function ProjectList({ projects, now, narrow, className }: { projects: readonly DocProject[]; now: number; narrow: boolean; className?: string }) {
  return (
    <ul className={cn("m-0 list-none p-0", className ?? "mt-2")} data-company-projects={projects.length}>
      {projects.map((p) => <ProjectLine key={p.id} project={p} now={now} narrow={narrow} />)}
    </ul>
  );
}

/** One project as a row: its name, who leads it, its status, when it last
 *  changed and how much of it is done. A row a proposal adds, or one only a
 *  proposed goal would carry, says so in the proposal's one word. */
function ProjectLine({ project, now, narrow }: { project: DocProject; now: number; narrow: boolean }) {
  const ghost = project.ghost && !project.ghost.solid ? project.ghost : null;
  const title = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span aria-hidden className="w-2 shrink-0 translate-y-[-3px] border-t" style={{ borderColor: ghost ? GHOST.color : "var(--sol-text-dim)" }} />
      <Link href={projectHref(project.id)} className={cn(LINK, "min-w-0 truncate")} style={{ color: "var(--sol-text)" }} title={project.title}>{project.title}</Link>
      {ghost && <GhostTag label={ghost.tag ?? "proposed"} status={ghost.status} quiet />}
    </span>
  );
  const status = project.status ? <span className="text-[11.5px] capitalize" style={{ color: "var(--sol-text-muted)" }} data-company-project-status>{project.status}</span> : <span />;
  const activity = project.updated_at ? <span className="text-[11.5px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} title="Last changed" data-company-project-activity>{shortDate(project.updated_at, now)}</span> : <span />;
  const counts = project.counts === "counting"
    ? <span className="text-[11.5px] italic whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} title="Counting: the task cache is still filling" data-company-project-counts="counting">counting</span>
    : project.counts ? <span className="text-[11.5px] tabular-nums whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} data-company-project-counts={`${project.counts.open}/${project.counts.done}`}>{project.counts.open} open, {project.counts.done} done</span> : <span />;
  const lead = project.lead
    ? <Link href={roleHref(project.lead)} className={cn(LINK, "inline-flex min-w-0 items-center gap-1.5 text-[11.5px]")} style={{ color: "var(--sol-text-secondary)" }} data-company-project-lead={project.lead.handle}><RoleFace role={project.lead} size={14} /><span className="truncate">{project.lead.name}</span></Link>
    : <span className="text-[11.5px] italic" style={{ color: "var(--sol-text-dim)" }} data-company-project-lead="none">No lead</span>;
  return (
    <li className={cn("min-w-0 py-[5px]", !narrow && "grid grid-cols-[minmax(0,1fr)_150px_58px_52px_112px] items-baseline gap-x-3")} data-company-project={project.short_id ?? project.id} data-company-project-ghost={ghost ? ghost.status : undefined}>
      {title}
      {narrow ? (
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

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline gap-2 text-[12px]">
    <span className="w-[44px] shrink-0" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">{children}</span>
  </div>
);

const Goals = ({ goals }: { goals: readonly DocRef[] }) => (
  <>{goals.map((g) => (g.short_id ? <EntityIdPill key={g.id} type="initiative" id={g.short_id} label={g.title} /> : <Link key={g.id} href={initiativeHref({ _id: g.id, short_id: "" })} className={LINK} style={{ color: "var(--sol-text-secondary)" }}>{g.title}</Link>))}</>
);

function Role({ entry, onDecide }: { entry: DocRole; onDecide: Decide }) {
  const { role } = entry;
  return (
    <div className="mt-5 flex gap-3" data-company-role={role.short_id}>
      <span className="shrink-0 pt-[1px]"><RoleFace role={role} size={22} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-[14px] font-semibold leading-[1.4]" style={SERIF}><Link href={roleHref(role)} className={LINK} style={{ color: "inherit" }}>{role.name}</Link></h4>
          <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>@{role.handle}</span>
          {role.status === "paused" && <span className="text-[11.5px]" style={{ color: "var(--sol-yellow)" }}>paused</span>}
          {entry.reportsTo && <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>reports to <Name href={entry.reportsTo.href} data-company-reports-to={role.short_id}>{entry.reportsTo.name}</Name></span>}
        </div>
        {entry.charter && <p className="mt-0.5 max-w-[66ch]" style={{ color: "var(--sol-text-secondary)" }} data-company-charter>{entry.charter}</p>}
        <div className="mt-1 space-y-0.5">
          {entry.leads.length > 0 && (
            <Fact label="Leads">
              {entry.leads.map((p) => <Link key={p.id} href={projectHref(p.id)} className={LINK} style={{ color: "var(--sol-text-secondary)" }} data-company-leads={p.short_id ?? p.id}>{p.title}</Link>)}
            </Fact>
          )}
          {entry.goals.length > 0 && <Fact label="Owns"><Goals goals={entry.goals} /></Fact>}
          {entry.leads.length + entry.goals.length === 0 && <p className="text-[12px] italic" style={{ color: "var(--sol-text-dim)" }} data-company-role-idle>Owns no goal and leads no project</p>}
        </div>
        {entry.changes.map((c) => <ChangeLine key={c.row.change_id} change={c} onDecide={onDecide} className="mt-2" />)}
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
          <h4 className="text-[14px] font-semibold leading-[1.4]" style={SERIF}><Link href={person.href} className={LINK} style={{ color: "inherit" }}>{person.name}</Link></h4>
          {person.me && <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>you</span>}
        </div>
        <div className="mt-1 space-y-0.5">
          {person.roles.length > 0 && (
            <Fact label="Roles">
              {person.roles.map((r) => <Link key={r._id} href={roleHref(r)} className={LINK} style={{ color: "var(--sol-text-secondary)" }} data-company-reports={r.short_id}>{r.name}</Link>)}
            </Fact>
          )}
          {person.goals.length > 0 && <Fact label="Owns"><Goals goals={person.goals} /></Fact>}
          {person.roles.length + person.goals.length === 0 && <p className="text-[12px] italic" style={{ color: "var(--sol-text-dim)" }}>Owns no goal yet</p>}
        </div>
      </div>
    </div>
  );
}
