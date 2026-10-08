"use client";
// The sections of a goal's sheet (cohesive build spec §5.2;
// docs/architecture/initiatives-projects-role-page.md I4, I5), each one
// reading the store and writing through the store's actions, so an edit
// paints in the same tick and the dispatch carries it to the server:
//
//   Why                   one editor for `why`; the description reads in its place until it is written
//   Measured by           the number now against its target, its trend, and the goal it feeds
//   Carried by            the projects with their own trouble word, then the goals under it, "+ Project"
//   Latest update         the newest update, who wrote it and its health; older ones folded; Post an update
//   Activity              everything that moved under it, through the one feed a scope uses
//
// A section with nothing in it is not drawn: the sheet's menu offers what
// starts it (a number, the first update), and the record folds below.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { INITIATIVE_HEALTH_LABEL, INITIATIVE_METRICS_MAX, INITIATIVE_UPDATE_HEALTHS, initiativeChain, metricKeyOf, metricReadings, metricTrends, parseIntentSource, type InitiativeRow, type InitiativeUpdateHealth, type InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { undoAsOne } from "../../store/undoActions";
import { quoted } from "../../store/undo/labels";
import { useInitiativeUpdates } from "../../hooks/useInitiatives";
import { useWorkspaceArgs, workspaceStamp } from "../../hooks/useWorkspaceArgs";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { goalScopeInitiativeIds, goalScopeProjectIds, newInitiativeKey, projectTrouble } from "../../lib/initiatives";
import type { ScopeRef } from "../../hooks/useScopeQueries";
import { cn } from "../../lib/utils";
import { HEALTH_COLOR } from "../../lib/initiativeColors";
import { FilterOptionList } from "../FilterDropdown";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScopeFeed } from "../org/scope/ScopeFeed";
import { GoalGlyph, GoalLine, LINE_COMPACT, LINE_SCOPE, ObjectLine, ProjectLine, type LineGhost } from "../org/lines";
import { useLineOpen } from "../org/lines/lineOpen";
import type { DocChange, DocGoal, DocProject } from "../company/companyModel";
import { HealthChip, MetricTile, OwnerChip, SourceLink } from "./InitiativeAtoms";
import { RecordSection as Section, Written } from "./InitiativeRecord";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const DIM = "var(--sol-text-dim)";
/** A report's source is free text: an address opens, anything else is read as written. */
const metricSource = (text: string) => { const src = parseIntentSource(text); return src.kind === "note" ? null : src; };
const projectSig = (p: ProjectItem) => `${p.title}|${p.short_id ?? ""}|${p.status}`;

function GhostButton({ icon: Icon, children, onClick, ...rest }: { icon?: typeof Plus; children: React.ReactNode; onClick?: () => void } & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" onClick={onClick} className="h-6 inline-flex items-center gap-1 px-1.5 rounded-md text-[11.5px] hover:bg-sol-bg-highlight/70 transition-colors" style={{ color: "var(--sol-text-muted)" }} {...rest}>
      {Icon && <Icon className="w-3 h-3" />} {children}
    </button>
  );
}

function FormButtons({ submit, onCancel, onSubmit, disabled, ...rest }: { submit: string; onCancel: () => void; onSubmit?: () => void; disabled?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <>
      <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      <button type={onSubmit ? "button" : "submit"} onClick={onSubmit} disabled={disabled} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: "var(--sol-text)", color: "var(--sol-bg)" }} {...rest}>{submit}</button>
    </>
  );
}

// ------------------------------------------------------------------- why

/** Why the goal matters: the one written field under its head. Its
 *  description reads in its place until someone writes `why`, held to a
 *  glance with Read all under it. With neither written it is not drawn
 *  unless `writing` opens it on its editor; `onWriting(false)` says the
 *  editor closed. */
export function GoalWhy({ goal, writing = false, onWriting }: { goal: InitiativeRow; writing?: boolean; onWriting?: (on: boolean) => void }) {
  if (!goal.why?.trim() && !goal.description?.trim() && !writing) return null;
  return (
    <div className="mt-5" data-goal-why>
      <Written key={writing ? "writing" : "reading"} initiative={goal} field="why" label="Why" rows={4} markdown clamp fallback={goal.description} start={writing} onDone={() => onWriting?.(false)} placeholder="What changes for the company when this is reached, and what it costs to miss it." />
    </div>
  );
}

// ---------------------------------------------------------------- metrics

/** How the goal is measured (I4): each number read against its target with
 *  its trend and the source of its last report, then the goal it feeds. On
 *  track here means against the target; the owner's word stands in the head
 *  so the two can disagree visibly. Drawn only for a goal that has a number,
 *  or while one is being written. A role reports the value with
 *  `cast initiative report`. */
export function GoalMeasures({ goal, all, now, editing, onEditing }: { goal: InitiativeRow; all: readonly InitiativeRow[]; now: number; editing: boolean; onEditing: (on: boolean) => void }) {
  const readings = metricReadings(goal);
  const trends = metricTrends(goal);
  const chain = useMemo(() => initiativeChain(goal, (id) => all.find((r) => r._id === id)), [goal, all]);
  const [draft, setDraft] = useState<Array<{ name: string; target: string }>>(() => (readings.length ? readings.map((r) => ({ name: r.name, target: r.target })) : [{ name: "", target: "" }]));
  if (!readings.length && !editing) return null;
  const open = () => { setDraft(readings.length ? readings.map((r) => ({ name: r.name, target: r.target })) : [{ name: "", target: "" }]); onEditing(true); };
  const save = () => {
    const metrics = draft.map((m) => ({ name: m.name.trim(), target: m.target.trim() })).filter((m) => m.name && m.target).map((m) => ({ key: metricKeyOf(m.name), name: m.name, target: m.target }));
    useInboxStore.getState().updateInitiative(goal._id, { metrics });
    onEditing(false);
  };
  return (
    <div className="mt-5">
      <Section name="metrics" label="Measured by" action={!editing ? <GhostButton icon={Pencil} onClick={open} data-initiative-edit-metrics="">Edit</GhostButton> : undefined}>
        {editing ? (
          <div className="space-y-1.5" data-initiative-metrics-form>
            {draft.map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input autoFocus={i === 0} value={m.name} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Weekly active teams" className="flex-1 min-w-0 h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60" style={{ borderColor: HAIRLINE }} aria-label="Metric name" />
                <input value={m.target} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { e.stopPropagation(); onEditing(false); } }} placeholder="target 1,000" className="w-[110px] h-7 rounded-md border bg-transparent px-2 text-[12.5px] tabular-nums outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60" style={{ borderColor: HAIRLINE }} aria-label="Target" />
                <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: DIM }} aria-label="Remove this metric"><X className="w-3 h-3" /></button>
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              {draft.length < INITIATIVE_METRICS_MAX && <GhostButton icon={Plus} onClick={() => setDraft([...draft, { name: "", target: "" }])}>Another number</GhostButton>}
              <span className="flex-1" />
              <FormButtons submit="Save" onCancel={() => onEditing(false)} onSubmit={save} />
            </div>
            <p className="text-[11px]" style={{ color: DIM }}>A target reads as a number to reach; write "under 5%" for one to stay below.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="initiative-metric-grid grid grid-cols-1 gap-2" data-count={readings.length}>
              {readings.map((r) => {
                const source = r.source ? metricSource(r.source) : null;
                return (
                  <div key={r.key} className="min-w-0 flex flex-col" data-initiative-metric={r.key}>
                    <MetricTile reading={r} trend={trends[r.key]} now={now} size="tile" className="flex-1" />
                    {source ? <SourceLink source={source} now={now} className="mt-1 pl-1" /> : r.source ? <p className="mt-1 pl-1 text-[11px] truncate" style={{ color: DIM }} title={r.source}>{r.source}</p> : null}
                  </div>
                );
              })}
            </div>
            {readings.every((r) => r.value === null) && (
              <p className="text-[11.5px]" style={{ color: DIM }} title={`An agent reports it with: cast initiative report ${goal.short_id} ${readings[0].key}=<value> --source <link>`} data-initiative-no-reading>No reading yet. Ask its owner for the first one.</p>
            )}
            {chain.length > 0 && (
              <p className="text-[12px] inline-flex items-center gap-1.5 flex-wrap" style={{ color: DIM }} data-initiative-chain>
                Feeds {chain.map((c, i) => <span key={c.short_id} className="inline-flex items-center gap-1">{i > 0 && <span>under</span>}<ChainLink ref_={c.short_id} title={c.title} /></span>)}
              </p>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

/** A goal up the chain: its sheet inside the Org screen, its address anywhere else. */
function ChainLink({ ref_, title }: { ref_: string; title: string }) {
  const { onLinkClick } = useLineOpen();
  const target = { kind: "initiative" as const, ref: ref_ };
  return <Link href={objectHref("initiative", ref_)} onClick={onLinkClick(target)} className="no-underline hover:underline underline-offset-[3px]" style={{ color: "var(--sol-text-secondary)" }}>{title}</Link>;
}

// ------------------------------------------------------------- carried by

const ghostOf = (change: DocChange | undefined): LineGhost | undefined => (change ? { ...(change.proposal ? { proposal: change.proposal } : {}), changeIds: [change.row.change_id] } : undefined);

/** What carries the goal, in the document's own reading (companyDoc): its
 *  projects, each with what it says against itself, then the goals under it,
 *  live and proposed, on the sheet's compact grid. "+ Project" adds one, an
 *  existing project or a new one, which lands under this goal. */
export function GoalCarriedBy({ goal, doc, now, adding, onAdding }: { goal: InitiativeRow; doc: DocGoal | undefined; now: number; /** The menu asked to add the first project. */ adding: boolean; onAdding: (on: boolean) => void }) {
  // Every project it carries, in the owner's order, those a proposal would bring last.
  const projects = useMemo<DocProject[]>(() => {
    if (!doc) return [];
    const at = (p: DocProject) => { const i = goal.project_ids.indexOf(p.id); return p.ghost || i < 0 ? Infinity : i; };
    return [...doc.projects, ...doc.refs.map((r) => r.project)].sort((a, b) => at(a) - at(b));
  }, [doc, goal.project_ids]);
  const subs = doc?.goals ?? [];
  const empty = projects.length === 0 && subs.length === 0;
  if (empty && !adding) return null;
  const add = <AddProject goal={goal} open={adding || undefined} onOpenChange={onAdding} />;
  return (
    <div className="mt-5">
      <Section name="carried" label="Carried by" action={add}>
        <div className={cn(LINE_SCOPE, LINE_COMPACT)} data-sheet-carried>
          {projects.map((p) => {
            const counts = p.counts && p.counts !== "counting" ? p.counts : { open: 0, done: 0 };
            const trouble = p.ghost ? null : projectTrouble({ _id: p.id, title: p.title, status: p.status ?? "", target_date: p.target_date, risks: p.risks }, counts, now);
            // The state cell speaks only when something is worth a word: its
            // trouble, its live sessions, or a status other than active.
            const live = !!p.sessions && !!(p.sessions.working || p.sessions.needs_input);
            const quiet = !trouble && !live && (p.status ?? "active") === "active";
            return (
              <ProjectLine
                key={p.id}
                project={p}
                now={now}
                ghost={p.ghost ? { ...(p.ghost.proposal ? { proposal: p.ghost.proposal } : {}), changeIds: [p.ghost.change_id] } : undefined}
                sub={p.ghost ? "would move here" : undefined}
                {...(trouble ? { state: <span className="truncate" style={{ color: "var(--sol-orange)" }} title={trouble} data-initiative-project-trouble>{trouble}</span> } : quiet ? { state: null } : {})}
                data-initiative-project={p.id}
              />
            );
          })}
          {subs.map((g) => g.row
            ? <GoalLine key={g.id} goal={g.row} now={now} data-initiative-sub={g.short_id || g.id} />
            : <ObjectLine key={g.id} kind="goal" id={g.id} glyph={<GoalGlyph ghost />} title={g.title} sub="a goal under this one" ghost={ghostOf(g.proposed)} />)}
        </div>
      </Section>
    </div>
  );
}

/** "+ Project": the workspace's projects to carry the goal, and a new one by name. */
export function AddProject({ goal, open: asked, onOpenChange }: { goal: InitiativeRow; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const workspace = useWorkspaceArgs();
  const all = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const [own, setOwn] = useState(false);
  const open = asked ?? own;
  const setOpen = (o: boolean) => { setOwn(o); onOpenChange?.(o); };
  const [name, setName] = useState("");
  const options = useMemo(() => [...all].filter((p) => p.status !== "done" || goal.project_ids.includes(p._id)).sort((a, b) => a.title.localeCompare(b.title)).map((p) => ({ key: p._id, label: p.title })), [all, goal.project_ids]);
  const toggle = (next: string) => {
    const before = new Set(goal.project_ids);
    const after = new Set(next ? next.split(",") : []);
    const store = useInboxStore.getState();
    // One pick is one undo, however many projects it adds and removes.
    undoAsOne(`Changed the projects of ${quoted(goal.title, "goal")}`, () => {
      for (const id of after) if (!before.has(id)) store.addInitiativeProject(goal._id, id);
      for (const id of before) if (!after.has(id)) store.removeInitiativeProject(goal._id, id);
    });
  };
  // The new project paints under the goal at once, as a stub the server row
  // supersedes; the server attaches it to the goal in the create's own
  // transaction. A refusal takes the stub back out and says why.
  const create = () => {
    const title = name.trim();
    if (!title || workspace === "skip") return;
    const client_key = `projstub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    useInboxStore.getState()
      .createProject({ title, client_key, ...workspaceStamp(workspace) }, { version: 1, kind: "attachToInitiative", initiativeId: goal._id })
      .catch((e: any) => toast.error(e?.message?.split("\n")[0] || "Could not create the project"));
    setName("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><span><GhostButton icon={Plus} data-initiative-projects-edit="">Project</GhostButton></span></PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 bg-sol-bg border border-sol-border shadow-xl" data-initiative-add-project>
        <form onSubmit={(e) => { e.preventDefault(); create(); }} className="flex items-center gap-1.5 p-1.5 border-b" style={{ borderColor: HAIRLINE }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="A new project" aria-label="New project name" className="min-w-0 flex-1 h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60" style={{ borderColor: HAIRLINE }} data-initiative-new-project />
          <button type="submit" disabled={!name.trim()} className="h-7 px-2.5 inline-flex items-center gap-1 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: "var(--sol-text)", color: "var(--sol-bg)" }}>Create</button>
        </form>
        <div className="max-h-72 overflow-y-auto pt-1">
          <FilterOptionList options={options} value={goal.project_ids.join(",")} multi onChange={toggle} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- updates

/** What the owner said last, with the health it set: the newest update in
 *  full, the older ones folded under it, and the form that posts the next.
 *  Drawn once there is an update or one is being written. */
export function GoalLatest({ goal, now, writing, onWriting }: { goal: InitiativeRow; now: number; writing: boolean; onWriting: (on: boolean) => void }) {
  const updates = useInitiativeUpdates(goal._id);
  const [older, setOlder] = useState(false);
  if (updates.length === 0 && !writing) return null;
  const [latest, ...rest] = updates;
  return (
    <div className="mt-5">
      <Section name="updates" label="Latest update">
        {writing && <UpdateForm goal={goal} onDone={() => onWriting(false)} />}
        {latest && <ol><UpdateRow update={latest} now={now} /></ol>}
        {!writing && (
          <div className="mt-1.5 flex items-center gap-1 -ml-1.5">
            <GhostButton onClick={() => onWriting(true)} data-initiative-update-open="">Post an update</GhostButton>
            {rest.length > 0 && <GhostButton onClick={() => setOlder(!older)} data-initiative-updates-older="">{older ? "Hide older updates" : `${rest.length} older ${rest.length === 1 ? "update" : "updates"}`}</GhostButton>}
          </div>
        )}
        {older && rest.length > 0 && <ol className="mt-2 space-y-3">{rest.map((u) => <UpdateRow key={u._id} update={u} now={now} />)}</ol>}
      </Section>
    </div>
  );
}

function UpdateRow({ update, now }: { update: InitiativeUpdateRow; now: number }) {
  const by = update.by.kind === "role" ? { kind: "role" as const, role_id: update.by.role_id } : update.by;
  return (
    <li className="relative pl-3.5" data-initiative-update={update._id} data-initiative-update-health={update.health}>
      <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full" style={{ background: HEALTH_COLOR[update.health] }} aria-hidden />
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <OwnerChip owner={by} size={14} />
        <HealthChip health={update.health} at={update.at} now={now} lower />
      </div>
      <MarkdownRenderer content={update.body} className="mt-1 text-[13px] leading-relaxed" />
    </li>
  );
}

/** Posting is one short form, a body and a health. The update and the goal's
 *  health paint in the same tick. */
function UpdateForm({ goal, onDone }: { goal: InitiativeRow; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<InitiativeUpdateHealth>(goal.health === "none" ? "on_track" : goal.health);
  const post = () => {
    if (!body.trim()) return;
    useInboxStore.getState().postInitiativeUpdate(goal._id, { client_key: newInitiativeKey(), body: body.trim(), health });
    onDone();
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); post(); }} className="mb-3 rounded-[9px] border p-2.5" style={{ borderColor: `color-mix(in srgb, ${HEALTH_COLOR[health]} 45%, transparent)` }} data-initiative-update-form>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }}
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
        <FormButtons submit="Post update" onCancel={onDone} disabled={!body.trim()} data-initiative-update-post="" />
      </div>
    </form>
  );
}

// --------------------------------------------------------------- activity

/** Everything that moved under the goal: its projects and its sub goals',
 *  with the goals' own updates and the calls that name them. The scope feed
 *  is the engine; this only says which scope. */
export function GoalActivity({ goal, all }: { goal: InitiativeRow; all: readonly InitiativeRow[] }) {
  const projectIds = goalScopeProjectIds(goal, all as InitiativeRow[]).join(",");
  const initiativeIds = goalScopeInitiativeIds(goal, all as InitiativeRow[]).join(",");
  const scope = useMemo<ScopeRef>(() => ({
    scope: { project_ids: projectIds ? projectIds.split(",") : [], plan_ids: [], initiative_ids: initiativeIds ? initiativeIds.split(",") : [] },
    ...(goal.team_id ? { team_id: goal.team_id } : {}),
  }), [projectIds, initiativeIds, goal.team_id]);
  return <ScopeFeed key={JSON.stringify(scope)} scope={scope} />;
}
