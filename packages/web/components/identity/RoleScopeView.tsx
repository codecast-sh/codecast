// What a role looks after, at two sizes (docs/architecture/org-roles-run-work.md
// R3; initiatives-projects-role-page.md I2). Projects come first and are the
// unit: one card each, with the project's lead, the initiative it belongs to,
// its open and done tasks, the plans inside it and the sessions at work in it.
// A plan never sits beside its project; plans in no project share one last
// card that offers the gesture that files them. `card` is the scope section of the role hover card, `page` is the role
// page's first tab. One component, so the hover and the page can never say
// different things about the same role. It paints a RoleScopeModel
// (lib/roleScope) and reads nothing itself; useRoleScope builds the model from
// the store.
//
// The card is one link (a click anywhere opens the role), so nothing inside it
// is a link or opens a card of its own. The page's rows are links, its roles
// carry their own hover, and the page hands in the pieces only it can afford:
// the project lead chip, the initiative pill, the sessions grouped by who acts
// next, and the write that files a plan under a project.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, FolderInput } from "lucide-react";
import { cn } from "../../lib/utils";
import { groupsLine, planStateLine, projectStateLine, sessionsLine, type RoleScopeModel, type RoleScopeParty, type ScopePlan, type ScopeProject } from "../../lib/roleScope";
import { INITIATIVE_HEALTH_LABEL } from "@codecast/shared/contracts/initiative";
import type { RoleInitiative } from "../../lib/roleInitiatives";
import { HEALTH_COLOR } from "../initiatives/InitiativeAtoms";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { EscalatedSession } from "../../hooks/useRoleScope";
import type { OrgSession } from "../org/orgTypes";
import { RoleFace } from "../org/RoleFace";
import { AssigneeFace } from "./AssigneeFace";
import { RoleHoverCard } from "./RoleHoverCard";

export type RoleScopeDensity = "card" | "page";
export type RoleScopeTab = "sessions" | "charter" | "tasks" | "plans";

/** How many rows the card shows before it says how many more there are. */
const CARD_PROJECTS = 3;
const CARD_PLANS = 2;

export type RoleScopeViewProps = {
  model: RoleScopeModel;
  density: RoleScopeDensity;
  /** Sessions the role has put in front of the person (R1): first, always. */
  escalated?: EscalatedSession[];
  /** Page only: a project's lead, drawn by the one chip that knows the rule. */
  renderLead?: (projectId: string) => ReactNode;
  /** Page only: the initiatives a project belongs to (I1), as their pills. */
  renderInitiative?: (projectId: string) => ReactNode;
  /** Page only: file a plan that sits in no project under one (the last card's one gesture). */
  onFilePlan?: (planRef: string, projectId: string) => void;
  /** Page only: the role's sessions grouped by who acts next. */
  sessions?: ReactNode;
  /** Page only: sessions waiting on a person anywhere in the role's area (the
   *  ones bound to its tasks and plans too), when that is more than the
   *  sessions that report to it. The page header says this number; the
   *  section must never say less. */
  waitingInArea?: number;
  onTab?: (tab: RoleScopeTab) => void;
  onOpenSession?: (s: OrgSession) => void;
  className?: string;
};

export function RoleScopeView({ model, density, escalated = [], renderLead, renderInitiative, onFilePlan, sessions, waitingInArea = 0, onTab, onOpenSession, className }: RoleScopeViewProps) {
  const moreWaiting = !(density === "card") && waitingInArea > (model.sessions?.waiting ?? 0);
  const card = density === "card";
  const projects = card ? model.projects.slice(0, CARD_PROJECTS) : model.projects;
  const hidden = model.projects.length - projects.length;
  const nothing = model.projects.length === 0 && model.loosePlans.length === 0;
  const fileTargets = model.projects.filter((p) => !p.partial);

  return (
    <div className={cn(card ? "grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[11px] leading-snug" : "space-y-5", className)} data-role-scope={density}>
      {model.initiatives.length > 0 && (
        <Section density={density} label="Initiatives" name="initiatives">
          <ul className={card ? "space-y-0.5" : "space-y-0.5"}>
            {model.initiatives.map((i) => <li key={i.id}><InitiativeRowView i={i} density={density} /></li>)}
          </ul>
        </Section>
      )}

      <Section density={density} label="Projects" name="projects">
        {model.whole && <p className={card ? "text-sol-text-secondary" : "px-2.5 pb-1 text-[12px] text-sol-text-muted"} data-scope-whole>The whole workspace{model.projects.length > 0 ? `: ${model.projects.length} ${model.projects.length === 1 ? "project" : "projects"}` : ""}.</p>}
        {nothing && !model.whole && <p className={card ? "text-sol-text-dim" : "px-2.5 text-[12px] text-sol-text-dim"}>No project yet. Add one in Settings.</p>}
        <ul className={card ? "space-y-1.5" : "space-y-2"}>
          {projects.map((p) => <li key={p.id}>{card ? <ProjectBlock p={p} /> : <ProjectCard p={p} lead={renderLead?.(p.id)} initiative={renderInitiative?.(p.id)} />}</li>)}
          {model.loosePlans.length > 0 && <li>{card ? <LooseBlock plans={model.loosePlans} /> : <LooseCard plans={model.loosePlans} targets={fileTargets} onFile={onFilePlan} />}</li>}
        </ul>
        {hidden > 0 && <p className="text-sol-text-dim" data-scope-more={hidden}>and {hidden} more {hidden === 1 ? "project" : "projects"}</p>}
      </Section>

      {(model.sessions || escalated.length > 0) && (
        <Section density={density} label="Sessions" name="sessions">
          {escalated.length > 0 && (card ? (
            <p className="text-sol-yellow" data-scope-escalated={escalated.length}>{escalated.length} in front of you: {escalated[0].line}</p>
          ) : (
            <ul className="space-y-0.5 pb-1" data-scope-escalated={escalated.length}>
              {escalated.map(({ session, line }) => (
                <li key={session._id}>
                  <button type="button" onClick={() => onOpenSession?.(session)} className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70">
                    <span className="w-[3px] self-stretch rounded-full shrink-0 bg-sol-yellow" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-sol-text">{session.title || "Untitled"}</span>
                      <span className="block text-[11.5px] text-sol-yellow">In front of you: {line}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
          {moreWaiting && <p className="px-2.5 pb-1 text-[12px] text-sol-yellow" data-scope-waiting-in-area={waitingInArea}>{waitingInArea} {waitingInArea === 1 ? "session is" : "sessions are"} waiting on a person in this area.</p>}
          {model.sessions && !(moreWaiting && model.sessions.total === 0) && <p className={card ? "text-sol-text-secondary" : "px-2.5 pb-1.5 text-[12px] text-sol-text-muted"} data-scope-sessions-line>{model.sessions.total === 0 ? "No session reports to this role yet." : card ? sessionsLine(model.sessions) : `Reporting to it: ${sessionsLine(model.sessions)}`}</p>}
          {!card && sessions}
          {!card && model.sessions && (model.sessions.total > 0 || moreWaiting) && <More onClick={() => onTab?.("sessions")}>{model.sessions.total > 0 ? `All ${model.sessions.total} ${model.sessions.total === 1 ? "session" : "sessions"}` : "See the sessions in this area"}</More>}
        </Section>
      )}

      <Section density={density} label="Its job" name="charter">
        {model.charter.paragraph
          ? <p className={card ? "text-sol-text-secondary line-clamp-3" : "px-2.5 text-[13px] leading-relaxed text-sol-text-secondary"} data-scope-charter>{card ? model.charter.sentence : model.charter.paragraph}</p>
          : <p className={card ? "text-sol-text-dim italic" : "px-2.5 text-[12px] text-sol-text-dim italic"} data-scope-charter="">No charter written yet.</p>}
        {!card && <More onClick={() => onTab?.("charter")}>{model.charter.paragraph ? "Read the whole charter" : "Write the charter"}</More>}
      </Section>

      {model.reportsTo && (
        <Section density={density} label="Reports to" name="reports-to">
          <div className={card ? "" : "px-2.5"}><Party party={model.reportsTo} density={density} /></div>
        </Section>
      )}

      {model.reports.length > 0 && (
        <Section density={density} label="Under it" name="reports">
          <div className={cn("flex flex-wrap", card ? "gap-x-2.5 gap-y-1" : "gap-x-4 gap-y-1.5 px-2.5")}>
            {model.reports.map((r) => <Party key={r.kind === "role" ? r.short_id : r.name} party={r} density={density} />)}
          </div>
        </Section>
      )}

      {model.owned.byStatus.length > 0 && (
        <Section density={density} label="Owns" name="owns">
          {card ? (
            <p className="text-sol-text-secondary" data-scope-owned={model.owned.open}>{model.owned.open} open {model.owned.open === 1 ? "task" : "tasks"}{model.owned.byStatus.length > 0 ? `: ${model.owned.byStatus.filter((s) => s.status !== "done").map((s) => `${s.count} ${s.label}`).join(", ")}` : ""}</p>
          ) : (
            <div className="px-2.5 flex flex-wrap gap-1.5" data-scope-owned={model.owned.open}>
              {model.owned.byStatus.map((s) => (
                <button key={s.status} type="button" onClick={() => onTab?.("tasks")} className="inline-flex items-center gap-1.5 h-[24px] px-2 rounded-md border border-sol-border/40 text-[11.5px] text-sol-text-muted transition-colors hover:bg-sol-bg-highlight/70" data-scope-owned-status={s.status}>
                  <span className="tabular-nums font-semibold text-sol-text">{s.count}</span>{s.label}
                </button>
              ))}
            </div>
          )}
        </Section>
      )}

      {model.limit && (
        <Section density={density} label="Daily limit" name="limit">
          <p className={card ? "text-sol-text-secondary" : "px-2.5 text-[12px] text-sol-text-muted"} data-scope-limit>{model.limit}</p>
        </Section>
      )}
    </div>
  );
}

/** A label and its value: beside each other on the card, stacked on the page. */
function Section({ density, label, name, children }: { density: RoleScopeDensity; label: string; name: string; children: ReactNode }) {
  if (density === "card") {
    return (
      <>
        <div className="text-[10px] uppercase tracking-[0.06em] text-sol-text-dim pt-px" data-scope-label={name}>{label}</div>
        <div className="min-w-0 space-y-0.5" data-scope-section={name}>{children}</div>
      </>
    );
  }
  return (
    <section data-scope-section={name}>
      <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-sol-text-dim" data-scope-label={name}>{label}</h3>
      {children}
    </section>
  );
}

function More({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="mt-1 mx-2.5 inline-flex items-center gap-1 text-[11.5px] text-sol-violet hover:underline underline-offset-2">
      {children} <ArrowRight className="w-3 h-3" />
    </button>
  );
}

/** A goal the role's work serves: whether the role drives it or its projects
 *  contribute, and what its owner last said about how it is going. */
function InitiativeRowView({ i, density }: { i: RoleInitiative; density: RoleScopeDensity }) {
  const part = i.owned ? "drives it" : `through ${i.projects} ${i.projects === 1 ? "project" : "projects"}`;
  const health = i.health !== "none" ? <span style={{ color: HEALTH_COLOR[i.health] }}>{INITIATIVE_HEALTH_LABEL[i.health].toLowerCase()}</span> : null;
  if (density === "card") {
    return (
      <p className="truncate" data-scope-initiative={i.ref}>
        <span className="text-sol-text font-medium">{i.title}</span>
        {health && <span className="text-sol-text-dim"> · {health}</span>}
        <span className="text-sol-text-dim"> · {i.owned ? <span className="text-sol-violet font-medium">{part}</span> : part}</span>
      </p>
    );
  }
  return (
    <Link href={`/initiatives/${i.ref}`} className="group flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg no-underline transition-colors hover:bg-sol-bg-highlight/70" data-scope-initiative={i.ref}>
      <span className="w-[3px] self-stretch rounded-full shrink-0 bg-sol-magenta/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-sol-text group-hover:underline underline-offset-2">{i.title}</span>
        <span className="block truncate text-[11px] text-sol-text-dim"><span className="font-mono">{i.ref}</span>{health && <> · {health}</>} · {i.owned ? <span className="text-sol-violet font-medium">{part}</span> : part}</span>
      </span>
    </Link>
  );
}

// ------------------------------------------------------------------ the card's blocks

const leadWord = <span className="text-sol-violet font-medium">lead</span>;

/** A project on the hover card: its name, its state, and its plans under it. */
function ProjectBlock({ p }: { p: ScopeProject }) {
  const plans = p.plans.slice(0, CARD_PLANS);
  const more = p.plans.length - plans.length;
  return (
    <div data-scope-project={p.ref} data-scope-leads={p.leads ? "" : undefined}>
      <p className="truncate" data-scope-project-line>
        <span className="text-sol-text font-medium">{p.title}</span>
        <span className="text-sol-text-dim"> · {projectStateLine(p)}</span>
        {p.leads && <span className="text-sol-text-dim"> · {leadWord}</span>}
      </p>
      {p.sessions.length > 0 && <p className="truncate text-sol-text-muted" data-scope-project-sessions>{groupsLine(p.sessions)}</p>}
      {plans.length > 0 && (
        <ul className="mt-0.5 pl-2 border-l border-sol-border/40">
          {plans.map((pl) => <li key={pl.id}><PlanLine p={pl} /></li>)}
          {more > 0 && <li className="text-sol-text-dim">and {more} more {more === 1 ? "plan" : "plans"}</li>}
        </ul>
      )}
    </div>
  );
}

function LooseBlock({ plans }: { plans: ScopePlan[] }) {
  const shown = plans.slice(0, CARD_PLANS);
  return (
    <div data-scope-loose={plans.length}>
      <p className="text-sol-text-dim">Not in a project</p>
      <ul className="mt-0.5 pl-2 border-l border-sol-border/40">
        {shown.map((pl) => <li key={pl.id}><PlanLine p={pl} /></li>)}
        {plans.length > shown.length && <li className="text-sol-text-dim">and {plans.length - shown.length} more</li>}
      </ul>
    </div>
  );
}

function PlanLine({ p }: { p: ScopePlan }) {
  return (
    <p className="truncate" data-scope-plan={p.ref}>
      <span className="text-sol-text-secondary">{p.title}</span>
      <span className="text-sol-text-dim"> · {planStateLine(p)}</span>
    </p>
  );
}

// ------------------------------------------------------------------ the page's cards

const CARD = "rounded-xl border border-sol-border/40 bg-sol-card overflow-hidden";
const STATUS_TONE: Record<string, string> = { active: "var(--sol-green)", paused: "var(--sol-yellow)", done: "var(--sol-cyan)", archived: "var(--sol-text-dim)" };

function Bar({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span className={cn("h-1 rounded-full overflow-hidden shrink-0 bg-sol-border/30", className)} aria-hidden>
      <span className="block h-full bg-sol-green" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** A project as a card: its lead, the initiatives it belongs to, its open and
 *  done tasks, the plans inside it and the sessions at work in it. The role
 *  page draws one for each project in a scope, and the initiative page one for
 *  each project of an initiative, from the same rows (lib/roleScope). */
export function ProjectCard({ p, lead, initiative }: { p: ScopeProject; lead?: ReactNode; initiative?: ReactNode }) {
  const tone = STATUS_TONE[p.status ?? ""] ?? "var(--sol-text-dim)";
  return (
    <article className={CARD} data-scope-project={p.ref} data-scope-leads={p.leads ? "" : undefined} data-scope-partial={p.partial ? "" : undefined}>
      <header className="flex items-center gap-2 pl-3 pr-2.5 pt-2.5">
        <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: tone }} title={p.status ?? undefined} />
        <Link href={`/projects/${p.ref}`} className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-tight text-sol-text no-underline hover:underline underline-offset-2">{p.title}</Link>
        {p.status && p.status !== "active" && <span className="shrink-0 text-[10.5px]" style={{ color: tone }} data-scope-project-status>{p.status}</span>}
        {/* The chip names whoever leads, this role or another; the word stands in until it has the rows. */}
        {lead ?? (p.leads ? <span className="shrink-0 text-[11px]">{leadWord}</span> : null)}
      </header>
      {/* The pill component renders nothing for a project in no initiative, so the row folds away with it. */}
      {initiative && <div className="pl-3 pr-2.5 pt-1.5 flex flex-wrap gap-1 empty:hidden" data-scope-project-initiative>{initiative}</div>}
      <div className="pl-3 pr-2.5 pt-1.5 pb-2.5 flex items-center gap-2.5 text-[11.5px] text-sol-text-muted">
        <span data-scope-project-line>{projectStateLine({ ...p, status: null })}</span>
        {p.open + p.done > 0 && <Bar done={p.done} total={p.open + p.done} className="w-16" />}
        {p.sessions.length > 0 && <span className="min-w-0 truncate text-sol-text-dim" data-scope-project-sessions>{groupsLine(p.sessions)}</span>}
      </div>
      {p.partial && <p className="px-3 pb-2 -mt-1 text-[11px] text-sol-text-dim">Only the plans below are in this role's scope.</p>}
      {p.plans.length > 0 && (
        <ul className="border-t border-sol-border/30 py-1">
          {p.plans.map((pl) => <li key={pl.id}><PlanRow p={pl} /></li>)}
        </ul>
      )}
    </article>
  );
}

function PlanRow({ p, after }: { p: ScopePlan; after?: ReactNode }) {
  return (
    <div className="group flex items-center gap-2.5 pl-3 pr-2.5 py-1.5 transition-colors hover:bg-sol-bg-highlight/60" data-scope-plan={p.ref}>
      <Link href={`/plans/${p.ref}`} className="min-w-0 flex-1 no-underline">
        <span className="block truncate text-[12.5px] text-sol-text group-hover:underline underline-offset-2">{p.title}</span>
        <span className="block truncate text-[10.5px] text-sol-text-dim"><span className="font-mono">{p.ref}</span> · {planStateLine(p)}</span>
      </Link>
      {p.total > 0 && <Bar done={p.done} total={p.total} className="w-12" />}
      {after}
    </div>
  );
}

/** Plans the scope names that sit in no project, and the one gesture that files each. */
function LooseCard({ plans, targets, onFile }: { plans: ScopePlan[]; targets: ScopeProject[]; onFile?: (planRef: string, projectId: string) => void }) {
  return (
    <article className={cn(CARD, "border-dashed")} data-scope-loose={plans.length}>
      <header className="pl-3 pr-2.5 pt-2.5 pb-1.5">
        <h4 className="text-[13px] font-semibold text-sol-text-muted">Not in a project</h4>
        <p className="text-[11px] text-sol-text-dim">{plans.length === 1 ? "This plan belongs" : "These plans belong"} to no project yet, so no project counts {plans.length === 1 ? "its" : "their"} work.</p>
      </header>
      <ul className="border-t border-sol-border/30 py-1">
        {plans.map((pl) => (
          <li key={pl.id}>
            <PlanRow p={pl} after={onFile && targets.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="shrink-0 inline-flex items-center gap-1 h-[22px] px-1.5 rounded-md border border-sol-border/40 text-[11px] text-sol-text-muted transition-colors hover:bg-sol-bg-highlight/70" data-scope-file-plan={pl.ref}>
                    <FolderInput className="w-3 h-3" /> File under a project
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">File {pl.ref} under</DropdownMenuLabel>
                  {targets.map((t) => <DropdownMenuItem key={t.id} className="text-xs" onSelect={() => onFile(pl.ref, t.id)} data-scope-file-target={t.ref}>{t.title}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** A person or a role, by face and name. On the page a role opens its own
 *  card and its own page; on the card it is words, because the card is
 *  already one link and a card never opens a card. */
function Party({ party, density }: { party: RoleScopeParty; density: RoleScopeDensity }) {
  const size = density === "card" ? 14 : 18;
  if (party.kind === "user") {
    return <span className="inline-flex items-center gap-1.5 min-w-0 text-sol-text-secondary" data-scope-party="user"><AssigneeFace info={{ name: party.name, image: party.image }} size={size} /><span className="truncate">{party.name}</span></span>;
  }
  const body = (
    <span className="inline-flex items-center gap-1.5 min-w-0" data-scope-party={party.short_id}>
      <RoleFace role={party} size={size} className="shrink-0" />
      <span className="truncate text-sol-text-secondary">{party.name}</span>
      {party.handle && <span className="font-mono text-[10px] text-sol-text-dim shrink-0">@{party.handle}</span>}
    </span>
  );
  if (density === "card") return body;
  return (
    <RoleHoverCard role={party} side="top">
      <Link href={`/org/${party.short_id}`} className="no-underline hover:underline underline-offset-2">{body}</Link>
    </RoleHoverCard>
  );
}
