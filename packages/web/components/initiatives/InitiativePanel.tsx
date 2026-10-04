"use client";
// The right side of an initiative's page
// (docs/architecture/initiatives-projects-role-page.md I1 "The page", I5 "The
// test"), as two tabs in the scope panel's grammar. Goal is the record, read
// top to bottom in the order of the test: what we are trying to reach, the
// number now against its target, why it matters, what done looks like, the
// milestones, what is undecided, what was decided and who said it where; then
// the projects that carry it, what the owner said and when, and the goals
// under it. Activity is everything that moved in its projects and its sub
// goals', through the one feed a scope uses.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Activity, ChevronDown, Flag, FolderKanban, Pencil, Plus, X } from "lucide-react";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_METRICS_MAX, INITIATIVE_UPDATE_HEALTHS, initiativeChain, metricKeyOf, metricReadings, metricTrends, parseIntentSource, type InitiativeRow, type InitiativeUpdateHealth, type InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { undoAsOne } from "../../store/undoActions";
import { quoted } from "../../store/undo/labels";
import { useInitiativeProjects } from "../../hooks/useInitiativeProjects";
import { useInitiativeUpdates } from "../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { goalScopeInitiativeIds, goalScopeProjectIds, initiativeHref, newInitiativeKey, projectTrouble, subInitiatives } from "../../lib/initiatives";
import type { ScopeRef } from "../../hooks/useScopeQueries";
import { cn } from "../../lib/utils";
import { ProjectLeadChip } from "../charter/ProjectLeadChip";
import { FilterOptionList } from "../FilterDropdown";
import { ProjectCard } from "../identity/RoleScopeView";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { HealthChip, MetricTile, OwnerChip, SourceLink, StatusGlyph } from "./InitiativeAtoms";
import { EntityIdPill } from "../EntityIdPill";
import { ScopeFeed } from "../org/scope/ScopeFeed";
import { InitiativeRecord, RecordSection as Section } from "./InitiativeRecord";
import { IntentTabs, type IntentTab } from "./IntentHeader";
import { ProjectInitiatives } from "./ProjectInitiatives";

/** The panel's tabs; the first is the one the bare address opens on. */
export const INITIATIVE_TABS = ["goal", "activity"] as const;
export type InitiativeTab = (typeof INITIATIVE_TABS)[number];
const TABS: readonly IntentTab<InitiativeTab>[] = [{ key: "goal", label: "Goal", icon: Flag }, { key: "activity", label: "Activity", icon: Activity }];

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
/** A report's source is free text: an address opens, anything else is read as written. */
const metricSource = (text: string) => { const src = parseIntentSource(text); return src.kind === "note" ? null : src; };
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.target_date ?? ""}|${(p.risks ?? []).length}`;

export function InitiativePanel({ initiative, all, now, tab, onTab, onClose, closeLabel }: {
  initiative: InitiativeRow;
  all: InitiativeRow[];
  now: number;
  tab: InitiativeTab;
  onTab: (next: InitiativeTab) => void;
  /** Present when the panel sits beside a conversation and can be put away. */
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="initiative-panel-cq h-full flex flex-col min-h-0" data-initiative-panel={initiative.short_id || initiative._id} data-scope-tab-active={tab}>
      {/* The panel is a 360px column beside a conversation and a 760px page alone: two numbers sit side by side only where there is room. */}
      <style>{`.initiative-panel-cq { container-type: inline-size; } @container (min-width: 560px) { .initiative-metric-grid[data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`}</style>
      <IntentTabs
        tabs={TABS}
        active={tab}
        onTab={onTab}
        trailing={onClose && (
          <button type="button" onClick={onClose} className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label={closeLabel} title={closeLabel} data-initiative-panel-close>
            {closeLabel === "Back to the conversation" ? <ChevronDown className="w-4 h-4" /> : <X className="w-4 h-4" />}
          </button>
        )}
      />
      {tab === "activity" ? (
        <GoalActivity initiative={initiative} all={all} />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-7" data-initiative-scroll>
          <Description initiative={initiative} />
          <Metrics initiative={initiative} all={all} now={now} />
          <InitiativeRecord initiative={initiative} all={all} now={now} />
          <Projects initiative={initiative} now={now} />
          <Updates initiative={initiative} now={now} />
          <SubInitiatives rows={subInitiatives(all, initiative._id)} now={now} />
        </div>
      )}
    </div>
  );
}

/** Everything that moved under the goal: its projects and its sub goals',
 *  with the goals' own updates and the calls that name them. The scope feed
 *  is the engine; this only says which scope. */
function GoalActivity({ initiative, all }: { initiative: InitiativeRow; all: InitiativeRow[] }) {
  const projectIds = goalScopeProjectIds(initiative, all).join(",");
  const initiativeIds = goalScopeInitiativeIds(initiative, all).join(",");
  const scope = useMemo<ScopeRef>(() => ({
    scope: { project_ids: projectIds ? projectIds.split(",") : [], plan_ids: [], initiative_ids: initiativeIds ? initiativeIds.split(",") : [] },
    ...(initiative.team_id ? { team_id: initiative.team_id } : {}),
  }), [projectIds, initiativeIds, initiative.team_id]);
  return <ScopeFeed key={JSON.stringify(scope)} scope={scope} fill />;
}

function GhostButton({ icon: Icon, children, onClick, ...rest }: { icon: any; children: ReactNode; onClick?: () => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" onClick={onClick} className="h-6 inline-flex items-center gap-1 px-2 rounded-md text-[11.5px] font-medium hover:bg-sol-bg-highlight/70 transition-colors" style={{ color: "var(--sol-text-muted)" }} {...rest}>
      <Icon className="w-3 h-3" /> {children}
    </button>
  );
}

// ------------------------------------------------------------ description

/** Purpose, scope and context. Edited in place; the text moves on the page in
 *  the same tick and the write rides `updateInitiative`. */
function Description({ initiative }: { initiative: InitiativeRow }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== (initiative.description ?? "")) useInboxStore.getState().updateInitiative(initiative._id, { description: next || null });
    setDraft(null);
  };
  return (
    <Section name="description" label="What it is for" action={draft === null ? <GhostButton icon={Pencil} onClick={() => setDraft(initiative.description ?? "")} data-initiative-edit-description="">{initiative.description ? "Edit" : "Write"}</GhostButton> : undefined}>
      {draft !== null ? (
        <div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setDraft(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
            rows={6}
            placeholder="The purpose, what is in scope and what is not, and the context a newcomer needs."
            className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60"
            style={{ borderColor: HAIRLINE }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setDraft(null)} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="button" onClick={save} className="h-7 px-3 rounded-md text-[12px] font-medium" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}>Save</button>
          </div>
        </div>
      ) : initiative.description ? (
        <MarkdownRenderer content={initiative.description} className="text-[13px] leading-relaxed" />
      ) : (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>Nobody has said what this is for yet.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- metrics

/** How the goal is measured (I4): one or two numbers read against their
 *  targets, with the source and date of the last report, and the top level
 *  goal this one feeds. On track here means against the target; the owner's
 *  word stands beside it in the header so the two can disagree visibly. A
 *  role reports the value with `cast initiative report`. */
function Metrics({ initiative, all, now }: { initiative: InitiativeRow; all: InitiativeRow[]; now: number }) {
  const readings = metricReadings(initiative);
  const trends = metricTrends(initiative);
  const chain = useMemo(() => initiativeChain(initiative, (id) => all.find((r) => r._id === id)), [initiative, all]);
  const [draft, setDraft] = useState<Array<{ name: string; target: string }> | null>(null);
  const save = () => {
    if (draft === null) return;
    const metrics = draft.map((m) => ({ name: m.name.trim(), target: m.target.trim() })).filter((m) => m.name && m.target).map((m) => ({ key: metricKeyOf(m.name), name: m.name, target: m.target }));
    useInboxStore.getState().updateInitiative(initiative._id, { metrics });
    setDraft(null);
  };
  const empty = !readings.length && !chain.length;
  return (
    <Section name="metrics" label="Measured by" action={draft === null ? <GhostButton icon={Pencil} onClick={() => setDraft(readings.length ? readings.map((r) => ({ name: r.name, target: r.target })) : [{ name: "", target: "" }])} data-initiative-edit-metrics="">{readings.length ? "Edit" : "Add a number"}</GhostButton> : undefined}>
      {draft !== null ? (
        <div className="space-y-1.5" data-initiative-metrics-form>
          {draft.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input autoFocus={i === 0} value={m.name} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Weekly active teams" className="flex-1 min-w-0 h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60" style={{ borderColor: HAIRLINE }} aria-label="Metric name" />
              <input value={m.target} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setDraft(null); }} placeholder="target 1,000" className="w-[110px] h-7 rounded-md border bg-transparent px-2 text-[12.5px] tabular-nums outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60" style={{ borderColor: HAIRLINE }} aria-label="Target" />
              <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-dim)" }} aria-label="Remove this metric"><X className="w-3 h-3" /></button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            {draft.length < INITIATIVE_METRICS_MAX && <GhostButton icon={Plus} onClick={() => setDraft([...draft, { name: "", target: "" }])}>Another number</GhostButton>}
            <span className="flex-1" />
            <button type="button" onClick={() => setDraft(null)} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="button" onClick={save} className="h-7 px-3 rounded-md text-[12px] font-medium" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}>Save</button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>A target reads as a number to reach; write "under 5%" for one to stay below.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {readings.length > 0 && (
            <div className="initiative-metric-grid grid grid-cols-1 gap-2" data-count={readings.length}>
              {readings.map((r) => {
                const source = r.source ? metricSource(r.source) : null;
                return (
                  <div key={r.key} className="min-w-0" data-initiative-metric={r.key}>
                    <MetricTile reading={r} trend={trends[r.key]} now={now} size="tile" />
                    {source ? <SourceLink source={source} now={now} className="mt-1 pl-1" /> : r.source ? <p className="mt-1 pl-1 text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }} title={r.source}>{r.source}</p> : null}
                  </div>
                );
              })}
            </div>
          )}
          {readings.length > 0 && readings.every((r) => r.value === null) && (
            <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Nobody has reported a value yet: <code className="text-[11px]">cast initiative report {initiative.short_id} {readings[0].key}=&lt;value&gt; --source &lt;link&gt;</code></p>
          )}
          {chain.length > 0 && (
            <p className="text-[12px] inline-flex items-center gap-1.5 flex-wrap" style={{ color: "var(--sol-text-secondary)" }} data-initiative-chain>
              Feeds {chain.map((c, i) => <span key={c.short_id} className="inline-flex items-center gap-1">{i > 0 && <span style={{ color: "var(--sol-text-dim)" }}>under</span>}<Link href={`/initiatives/${c.short_id}`} className="no-underline hover:underline" style={{ color: "var(--sol-text)" }}>{c.title}</Link> <EntityIdPill type="initiative" id={c.short_id} /></span>)}
            </p>
          )}
          {empty && <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>No number to read it against yet, and no goal above it.</p>}
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------------- projects

function Projects({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const cards = useInitiativeProjects(initiative);
  const workspaceProjects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const byId = useMemo(() => new Map(workspaceProjects.map((p) => [p._id, p])), [workspaceProjects]);
  const options = useMemo(
    () => [...workspaceProjects].sort((a, b) => a.title.localeCompare(b.title)).map((p) => ({ key: p._id, label: p.title, icon: FolderKanban })),
    [workspaceProjects],
  );
  const toggle = (next: string) => {
    const before = new Set(initiative.project_ids);
    const after = new Set(next ? next.split(",") : []);
    const store = useInboxStore.getState();
    // One pick is one undo, however many projects it adds and removes.
    undoAsOne(`Changed the projects of ${quoted(initiative.title, "initiative")}`, () => {
      for (const id of after) if (!before.has(id)) store.addInitiativeProject(initiative._id, id);
      for (const id of before) if (!after.has(id)) store.removeInitiativeProject(initiative._id, id);
    });
  };
  const hidden = initiative.project_ids.length - cards.length;
  return (
    <Section
      name="projects"
      label="Projects"
      count={initiative.project_ids.length}
      action={
        <Popover>
          <PopoverTrigger asChild><span><GhostButton icon={Plus} data-initiative-projects-edit="">{initiative.project_ids.length ? "Change" : "Add a project"}</GhostButton></span></PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-1 max-h-80 overflow-y-auto bg-sol-bg border border-sol-border shadow-xl">
            <FilterOptionList options={options} value={initiative.project_ids.join(",")} multi onChange={toggle} />
          </PopoverContent>
        </Popover>
      }
    >
      {cards.length === 0 ? (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>No project carries this yet. An initiative is reached through its projects: add the ones that contribute to it.</p>
      ) : (
        <div className="space-y-2.5">
          {cards.map((p) => {
            const row = byId.get(p.id);
            const trouble = row ? projectTrouble(row, p, now) : null;
            return (
              <div key={p.id} data-initiative-project={p.id}>
                <ProjectCard p={p} lead={<ProjectLeadChip projectId={p.id} size="xs" />} initiative={<ProjectInitiatives projectId={p.id} size="xs" label="Also in" except={initiative._id} />} />
                {/* The project's own word, beside the owner's, so the two can disagree in plain sight. */}
                {trouble && <p className="mt-1 pl-3 text-[11px]" style={{ color: "var(--sol-yellow)" }} data-initiative-project-trouble>This project is {trouble}.</p>}
              </div>
            );
          })}
        </div>
      )}
      {hidden > 0 && <p className="mt-2 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{hidden} more {hidden === 1 ? "project is" : "projects are"} outside what you can read.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- updates

function Updates({ initiative, now }: { initiative: InitiativeRow; now: number }) {
  const updates = useInitiativeUpdates(initiative._id);
  const [writing, setWriting] = useState(false);
  return (
    <Section name="updates" label="Updates" count={updates.length} action={!writing ? <GhostButton icon={Plus} onClick={() => setWriting(true)} data-initiative-update-open="">Update</GhostButton> : undefined}>
      {writing && <UpdateForm initiative={initiative} onDone={() => setWriting(false)} />}
      {updates.length === 0 && !writing ? (
        <p className="text-[12.5px] italic" style={{ color: "var(--sol-text-dim)" }}>No update yet. Health is whatever the owner said last, so until someone says it, this reads as no update.</p>
      ) : (
        <ol className="space-y-3">
          {updates.map((u) => <UpdateRow key={u._id} update={u} now={now} />)}
        </ol>
      )}
    </Section>
  );
}

function UpdateRow({ update, now }: { update: InitiativeUpdateRow; now: number }) {
  const by = update.by.kind === "role" ? { kind: "role" as const, role_id: update.by.role_id } : update.by;
  return (
    <li className="relative pl-3.5" data-initiative-update={update._id} data-initiative-update-health={update.health}>
      <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full" style={{ background: HEALTH_COLOR[update.health] }} aria-hidden />
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <HealthChip health={update.health} at={update.at} now={now} />
        <OwnerChip owner={by} size={14} />
      </div>
      <MarkdownRenderer content={update.body} className="mt-1 text-[13px] leading-relaxed" />
    </li>
  );
}

/** Update is one control: a short form, a body and a health. The update and
 *  the initiative's health paint in the same tick. */
function UpdateForm({ initiative, onDone }: { initiative: InitiativeRow; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<InitiativeUpdateHealth>(initiative.health === "none" ? "on_track" : initiative.health);
  const post = () => {
    if (!body.trim()) return;
    useInboxStore.getState().postInitiativeUpdate(initiative._id, { client_key: newInitiativeKey(), body: body.trim(), health });
    onDone();
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); post(); }} className="mb-4 rounded-xl border p-2.5" style={{ borderColor: `color-mix(in srgb, ${HEALTH_COLOR[health]} 45%, transparent)` }} data-initiative-update-form>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }}
        rows={3}
        placeholder="How is it going, and what changed since the last update?"
        className="w-full resize-y bg-transparent px-1 py-0.5 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim"
        aria-label="Update"
      />
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Health">
          {INITIATIVE_UPDATE_HEALTHS.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={health === h}
              onClick={() => setHealth(h)}
              className={cn("h-7 inline-flex items-center gap-1.5 px-2.5 rounded-md text-[12px] border transition-colors", health !== h && "hover:bg-sol-bg-highlight/60")}
              style={health === h ? { borderColor: HEALTH_COLOR[h], background: `color-mix(in srgb, ${HEALTH_COLOR[h]} 12%, transparent)`, color: "var(--sol-text)" } : { borderColor: "transparent", color: "var(--sol-text-muted)" }}
              data-initiative-update-health-pick={h}
            >
              <span className="w-[7px] h-[7px] rounded-full" style={{ background: HEALTH_COLOR[h] }} aria-hidden />
              {INITIATIVE_HEALTH_LABEL[h]}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onDone} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
        <button type="submit" disabled={!body.trim()} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }} data-initiative-update-post>Post update</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------- sub initiatives

function SubInitiatives({ rows, now }: { rows: InitiativeRow[]; now: number }) {
  if (rows.length === 0) return null;
  return (
    <Section name="sub" label="Initiatives under this one" count={rows.length}>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: HAIRLINE }}>
        {rows.map((r) => (
          <Link key={r._id} href={initiativeHref(r)} className="flex items-center gap-2.5 px-3 py-2.5 border-t first:border-t-0 no-underline transition-colors hover:bg-sol-bg-highlight/50" style={{ borderColor: HAIRLINE }} data-initiative-sub={r.short_id || r._id}>
            <StatusGlyph status={r.status} />
            <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--sol-text)" }}>{r.title}</span>
            <OwnerChip owner={r.owner} size={14} nameless />
            <HealthChip health={r.health} at={r.health_at} now={now} />
          </Link>
        ))}
      </div>
    </Section>
  );
}
