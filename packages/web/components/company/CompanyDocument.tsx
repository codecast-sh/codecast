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
// drawn in place as the ledger's cards (org-staffing.md S39): one card per
// subject, the sentence, the fields with what was there before, and the
// person's answer. An answer fires nothing; it collects in the proposal's
// batch (the author's thread, so an answer given here and one given in that
// conversation are the same batch) and one send applies the approvals and
// tells the agent in words.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, milestoneCounts, nextMilestone } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type PlanItem, type ProjectItem } from "../../store/inboxStore";
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
import { proposalAnswersOf } from "../../lib/reviewActions";
import { useCardAnswer, useProposalBatch } from "../org/ProposalLedger";
import { ProposalReplyBox, proposalBatchKey, type ProposalThreadKey } from "../org/ProposalReplyBox";
import { Face, LEDGER_INKS, ProposalSubjectCard } from "../org/ProposalSubjectCard";
import { RoleFace } from "../org/RoleFace";
import { GhostTag } from "../org/ghostChrome";
import { CHIP_STATUS, GHOST } from "../org/orgMeta";
import { joinProposals, type OrgProposalChange, type OrgProposalRow } from "../org/orgStaffingTypes";
import { proposalSubjects, type SubjectCard, type SubjectLive } from "../org/proposalSubjects";
import { openProposals, proposalWorkspace, sameWorkspace } from "../org/staffingModel";
import { proposalThread } from "../org/staffingRevise";
import type { OrgTree } from "../org/orgTypes";
import { changeAnchor, companyDoc, flatGoals, goalAnchor, projectHref, proposalHref, tallyLine, type CompanyDoc, type CompanyProject, type DocChange, type DocGoal, type DocPerson, type DocProject, type DocRef, type DocRole } from "./companyModel";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const SERIF = { fontFamily: "var(--font-serif)" } as const;
const LINK = "no-underline hover:underline decoration-1 underline-offset-[3px]";
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.updated_at}|${p.priority ?? ""}|${p.goal ?? ""}`;
// A card's before reads a plan's name and status, nothing else.
const planSig = (p: PlanItem) => `${p.title}|${p.short_id}|${p.status}`;

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

type ProposalLink = Pick<OrgProposalRow, "_id" | "short_id" | "title">;

/** One open proposal on this page: its cards (proposalSubjects, one per
 *  subject), and where its answers collect. The key is the author's thread
 *  when it has one, so an answer given here and one given in that
 *  conversation are literally the same batch; a proposal with no agent to
 *  talk to collects under itself. */
export type DocLedger = { proposal: OrgProposalRow; cards: SubjectCard[]; batchKey: string; thread: ProposalThreadKey };
/** Every open proposal's ledger, and the card that holds each change, so a
 *  change the outline places is drawn as its card. */
export type DocLedgers = { byProposal: ReadonlyMap<string, DocLedger>; byChange: ReadonlyMap<string, SubjectCard> };
const NO_LEDGERS: DocLedgers = { byProposal: new Map(), byChange: new Map() };

export function docLedgers(open: readonly OrgProposalRow[], live: SubjectLive | null, tree: OrgTree | null): DocLedgers {
  const byProposal = new Map<string, DocLedger>();
  const byChange = new Map<string, SubjectCard>();
  for (const proposal of open) {
    const cards = proposalSubjects(proposal.changes, live);
    const thread = proposalThread(proposal, tree);
    const key: ProposalThreadKey = thread ? { conversation_id: thread.conversationId } : null;
    byProposal.set(proposal._id, { proposal, cards, batchKey: proposalBatchKey(proposal._id, key), thread: key });
    for (const card of cards) for (const id of card.change_ids) byChange.set(id, card);
  }
  return { byProposal, byChange };
}

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
  const plans = useWorkspaceCollection<PlanItem>("plans", planSig);
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
  // What a card's before is read from: the same records the document already
  // holds. Not useSubjectLive: that mounts the full tree feeder (sessions and
  // live state), which nothing on this page draws. A task a change names
  // reads by its ref (the board's rows carry no title).
  const live = useMemo<SubjectLive | null>(() => (tree ? { tree, goals: initiatives, projects, plans, tasks: NO_TASKS } : null), [tree, initiatives, projects, plans]);
  const ledgers = useMemo(() => (open.length ? docLedgers(open, live, tree) : NO_LEDGERS), [open, live, tree]);

  return (
    <>
      {open.map((p) => <ProposalFeed key={p._id} shortId={p.short_id} />)}
      <CompanyDocumentView doc={doc} now={now} proposals={doc.waiting > 0 ? open : NO_PROPOSALS} ledgers={ledgers} />
    </>
  );
}
const NO_PROPOSALS: ProposalLink[] = [];
const NO_TASKS: SubjectLive["tasks"] = [];

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

export function CompanyDocumentView({ doc, now, proposals, ledgers = NO_LEDGERS }: { doc: CompanyDoc; now: number; proposals: readonly ProposalLink[]; ledgers?: DocLedgers }) {
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
                  // A purpose a proposal sets reads in the proposal's colour while it waits, with the one word that says so.
                  <p key={i} style={p.status && p.status !== "accepted" ? { color: GHOST.color } : undefined} data-company-purpose-line={p.status ?? "written"}>
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
            ) : doc.goals.map((g) => <Goal key={g.id} goal={g} now={now} narrow={narrow} ledgers={ledgers} />)}
          </Section>

          {/* Only when something is loose: a section that says "none" reads as a problem to solve. */}
          {showUnfiled && (
            <Section id="projects" title="Projects not under a goal" count={doc.unfiled.length} delay={2}>
              {doc.unfiled.length === 0 ? <Quiet>No projects yet.</Quiet> : <ProjectList projects={doc.unfiled} now={now} narrow={narrow} />}
            </Section>
          )}

          <Section id="people" title="People and roles" count={doc.tally.people + doc.tally.roles} delay={3}>
            <Changes changes={doc.staffing} ledgers={ledgers} className="mt-3" data-company-staffing={doc.staffing.length} />
            {doc.roles.map((r) => <Role key={r.role._id} entry={r} ledgers={ledgers} />)}
            {doc.people.map((p) => <Person key={p.id} person={p} />)}
            {doc.roles.length + doc.people.length + doc.staffing.length === 0 && <Quiet>Nobody here yet.</Quiet>}
          </Section>

          {ledgers.byProposal.size > 0 && <Replies ledgers={ledgers} />}
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

function Goal({ goal, now, narrow, ledgers }: { goal: DocGoal; now: number; narrow: boolean; ledgers: DocLedgers }) {
  const top = goal.depth === 1;
  const refs = goal.refs.map((r, i) => (
    <span key={r.project.id}>{i > 0 && ", "}<Link href={projectHref(r.project.id)} className={LINK} style={{ color: "var(--sol-text-muted)" }} title={`Listed under ${r.under}`}>{r.project.title}</Link></span>
  ));
  const nearest = `listed under the ${goal.refs.length === 1 ? "goal" : "goals"} nearest the work.`;
  // The heading above is the subject, so each card says "this goal": the one
  // that sets the goal and every other change on it are one card.
  const changes = goal.proposed ? [goal.proposed, ...goal.changes] : goal.changes;
  return (
    <section id={goalAnchor(goal.id)} className={cn("scroll-mt-6", top ? "mt-9 first-of-type:mt-5" : "mt-5")} data-company-goal={goal.short_id ?? goal.id} data-company-depth={goal.depth} data-company-goal-kind={goal.row ? "live" : goal.proposed ? "proposed" : "unknown"}>
      {goal.row ? <LiveGoalHead goal={goal} now={now} narrow={narrow} /> : <ProposedGoalHead goal={goal} />}
      <Changes changes={changes} ledgers={ledgers} titled className="mt-2.5" data-company-goal-changes={changes.length} />
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
          {goal.goals.map((g) => <Goal key={g.id} goal={g} now={now} narrow={narrow} ledgers={ledgers} />)}
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
    <div className={cn("max-w-[66ch] space-y-1.5", className)} style={{ color: "var(--sol-text-secondary)" }} data-company-words>
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

/** A goal a proposal sets, where it would sit: its name as the heading,
 *  opening the proposal that sets it, in the proposal's colour while it
 *  waits. What the change writes (its owner, its measures, its words) is the
 *  card under the heading. A goal a change names that nothing answers to is
 *  said as a warning. */
function ProposedGoalHead({ goal }: { goal: DocGoal }) {
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
    <Heading className={headingClass(goal.depth)} style={{ ...SERIF, color: waiting ? `color-mix(in srgb, ${CHIP_STATUS[row.status].color} 42%, var(--sol-text))` : "var(--sol-text)" }} data-company-goal-title data-company-goal-ghost={row.change_id}>
      <Name href={change.hrefs.proposal}>{goal.title}</Name>
    </Heading>
  );
}

// ---------------------------------------------------------------- changes

/** The cards that hold these changes, each once, in the order the outline
 *  meets them. `titled`: the heading above names the subject, so a card says
 *  "this goal", "this role"; a card that stands alone names it. */
function Changes({ changes, ledgers, titled, className, ...rest }: { changes: readonly DocChange[]; ledgers: DocLedgers; titled?: boolean; className?: string } & Record<`data-${string}`, number | string | undefined>) {
  const seen = new Set<string>();
  const cards: { card: SubjectCard; ledger: DocLedger }[] = [];
  for (const c of changes) {
    const card = ledgers.byChange.get(c.row.change_id);
    const ledger = card && ledgers.byProposal.get(card.proposal_id);
    const key = card && `${card.proposal_id}:${card.key}`;
    if (!card || !ledger || !key || seen.has(key)) continue;
    seen.add(key);
    cards.push({ card, ledger });
  }
  if (cards.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)} {...rest}>
      {cards.map(({ card, ledger }) => <Change key={card.key} card={card} ledger={ledger} titled={titled} />)}
    </div>
  );
}

/** One card in the document, with its answer read from and written to the
 *  proposal's batch. A thin rule in the proposal's colour marks it as the
 *  proposal's, not the record's; the card sizes itself by the column it sits
 *  in. Its place on the page is the lead change's anchor, where a name the
 *  proposal creates (a role to hire) links to. */
function Change({ card, ledger, titled }: { card: SubjectCard; ledger: DocLedger; titled?: boolean }) {
  const { proposal, cards, batchKey } = ledger;
  const batch = useProposalBatch(proposal, batchKey);
  const { answer, onAnswer } = useCardAnswer(proposal, batch.key, batch.comments, card, cards.indexOf(card) + 1);
  const lead = card.changes[0] ?? card.riders[0] ?? card.carried[0];
  return (
    <div id={lead ? changeAnchor(lead._id) : undefined} className="scroll-mt-6 border-l-2 pl-3.5" style={{ borderColor: `color-mix(in srgb, ${GHOST.color} 45%, transparent)` }}>
      <ProposalSubjectCard card={card} answer={answer} onAnswer={proposal.status === "open" ? onAnswer : undefined} sentence={titled ? "this" : "named"} />
    </div>
  );
}

/** Where the answers go: one reply box per open proposal, at the foot of the
 *  document. Once any answer is pending the foot sticks to the bottom of the
 *  scroller, so Send stays in reach while the person answers down the
 *  outline; a box with nothing pending draws its one line hint, or nothing. */
function Replies({ ledgers }: { ledgers: DocLedgers }) {
  const list = [...ledgers.byProposal.values()];
  const pending = useInboxStore((s) => list.some((l) => proposalAnswersOf(s.reviewComments[l.batchKey], l.proposal._id).length > 0));
  return (
    <div className={cn("mt-10 space-y-3", pending && "sticky bottom-0 bg-[var(--sol-bg)]", LEDGER_INKS)} data-company-replies={pending ? "pending" : "quiet"}>
      {list.map((l) => <ProposalReplyBox key={l.proposal._id} proposal={l.proposal} changes={l.proposal.changes} batchKey={l.batchKey} thread={l.thread} />)}
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

function Role({ entry, ledgers }: { entry: DocRole; ledgers: DocLedgers }) {
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
        <Changes changes={entry.changes} ledgers={ledgers} titled className="mt-2" />
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
