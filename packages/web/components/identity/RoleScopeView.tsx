// What a role looks after, at two sizes (docs/architecture/org-roles-run-work.md
// R3): `card` is the scope section of the role hover card, `page` is the role
// page's first tab. One component, so the hover and the page can never say
// different things about the same role. It paints a RoleScopeModel
// (lib/roleScope) and reads nothing itself; useRoleScope builds the model from
// the store.
//
// The card is one link (a click anywhere opens the role), so nothing inside it
// is a link or opens a card of its own. The page's rows are links, its roles
// carry their own hover, and the page hands in the two pieces only it can
// afford: the project lead chip and the sessions grouped by who acts next.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { planStateLine, projectStateLine, sessionsLine, type RoleScopeModel, type RoleScopeParty, type ScopePlan, type ScopeProject } from "../../lib/roleScope";
import type { EscalatedSession } from "../../hooks/useRoleScope";
import type { OrgSession } from "../org/orgTypes";
import { RoleFace } from "../org/RoleFace";
import { AssigneeFace } from "./AssigneeFace";
import { RoleHoverCard } from "./RoleHoverCard";

export type RoleScopeDensity = "card" | "page";
export type RoleScopeTab = "sessions" | "charter" | "tasks" | "plans";

/** How many rows the card shows before it says how many more there are. */
const CARD_PROJECTS = 4;
const CARD_PLANS = 3;

export type RoleScopeViewProps = {
  model: RoleScopeModel;
  density: RoleScopeDensity;
  /** Sessions the role has put in front of the person (R1): first, always. */
  escalated?: EscalatedSession[];
  /** Page only: a project's lead, drawn by the one chip that knows the rule. */
  renderLead?: (projectId: string) => ReactNode;
  /** Page only: the role's sessions grouped by who acts next. */
  sessions?: ReactNode;
  onTab?: (tab: RoleScopeTab) => void;
  onOpenSession?: (s: OrgSession) => void;
  className?: string;
};

export function RoleScopeView({ model, density, escalated = [], renderLead, sessions, onTab, onOpenSession, className }: RoleScopeViewProps) {
  const card = density === "card";
  const projects = card ? model.projects.slice(0, CARD_PROJECTS) : model.projects;
  const plans = card ? model.plans.slice(0, CARD_PLANS) : model.plans;
  const hidden = model.projects.length - projects.length + (model.plans.length - plans.length);
  const nothing = model.projects.length === 0 && model.plans.length === 0;

  return (
    <div className={cn(card ? "grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[11px] leading-snug" : "space-y-5", className)} data-role-scope={density}>
      <Section density={density} label="Looks after" name="looks-after">
        {model.whole && <p className={card ? "text-sol-text-secondary" : "px-2.5 pb-1 text-[12px] text-sol-text-muted"} data-scope-whole>The whole workspace{model.projects.length > 0 ? `: ${model.projects.length} ${model.projects.length === 1 ? "project" : "projects"}` : ""}.</p>}
        {nothing && !model.whole && <p className={card ? "text-sol-text-dim" : "px-2.5 text-[12px] text-sol-text-dim"}>Nothing yet. Add a project or a plan in Settings.</p>}
        <ul className={card ? "space-y-0.5" : "space-y-0.5"}>
          {projects.map((p) => <li key={p.id}>{card ? <ProjectLine p={p} /> : <ProjectRow p={p} lead={renderLead?.(p.id)} />}</li>)}
          {plans.map((p) => <li key={p.id}>{card ? <PlanLine p={p} /> : <PlanRow p={p} />}</li>)}
        </ul>
        {hidden > 0 && <p className="text-sol-text-dim" data-scope-more={hidden}>and {hidden} more</p>}
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
          {model.sessions && <p className={card ? "text-sol-text-secondary" : "px-2.5 pb-1.5 text-[12px] text-sol-text-muted"} data-scope-sessions-line>{sessionsLine(model.sessions)}</p>}
          {!card && sessions}
          {!card && model.sessions && model.sessions.total > 0 && <More onClick={() => onTab?.("sessions")}>All {model.sessions.total} {model.sessions.total === 1 ? "session" : "sessions"}</More>}
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

// ------------------------------------------------------------------ the card's lines

const leadWord = <span className="text-sol-violet font-medium">lead</span>;

function ProjectLine({ p }: { p: ScopeProject }) {
  const state = projectStateLine({ ...p, leads: false });
  return (
    <p className="truncate" data-scope-project={p.ref} data-scope-leads={p.leads ? "" : undefined}>
      <span className="text-sol-text font-medium">{p.title}</span>
      <span className="text-sol-text-dim"> · {state}</span>
      {p.leads && <span className="text-sol-text-dim"> · {leadWord}</span>}
    </p>
  );
}

function PlanLine({ p }: { p: ScopePlan }) {
  return (
    <p className="truncate" data-scope-plan={p.ref}>
      <span className="text-sol-text">{p.title}</span>
      <span className="text-sol-text-dim"> · {planStateLine(p)}</span>
    </p>
  );
}

// ------------------------------------------------------------------ the page's rows

const ROW = "group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70";

function ProjectRow({ p, lead }: { p: ScopeProject; lead?: ReactNode }) {
  return (
    <div className={ROW} data-scope-project={p.ref} data-scope-leads={p.leads ? "" : undefined}>
      <span className={cn("w-[3px] self-stretch rounded-full shrink-0", p.leads ? "bg-sol-violet" : "bg-sol-border/60")} />
      <Link href={`/projects/${p.ref}`} className="min-w-0 flex-1 no-underline">
        <span className="block truncate text-[13px] font-medium text-sol-text group-hover:underline underline-offset-2">{p.title}</span>
        <span className="block truncate text-[11px] mt-[1px] text-sol-text-dim">{projectStateLine({ ...p, leads: false })}</span>
      </Link>
      {/* The chip names whoever leads, this role or another; the word stands in until it has the rows. */}
      {lead ?? (p.leads ? <span className="shrink-0 text-[11px]">{leadWord}</span> : null)}
    </div>
  );
}

function PlanRow({ p }: { p: ScopePlan }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <Link href={`/plans/${p.ref}`} className={cn(ROW, "no-underline")} data-scope-plan={p.ref}>
      <span className="w-[3px] self-stretch rounded-full shrink-0 bg-sol-magenta/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-sol-text group-hover:underline underline-offset-2">{p.title}</span>
        <span className="block truncate text-[11px] mt-[1px] text-sol-text-dim"><span className="font-mono">{p.ref}</span> · {planStateLine(p)}</span>
      </span>
      {p.total > 0 && (
        <span className="w-16 h-1 rounded-full overflow-hidden shrink-0 bg-sol-border/30" aria-hidden>
          <span className="block h-full bg-sol-green" style={{ width: `${pct}%` }} />
        </span>
      )}
    </Link>
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
