"use client";
// /goals: every goal of the workspace as one document, written and arranged
// in place. Each goal is a section: its title as the heading, its facts
// (owner, health, target day) as pickers under it, then why it matters, what
// done looks like, its numbers, its owner's latest update in full, the goals
// under it and the projects that carry it. Nothing opens elsewhere to be
// edited: the words are edited where they are read, and the tree is arranged
// by dragging a goal or a project by its handle, or from the keyboard in a
// title (Enter starts the next goal, Tab and Shift+Tab nest and lift, Cmd+Shift
// with an arrow moves it among its siblings).
//
// Paints from the store (useCompanyDoc, the document the Org screen reads),
// and every edit is a store action, so it lands in the same tick. The tree's
// rules (one level of nesting, the order by `position`) are goalsOutline's.
// An open proposal's goal stands where it would sit, in violet, answered on
// the Org screen.
import { useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { ChevronRight, GripVertical, MoreHorizontal, Plus, X } from "lucide-react";
import { metricReadings, metricTrends, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { objectHref } from "@codecast/shared/entities";
import { targetDayOf, targetDayStamp } from "@codecast/shared/time";
import { useInboxStore } from "../../store/inboxStore";
import { undoAsOne } from "../../store/undoActions";
import { quoted } from "../../store/undo/labels";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSyncInitiativeUpdates } from "../../hooks/useInitiatives";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useWorkspaceArgs, workspaceStamp } from "../../hooks/useWorkspaceArgs";
import { initiativeEnded, newInitiativeKey } from "../../lib/initiatives";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { MetricTile, TargetDate } from "../initiatives/InitiativeAtoms";
import { IntentTargetChip } from "../initiatives/IntentHeader";
import { AddProject, GoalLatest, GoalMeasures } from "../initiatives/InitiativePanel";
import { useCompanyDoc } from "../company/useCompanyDoc";
import { stateClauses, type CompanyDoc, type DocGoal, type DocProject } from "../company/companyModel";
import { GoalGlyph, GoalOwnerPick, GoalStatusPick, LINE_SCOPE, ProjectLine, proposalChangeHref } from "../org/lines";
import { canPlace, carriedProjects, indentMove, insertAfterWrites, outdentMove, reorderedProjects, reorderWrites, type GoalMove } from "./goalsOutline";

const SERIF = { fontFamily: "var(--font-serif)" } as const;
const DIM = "var(--sol-text-dim)";
const MUTED = "var(--sol-text-muted)";
const VIOLET = "var(--sol-violet)";
const RULE = "color-mix(in srgb, var(--sol-border) 40%, transparent)";

/** Feeds one open proposal's changes into the store. */
function ProposalFeed({ shortId }: { shortId: string }) {
  useSyncOrgProposal(shortId);
  return null;
}

export function GoalsDocument() {
  useSyncOrgTreeFeeder();
  useSyncProjects();
  useSyncOrgProposals();
  const { doc, open } = useCompanyDoc();
  const now = useCoarseNow(60_000);
  return (
    <>
      {open.map((p) => <ProposalFeed key={p._id} shortId={p.short_id} />)}
      <GoalsDocumentView doc={doc} now={now} />
    </>
  );
}

// ---------------------------------------------------------------- the tree's gestures

type Drag = { kind: "goal"; id: string } | { kind: "project"; id: string; from: string };
/** Where a drop would land: before a goal, before a project in a goal, or last in a goal's projects or a goal list. */
type Drop = { kind: "goal"; parent: string | null; before: string | null } | { kind: "project"; goal: string; before: string | null };
const dropKey = (d: Drop | null) => (!d ? "" : d.kind === "goal" ? `g:${d.parent}:${d.before}` : `p:${d.goal}:${d.before}`);
/** A new goal being titled, after `after` among `parent`'s goals (last for null). */
type Draft = { parent: string | null; after: string | null };

type Doc = {
  now: number;
  all: InitiativeRow[];
  /** The live goals under a parent (null: the top), in the order they read. */
  siblings: (parent: string | null) => InitiativeRow[];
  /** The mission: the one top goal every other one serves. Its goals are the document's list. */
  missionId: string | null;
  drag: Drag | null;
  setDrag: (d: Drag | null) => void;
  drop: Drop | null;
  setDrop: (d: Drop | null) => void;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  folded: ReadonlySet<string>;
  toggleFold: (id: string) => void;
  /** The goal whose title takes the caret on its next paint. */
  focus: string | null;
  setFocus: (id: string | null) => void;
  create: (title: string, at: Draft) => string | null;
  move: (goal: InitiativeRow, to: GoalMove, label: string) => void;
  dropOn: (d: Drop) => void;
};

function useDocModel(doc: CompanyDoc, now: number): Doc {
  const all = useMemo(() => doc.goals.flatMap(function rows(g): InitiativeRow[] { return [...(g.row ? [g.row] : []), ...g.goals.flatMap(rows)]; }), [doc.goals]);
  const missionGoal = doc.goals.length === 1 && doc.goals[0].row && doc.goals[0].goals.length > 0 ? doc.goals[0] : null;
  const missionId = missionGoal?.id ?? null;
  const siblings = useMemo(() => {
    const byParent = new Map<string | null, InitiativeRow[]>();
    const walk = (g: DocGoal, parent: string | null) => {
      if (g.row && !initiativeEnded(g.row.status)) byParent.set(parent, [...(byParent.get(parent) ?? []), g.row]);
      for (const k of g.goals) walk(k, g.id);
    };
    for (const g of doc.goals) walk(g, null);
    return (parent: string | null) => byParent.get(parent) ?? [];
  }, [doc.goals]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDropState] = useState<Drop | null>(null);
  const setDrop = (d: Drop | null) => setDropState((prev) => (dropKey(prev) === dropKey(d) ? prev : d));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const workspace = useWorkspaceArgs();
  const me = useInboxStore((s) => s.currentUser?._id as string | undefined);

  const store = () => useInboxStore.getState();
  const writePositions = (writes: { id: string; position: number }[]) => { for (const w of writes) store().updateInitiative(w.id, { position: w.position }); };
  const titleOf = (id: string | null) => all.find((r) => r._id === id)?.title;

  const move = (goal: InitiativeRow, to: GoalMove, label: string) => undoAsOne(label, () => {
    if ((goal.parent_initiative_id ?? null) !== to.parent) store().updateInitiative(goal._id, { parent_initiative_id: to.parent });
    writePositions(to.position);
  });

  const create = (title: string, at: Draft): string | null => {
    const stamp = workspaceStamp(workspace);
    if (!stamp.workspace || !title.trim()) return null;
    const where = stamp.workspace === "team" ? { workspace: "team" as const, team_id: stamp.team_id } : { workspace: "personal" as const };
    const client_key = newInitiativeKey();
    const writes = insertAfterWrites(siblings(at.parent), client_key, at.after);
    const own = writes.find((w) => w.id === client_key);
    undoAsOne(`Added the goal ${quoted(title.trim(), "goal")}`, () => {
      store().createInitiative({
        client_key, title, ...where, status: "active",
        ...(at.parent ? { parent_initiative_id: at.parent } : {}),
        ...(me ? { owner: { kind: "user", user_id: me } } : {}),
        ...(own ? { position: own.position } : {}),
      });
      writePositions(writes.filter((w) => w.id !== client_key));
    });
    return client_key;
  };

  const dropOn = (d: Drop) => {
    if (!drag) return;
    if (drag.kind === "goal" && d.kind === "goal") {
      const goal = all.find((r) => r._id === drag.id);
      const parent = d.parent ? all.find((r) => r._id === d.parent) ?? null : null;
      if (!goal || d.before === goal._id || !canPlace(all, goal, parent)) return;
      const list = siblings(d.parent).filter((s) => s._id !== goal._id);
      move(goal, { parent: d.parent, position: reorderWrites([...list, goal], goal._id, d.before) },
        (goal.parent_initiative_id ?? null) === d.parent ? `Moved ${quoted(goal.title, "goal")}` : `Moved ${quoted(goal.title, "goal")} under ${quoted(titleOf(d.parent) ?? "the top", "goal")}`);
    }
    if (drag.kind === "project" && d.kind === "project") {
      const to = all.find((r) => r._id === d.goal);
      if (!to || d.before === drag.id) return;
      const title = doc.goals.length ? projectTitle(doc, drag.id) : undefined;
      if (to._id === drag.from) {
        store().setInitiativeProjects(to._id, reorderedProjects(to.project_ids, drag.id, d.before));
        return;
      }
      undoAsOne(`Moved ${quoted(title, "project")} to ${quoted(to.title, "goal")}`, () => {
        store().removeInitiativeProject(drag.from, drag.id);
        if (!to.project_ids.includes(drag.id)) store().addInitiativeProject(to._id, drag.id);
        const after = useInboxStore.getState().initiatives[to._id]?.project_ids ?? [];
        if (d.before) store().setInitiativeProjects(to._id, reorderedProjects(after, drag.id, d.before));
      });
    }
  };

  return {
    now, all, siblings, missionId, drag, setDrag, drop, setDrop, draft, setDraft, focus, setFocus, create, move, dropOn,
    folded, toggleFold: (id) => setFolded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  };
}

function projectTitle(doc: CompanyDoc, id: string): string | undefined {
  const find = (gs: readonly DocGoal[]): DocProject | undefined => { for (const g of gs) { const p = g.projects.find((x) => x.id === id) ?? find(g.goals); if (p) return p; } };
  return find(doc.goals)?.title ?? doc.unfiled.find((p) => p.id === id)?.title;
}

/** A drop zone's handlers: it lights while something it takes is over it. */
function dropProps(d: Doc, target: Drop, takes: Drag["kind"]) {
  return {
    // The innermost place under the pointer takes it: a goal inside another goal's section, not the section around it.
    onDragOver: (e: DragEvent) => { if (d.drag?.kind !== takes) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; d.setDrop(target); },
    onDrop: (e: DragEvent) => { if (d.drag?.kind !== takes) return; e.preventDefault(); e.stopPropagation(); d.dropOn(target); d.setDrag(null); d.setDrop(null); },
  };
}

const dragProps = (d: Doc, what: Drag) => ({
  draggable: true,
  onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", what.id); d.setDrag(what); },
  onDragEnd: () => { d.setDrag(null); d.setDrop(null); },
});

/** The line a drop would land on. */
function DropLine({ on, lift = 1 }: { on: boolean; /** How far above the next thing the line sits, in px: halfway into the gap before it. */ lift?: number }) {
  return <div aria-hidden className="pointer-events-none relative h-0"><div className={cn("absolute inset-x-0 h-[2px] rounded-full transition-opacity", on ? "opacity-100" : "opacity-0")} style={{ top: -lift, background: INITIATIVE_ACCENT }} /></div>;
}

// ---------------------------------------------------------------- the document

export function GoalsDocumentView({ doc, now }: { doc: CompanyDoc; now: number }) {
  const d = useDocModel(doc, now);
  const mission = d.missionId ? doc.goals[0] : null;
  const listed = mission ? mission.goals : doc.goals;
  const openGoals = listed.filter((g) => !g.row || !initiativeEnded(g.row.status));
  const closed = listed.filter((g) => g.row && initiativeEnded(g.row.status));
  const listParent = mission?.id ?? null;
  const told = { ...doc.state, projects: { ...doc.state.projects, total: 0 }, people: 0, roles: 0 };
  const scroller = useRef<HTMLDivElement>(null);
  const [showClosed, setShowClosed] = useState(false);

  // An address with #in-12 opens on that goal.
  useWatchEffect(() => {
    const id = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (id) document.getElementById(`goal-${id}`)?.scrollIntoView({ block: "start" });
  }, [listed.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={scroller} className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-goals-document>
      {/* A goal offers its next update in its own add row, with its other additions. */}
      <style>{`[data-goals-document] [data-initiative-update-open] { display: none; }`}</style>
      <div className="mx-auto flex w-full max-w-[1180px] gap-10 pl-14 pr-8 pt-8 pb-32">
        <Outline goals={openGoals} closed={closed.length} d={d} scroller={scroller} />
        <article className="min-w-0 max-w-[780px] flex-1 text-[13px] leading-[1.55]" data-goals-article>
          <header className="pl-1">
            <h1 className="text-[30px] font-medium leading-[1.15] tracking-[-0.015em]" style={SERIF}>Goals</h1>
            {mission?.row && <Mission goal={mission.row} />}
            <Tally clauses={stateClauses(told)} />
          </header>

          {mission && <Projects goal={{ ...mission, refs: [] }} d={d} depth={0} />}

          <GoalList goals={openGoals} parent={listParent} depth={0} d={d} />
          {listed.length === 0 && <p className="mt-10 pl-1" style={{ color: DIM }}>No goals yet.</p>}
          {!d.draft && (
            <button type="button" onClick={() => d.setDraft({ parent: listParent, after: openGoals.filter((g) => g.row).at(-1)?.id ?? null })} className="mt-8 ml-1 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors hover:bg-sol-bg-highlight/70" style={{ color: MUTED }} data-goals-new>
              <Plus className="h-3.5 w-3.5" /> New goal
            </button>
          )}

          {closed.length > 0 && (
            <section className="mt-14 border-t pt-4" style={{ borderColor: RULE }} data-goals-closed>
              <button type="button" onClick={() => setShowClosed(!showClosed)} className="inline-flex h-7 items-center gap-1.5 rounded-md pl-1 pr-2 text-[12.5px] transition-colors hover:bg-sol-bg-highlight/70" style={{ color: MUTED }} aria-expanded={showClosed}>
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showClosed && "rotate-90")} />
                Completed and cancelled <span className="tabular-nums" style={{ color: DIM }}>{closed.length}</span>
              </button>
              {showClosed && <div className="opacity-80">{closed.map((g) => <GoalSection key={g.id} goal={g} depth={0} d={d} />)}</div>}
            </section>
          )}
        </article>
      </div>
    </div>
  );
}

/** How the goals stand, one line. */
function Tally({ clauses }: { clauses: readonly (readonly string[])[] }) {
  if (!clauses.length) return null;
  return <p className="mt-3 text-[12.5px] tabular-nums" style={{ color: MUTED }} data-goals-tally>{clauses.map((c) => c.join(" ")).join(" · ")}</p>;
}

/** The goal every other one serves, written under the page's title. */
function Mission({ goal }: { goal: InitiativeRow }) {
  return (
    <div className="mt-3" data-goals-mission={goal.short_id}>
      <div className="flex items-start gap-2.5">
        <span className="mt-[8px] inline-flex shrink-0"><GoalGlyph /></span>
        <div className="min-w-0 flex-1 text-[18px] leading-[1.4]" style={SERIF}><TitleField goal={goal} label="Mission" /></div>
      </div>
      <div className="mt-1 pl-[22px]"><Prose goal={goal} placeholder="What the company exists to do, and for whom." /></div>
    </div>
  );
}

// ---------------------------------------------------------------- the outline

/** The goals as a list to jump by, beside the document on a wide screen. The one in view is marked. */
function Outline({ goals, closed, d, scroller }: { goals: readonly DocGoal[]; closed: number; d: Doc; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [inView, setInView] = useState<string | null>(null);
  // The goal in view is the last top-level section whose heading has passed the top third of the pane.
  useWatchEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const read = () => {
      const line = root.getBoundingClientRect().top + root.clientHeight / 3;
      let id: string | null = null;
      for (const el of root.querySelectorAll<HTMLElement>("[data-goal-section]")) if (el.getBoundingClientRect().top <= line) id = el.dataset.goalId ?? null;
      setInView(id);
    };
    read();
    root.addEventListener("scroll", read, { passive: true });
    return () => root.removeEventListener("scroll", read);
  }, [scroller, goals]);
  if (goals.length < 3) return null;
  const jump = (id: string) => scroller.current?.querySelector(`[data-goal-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const rows = goals.flatMap((g) => [{ g, depth: 0 }, ...g.goals.filter((k) => !k.row || !initiativeEnded(k.row.status)).map((k) => ({ g: k, depth: 1 }))]);
  return (
    <nav className="sticky top-8 hidden max-h-[calc(100vh-6rem)] w-[210px] shrink-0 self-start overflow-y-auto pt-[86px] xl:block" aria-label="Goals" data-goals-outline>
      <ol className="space-y-px">
        {rows.map(({ g, depth }) => {
          const health = g.row?.health ?? "none";
          const on = inView === g.id;
          return (
            <li key={g.id}>
              <button type="button" onClick={() => jump(g.id)} className={cn("group flex w-full items-start gap-2 rounded-md py-[5px] pr-2 text-left text-[12px] leading-[1.35] transition-colors hover:bg-sol-bg-highlight/60", on && "bg-sol-bg-highlight/70")} style={{ paddingLeft: 8 + depth * 14, color: on ? "var(--sol-text)" : g.row ? MUTED : VIOLET }} data-goals-outline-item={g.short_id ?? g.id}>
                <span className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full" style={g.row ? (health === "none" ? { border: `1px solid ${DIM}` } : { background: HEALTH_COLOR[health] }) : { background: VIOLET }} aria-hidden />
                <span className="line-clamp-2">{g.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {closed > 0 && <p className="mt-3 pl-2 text-[11.5px]" style={{ color: DIM }}>{closed} closed</p>}
    </nav>
  );
}

// ---------------------------------------------------------------- goals

function GoalList({ goals, parent, depth, d }: { goals: readonly DocGoal[]; parent: string | null; depth: number; d: Doc }) {
  const draftHere = d.draft && d.draft.parent === parent ? d.draft : null;
  const tail: Drop = { kind: "goal", parent, before: null };
  return (
    <div data-goals-list={parent ?? "top"}>
      {goals.map((g) => (
        <div key={g.id}>
          <GoalSection goal={g} depth={depth} d={d} />
          {draftHere && draftHere.after === g.id && <DraftGoal at={draftHere} depth={depth} d={d} />}
        </div>
      ))}
      {draftHere && (draftHere.after === null || !goals.some((g) => g.id === draftHere.after)) && <DraftGoal at={draftHere} depth={depth} d={d} />}
      {d.drag?.kind === "goal" && <div className="h-8" {...dropProps(d, tail, "goal")}><DropLine on={dropKey(d.drop) === dropKey(tail)} /></div>}
    </div>
  );
}

function GoalSection({ goal, depth, d }: { goal: DocGoal; depth: number; d: Doc }) {
  const row = goal.row;
  if (!row) return <ProposedGoal goal={goal} depth={depth} />;
  const parent = row.parent_initiative_id ?? null;
  const folded = d.folded.has(goal.id);
  const here: Drop = { kind: "goal", parent, before: goal.id };
  const ended = initiativeEnded(row.status);
  const dragging = d.drag?.kind === "goal" && d.drag.id === goal.id;
  return (
    <section
      id={row.short_id ? `goal-${row.short_id}` : undefined}
      className={cn("group/goal relative scroll-mt-6", depth === 0 ? "mt-12" : "mt-7", dragging && "opacity-40")}
      data-goal-section={row.short_id || row._id}
      data-goal-id={goal.id}
      data-goal-depth={depth}
      {...(!ended ? dropProps(d, here, "goal") : {})}
    >
      <DropLine on={dropKey(d.drop) === dropKey(here)} lift={depth === 0 ? 25 : 15} />
      <div className="relative">
        {/* The gutter: the handle that drags the goal, and its fold. */}
        <div className="absolute -left-[46px] top-[3px] flex items-center opacity-0 transition-opacity group-hover/goal:opacity-100 focus-within:opacity-100">
          {!ended && <button type="button" {...dragProps(d, { kind: "goal", id: row._id })} className="inline-flex h-6 w-5 cursor-grab items-center justify-center rounded active:cursor-grabbing hover:bg-sol-bg-highlight/70" style={{ color: DIM }} aria-label={`Drag ${row.title}`} data-goal-handle><GripVertical className="h-3.5 w-3.5" /></button>}
          <button type="button" onClick={() => d.toggleFold(goal.id)} className="inline-flex h-6 w-5 items-center justify-center rounded hover:bg-sol-bg-highlight/70" style={{ color: DIM }} aria-label={folded ? "Unfold" : "Fold"} aria-expanded={!folded} data-goal-fold><ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !folded && "rotate-90")} /></button>
        </div>
        <div className="flex items-start gap-2">
          <h2 className={cn("min-w-0 flex-1", depth === 0 ? "text-[21px] leading-[1.3]" : "text-[17px] leading-[1.35]")} style={SERIF}>
            <TitleField goal={row} d={d} className={cn(ended && "line-through decoration-1")} />
          </h2>
          <GoalMenu goal={row} d={d} />
        </div>
        <Facts goal={row} now={d.now} />
      </div>
      {!folded && <GoalBody goal={goal} depth={depth} d={d} />}
    </section>
  );
}

/** Owner, health, target day: each a picker, in the order every goal says them. */
function Facts({ goal, now }: { goal: InitiativeRow; now: number }) {
  const store = () => useInboxStore.getState();
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ color: MUTED }} data-goal-facts>
      <GoalOwnerPick goal={goal} />
      <GoalStatusPick goal={goal} now={now} />
      <span className={goal.target_date ? "contents" : "opacity-0 transition-opacity focus-within:opacity-100 group-hover/goal:opacity-100"}>
      <IntentTargetChip
        day={targetDayOf(goal.target_date)}
        label="Target date"
        emptyLabel="No target"
        onCommit={(day) => { const ts = targetDayStamp(day); if (ts) store().updateInitiative(goal._id, { target_date: ts }); }}
        onClear={() => store().updateInitiative(goal._id, { target_date: null })}
        data-goal-target=""
      >
        {goal.target_date ? <TargetDate ts={goal.target_date} now={now} done={initiativeEnded(goal.status)} /> : null}
      </IntentTargetChip>
      </span>
      {goal.short_id && <Link href={objectHref("initiative", goal.short_id)} className="ml-auto text-[11.5px] tabular-nums no-underline opacity-0 transition-opacity hover:underline group-hover/goal:opacity-100" style={{ color: DIM }} title="Open the goal's page: its record and activity">{goal.short_id}</Link>}
    </div>
  );
}

function GoalBody({ goal, depth, d }: { goal: DocGoal; depth: number; d: Doc }) {
  const row = goal.row!;
  useSyncInitiativeUpdates(row._id);
  const [measuring, setMeasuring] = useState(false);
  const [posting, setPosting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [doneWhen, setDoneWhen] = useState(false);
  const hasNumbers = metricReadings(row).length > 0;
  const hasDone = !!row.done_when?.trim();
  const kids = goal.goals.filter((g) => !g.row || !initiativeEnded(g.row.status));
  const ended = initiativeEnded(row.status);
  // What a goal could still say, offered on its hover: each opens its editor in place.
  const missing = ended ? [] : [
    ...(!hasDone && !doneWhen ? [{ key: "done", words: "Done when", on: () => setDoneWhen(true) }] : []),
    ...(!hasNumbers && !measuring ? [{ key: "number", words: "Number", on: () => setMeasuring(true) }] : []),
    ...(!posting ? [{ key: "update", words: "Update", on: () => setPosting(true) }] : []),
    ...(!adding && row.project_ids.length === 0 ? [{ key: "project", words: "Project", on: () => setAdding(true) }] : []),
    // One level of nesting: only a top goal takes goals under it.
    ...(!row.parent_initiative_id && kids.length === 0 && d.draft?.parent !== row._id ? [{ key: "sub", words: "Goal under it", on: () => d.setDraft({ parent: row._id, after: null }) }] : []),
  ];
  return (
    <div className="mt-3" data-goal-body={row.short_id || row._id}>
      <Prose goal={row} placeholder="Why it matters" />
      {(hasDone || doneWhen) && <DoneWhen goal={row} start={doneWhen} onDone={() => setDoneWhen(false)} />}
      {measuring ? <div className="-mt-2"><GoalMeasures goal={row} all={d.all} now={d.now} editing onEditing={setMeasuring} /></div>
        : hasNumbers && <Numbers goal={row} now={d.now} onEdit={() => setMeasuring(true)} />}
      <div className="[&>div]:mt-4"><GoalLatest goal={row} now={d.now} writing={posting} onWriting={setPosting} /></div>
      {goal.changes.length > 0 && <ProposedChanges goal={goal} />}
      <Projects goal={goal} d={d} depth={depth} adding={adding} onAdding={setAdding} />
      {(kids.length > 0 || d.draft?.parent === row._id) && (
        <div className="mt-2 border-l pl-6" style={{ borderColor: RULE }}>
          <GoalList goals={kids} parent={row._id} depth={depth + 1} d={d} />
        </div>
      )}
      {missing.length > 0 && (
        <div className="mt-2 -ml-1.5 flex flex-wrap items-center gap-0.5 opacity-0 transition-opacity group-hover/goal:opacity-100 focus-within:opacity-100" data-goal-add>
          {missing.map((m) => (
            <button key={m.key} type="button" onClick={m.on} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors hover:bg-sol-bg-highlight/70" style={{ color: DIM }} data-goal-add-item={m.key}>
              <Plus className="h-3 w-3" /> {m.words}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A goal an open proposal would set, where it would sit, in violet; answered on the Org screen. */
function ProposedGoal({ goal, depth }: { goal: DocGoal; depth: number }) {
  const p = goal.proposed?.proposal;
  return (
    <section className={cn("relative", depth === 0 ? "mt-12" : "mt-7")} data-goal-section={goal.id} data-goal-id={goal.id} data-goal-proposed>
      <h2 className={cn(depth === 0 ? "text-[21px]" : "text-[17px]", "leading-[1.3]")} style={{ ...SERIF, color: VIOLET }}>{goal.title}</h2>
      <p className="mt-1.5 text-[12px]" style={{ color: VIOLET }}>
        {goal.unknown ? "Named by a proposal, not found" : "Proposed"}
        {p && <> · <Link href={proposalChangeHref(p)} className="underline-offset-[3px] hover:underline" style={{ color: VIOLET }}>answer in {p.short_id}</Link></>}
      </p>
      {goal.purpose && <p className="mt-3 text-[14px] leading-[1.65]" style={{ color: "var(--sol-text-secondary)" }}>{goal.purpose}</p>}
    </section>
  );
}

/** What open proposals would change on a live goal, each line linking to where it is answered. */
function ProposedChanges({ goal }: { goal: DocGoal }) {
  return (
    <ul className="mt-4 space-y-1 text-[12px]" style={{ color: VIOLET }} data-goal-changes>
      {goal.changes.map((c) => (
        <li key={c.row.change_id} className="flex items-baseline gap-2">
          <span className="h-[6px] w-[6px] shrink-0 translate-y-[-1px] rotate-45 rounded-[1px]" style={{ background: VIOLET }} aria-hidden />
          <span className="min-w-0">{c.sentence ?? c.row.detail ?? c.row.chip ?? c.row.line}</span>
          {c.proposal && <Link href={proposalChangeHref(c.proposal)} className="shrink-0 underline-offset-[3px] hover:underline" style={{ color: VIOLET }}>{c.proposal.short_id}</Link>}
        </li>
      ))}
    </ul>
  );
}

/** The goal's menu: what the heading itself does not show. */
function GoalMenu({ goal, d }: { goal: InitiativeRow; d: Doc }) {
  const [open, setOpen] = useState(false);
  const store = () => useInboxStore.getState();
  const ended = initiativeEnded(goal.status);
  const parent = goal.parent_initiative_id ?? null;
  const homes = d.siblings(null).filter((p) => p._id !== goal._id && p._id !== parent && canPlace(d.all, goal, p));
  const item = (label: string, on: () => void, danger = false) => (
    <button key={label} type="button" onClick={() => { on(); setOpen(false); }} className={cn("flex w-full items-center rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-sol-bg-highlight/70", danger && "hover:text-sol-red")}>{label}</button>
  );
  const moveUnder = (to: InitiativeRow | null) => d.move(goal, { parent: to?._id ?? null, position: reorderWrites([...d.siblings(to?._id ?? null), goal], goal._id, null) }, `Moved ${quoted(goal.title, "goal")} under ${quoted(to?.title ?? "the top", "goal")}`);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="mt-[3px] inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-sol-bg-highlight/70 group-hover/goal:opacity-100 data-[state=open]:opacity-100" style={{ color: DIM }} aria-label="Goal menu" data-goal-menu>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 border border-sol-border bg-sol-bg p-1 shadow-xl">
        {goal.short_id && <Link href={objectHref("initiative", goal.short_id)} className="flex w-full rounded px-2 py-1.5 text-[12.5px] no-underline hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text)" }}>Open its page</Link>}
        {!ended && homes.length > 0 && (
          <>
            <div className="mx-2 my-1 border-t" style={{ borderColor: RULE }} />
            <p className="px-2 pb-0.5 pt-1 text-[11px]" style={{ color: DIM }}>Move under</p>
            <div className="max-h-48 overflow-y-auto">{homes.map((h) => item(h.title, () => moveUnder(h)))}</div>
          </>
        )}
        {!ended && parent && parent !== d.missionId && item("Move to the top", () => moveUnder(null))}
        <div className="mx-2 my-1 border-t" style={{ borderColor: RULE }} />
        {ended ? item("Reopen", () => store().updateInitiative(goal._id, { status: "active" }))
          : <>{item("Mark completed", () => store().updateInitiative(goal._id, { status: "completed" }))}{item("Cancel this goal", () => store().updateInitiative(goal._id, { status: "cancelled" }), true)}</>}
      </PopoverContent>
    </Popover>
  );
}

/** A new goal's heading: Enter or leaving it with words in it makes the goal and starts the next one; empty, it goes away. */
function DraftGoal({ at, depth, d }: { at: Draft; depth: number; d: Doc }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useMountEffect(() => { ref.current?.focus(); });
  const commit = (next: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = ref.current?.value.trim() ?? "";
    const id = title ? d.create(title, at) : null;
    d.setDraft(id && next ? { parent: at.parent, after: id } : null);
  };
  return (
    <section className={cn("relative", depth === 0 ? "mt-12" : "mt-7")} data-goal-draft>
      <h2 className={cn(depth === 0 ? "text-[21px] leading-[1.3]" : "text-[17px] leading-[1.35]")} style={SERIF}>
        <AutoTextarea
          ref={ref}
          placeholder="Name the goal"
          aria-label="New goal"
          onBlur={() => commit(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(true); }
            if (e.key === "Escape") { e.preventDefault(); done.current = true; d.setDraft(null); }
          }}
        />
      </h2>
    </section>
  );
}

// ---------------------------------------------------------------- words in place

/** A textarea that grows with its words and wears the text around it. */
const AutoTextarea = ({ ref, className, onInput, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) => {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => { const el = own.current; if (el) { el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`; } };
  useWatchEffect(fit);
  return (
    <textarea
      ref={(el) => { own.current = el; if (typeof ref === "function") ref(el); else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el; }}
      rows={1}
      spellCheck
      onInput={(e) => { fit(); onInput?.(e); }}
      className={cn("block w-full resize-none overflow-hidden bg-transparent p-0 outline-none placeholder:text-sol-text-dim", className)}
      {...rest}
      style={{ color: "inherit", letterSpacing: "inherit", ...rest.style }}
    />
  );
};

/** A goal's title, always editable where it reads. Enter keeps it and starts
 *  the next goal; Tab and Shift+Tab nest it under the goal above and lift it
 *  out; Cmd+Shift+Up and Down move it among its siblings; Escape puts it back. */
function TitleField({ goal, d, className, label = "Goal title" }: { goal: InitiativeRow; d?: Doc; className?: string; label?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  // A title another window changes is taken in unless this one is being typed in.
  useWatchEffect(() => { if (!focused.current && ref.current && ref.current.value !== goal.title) ref.current.value = goal.title; }, [goal.title]);
  useWatchEffect(() => { if (d?.focus === goal._id) { ref.current?.focus(); d.setFocus(null); } }, [d?.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    const next = ref.current?.value.replace(/\s+/g, " ").trim() ?? "";
    if (!next) { if (ref.current) ref.current.value = goal.title; return; }
    if (next !== goal.title) useInboxStore.getState().updateInitiative(goal._id, { title: next });
  };
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); if (ref.current) ref.current.value = goal.title; ref.current?.blur(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
      if (d && !initiativeEnded(goal.status) && goal._id !== d.missionId) d.setDraft({ parent: goal.parent_initiative_id ?? null, after: goal._id });
      else ref.current?.blur();
      return;
    }
    if (!d || goal._id === d.missionId || initiativeEnded(goal.status)) return;
    const parent = goal.parent_initiative_id ?? null;
    const sibs = d.siblings(parent);
    if (e.key === "Tab") {
      // Inside the mission every goal is already as deep as the tree goes.
      if (parent === d.missionId && d.missionId) { e.preventDefault(); return; }
      e.preventDefault();
      save();
      const grand = parent ? d.all.find((r) => r._id === parent)?.parent_initiative_id ?? null : null;
      const to = e.shiftKey ? outdentMove(d.all, d.siblings(grand), goal) : indentMove(d.all, sibs, goal);
      if (to) { d.move(goal, to, e.shiftKey ? `Lifted ${quoted(goal.title, "goal")} out` : `Moved ${quoted(goal.title, "goal")} under the goal above`); d.setFocus(goal._id); }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const i = sibs.findIndex((s) => s._id === goal._id);
      const j = e.key === "ArrowUp" ? i - 1 : i + 2;
      if (i < 0 || j < 0 || j > sibs.length) return;
      d.move(goal, { parent, position: reorderWrites(sibs, goal._id, sibs[j]?._id ?? null) }, `Moved ${quoted(goal.title, "goal")}`);
      d.setFocus(goal._id);
    }
  };
  return (
    <AutoTextarea
      ref={ref}
      defaultValue={goal.title}
      aria-label={label}
      className={cn("rounded-[3px] font-medium", className)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; save(); }}
      onKeyDown={keys}
      data-goal-title={goal.short_id || goal._id}
    />
  );
}

/** Why the goal matters, in its owner's words: read as written (markdown) and
 *  written in place with a click. It edits the field it shows: `why` once
 *  written, else the description it reads in its place. */
function Prose({ goal, placeholder }: { goal: InitiativeRow; placeholder: string }) {
  const field: "why" | "description" = goal.why?.trim() || !goal.description?.trim() ? "why" : "description";
  const value = goal[field] ?? "";
  return <WordsInPlace value={value} placeholder={placeholder} label="Why it matters" className="text-[14px] leading-[1.65]" onSave={(next) => useInboxStore.getState().updateInitiative(goal._id, { [field]: next || null })} data-goal-why={field} />;
}

/** The goal's numbers, each against its target on one line; a click edits them. */
function Numbers({ goal, now, onEdit }: { goal: InitiativeRow; now: number; onEdit: () => void }) {
  const trends = metricTrends(goal);
  return (
    <div className="mt-3 flex gap-3" data-goal-numbers>
      <span className="w-[74px] shrink-0 pt-[3px] text-[12px]" style={{ color: DIM }}>{metricReadings(goal).length === 1 ? "Number" : "Numbers"}</span>
      <button type="button" onClick={onEdit} className="-mx-2 -my-0.5 flex min-w-0 flex-1 flex-col items-start gap-1 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-sol-bg-highlight/40" aria-label="Edit the numbers">
        {metricReadings(goal).map((r) => <MetricTile key={r.key} reading={r} trend={trends[r.key]} now={now} size="line" className="max-w-full" />)}
      </button>
    </div>
  );
}

function DoneWhen({ goal, start, onDone }: { goal: InitiativeRow; start: boolean; onDone: () => void }) {
  return (
    <div className="mt-3 flex gap-3 text-[13px]" data-goal-done-when>
      <span className="w-[74px] shrink-0 pt-px text-[12px]" style={{ color: DIM }}>Done when</span>
      <WordsInPlace value={goal.done_when ?? ""} start={start} onDone={onDone} placeholder="The sentence a result is checked against." label="Done when" className="min-w-0 flex-1 leading-[1.55]" onSave={(next) => useInboxStore.getState().updateInitiative(goal._id, { done_when: next || null })} />
    </div>
  );
}

/** Words read as written and edited where they stand: a click opens them,
 *  leaving keeps them, Escape puts them back. Empty, the placeholder stands in. */
function WordsInPlace({ value, onSave, placeholder, label, className, start = false, onDone, ...data }: { value: string; onSave: (next: string) => void; placeholder: string; label: string; className?: string; start?: boolean; onDone?: () => void } & Record<`data-${string}`, string>) {
  const [editing, setEditing] = useState(start);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useWatchEffect(() => { if (editing) { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  const close = () => {
    const next = ref.current?.value.trim() ?? value;
    if (!cancelled.current && next !== value.trim()) onSave(next);
    cancelled.current = false;
    setEditing(false);
    onDone?.();
  };
  if (editing) {
    return (
      <AutoTextarea
        ref={ref}
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        className={cn("-mx-2 -my-1 rounded-md px-2 py-1 ring-1 ring-[color-mix(in_srgb,var(--sol-border)_60%,transparent)]", className)}
        style={{ color: "var(--sol-text)", width: "calc(100% + 1rem)" }}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; ref.current?.blur(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ref.current?.blur(); }
        }}
        {...data}
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) setEditing(true); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
      className={cn("-mx-2 -my-1 cursor-text rounded-md px-2 py-1 outline-none transition-colors hover:bg-sol-bg-highlight/40 focus-visible:bg-sol-bg-highlight/40", className)}
      style={{ color: value ? "var(--sol-text-secondary)" : DIM }}
      aria-label={`${label}: edit`}
      {...data}
    >
      {value ? <MarkdownRenderer content={value} className={cn("goals-prose", className)} /> : <p>{placeholder}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- projects

/** The projects that carry a goal, in its owner's order: each dragged by its
 *  handle to another place in the list or onto another goal's list. */
function Projects({ goal, d, depth, adding = false, onAdding }: { goal: DocGoal; d: Doc; depth: number; adding?: boolean; onAdding?: (on: boolean) => void }) {
  const row = goal.row;
  const carried = useMemo(() => (row ? carriedProjects(goal, row.project_ids) : []), [goal, row]);
  if (!row) return null;
  const takes = d.drag?.kind === "project";
  if (carried.length === 0 && !adding && !takes) return null;
  const tail: Drop = { kind: "project", goal: row._id, before: null };
  return (
    <div className="mt-5" data-goal-projects={row.short_id || row._id}>
      <div className="mb-1 flex min-h-[24px] items-center gap-2">
        <h3 className="text-[12px] font-normal" style={{ color: DIM }}>Projects</h3>
        {carried.length > 0 && <span className="text-[11px] tabular-nums" style={{ color: DIM }}>{carried.length}</span>}
        <span className="flex-1" />
        {onAdding && (adding || carried.length > 0) && <span className="opacity-0 transition-opacity group-hover/goal:opacity-100 has-[[data-state=open]]:opacity-100" style={adding ? { opacity: 1 } : undefined}><AddProject goal={row} open={adding || undefined} onOpenChange={onAdding} /></span>}
      </div>
      <div className={LINE_SCOPE}>
        {carried.map(({ project, under }) => {
          const here: Drop = { kind: "project", goal: row._id, before: project.id };
          const live = !project.ghost;
          return (
            <div key={project.id} className={cn("group/project relative", d.drag?.kind === "project" && d.drag.id === project.id && d.drag.from === row._id && "opacity-40")} {...(live ? dropProps(d, here, "project") : {})} data-goal-project={project.id}>
              <DropLine on={dropKey(d.drop) === dropKey(here)} />
              {live && (
                <button type="button" {...dragProps(d, { kind: "project", id: project.id, from: row._id })} className="absolute -left-[22px] top-1/2 inline-flex h-6 w-5 -translate-y-1/2 cursor-grab items-center justify-center rounded opacity-0 transition-opacity active:cursor-grabbing hover:bg-sol-bg-highlight/70 group-hover/project:opacity-100" style={{ color: DIM }} aria-label={`Drag ${project.title}`} data-project-handle>
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
              )}
              <ProjectLine
                project={project}
                now={d.now}
                editable={live}
                ghost={project.ghost ? { ...(project.ghost.proposal ? { proposal: project.ghost.proposal } : {}), changeIds: [project.ghost.change_id] } : undefined}
                sub={project.ghost ? "would move here" : under ? <span title={`Also listed under ${under}`}>also under {under}</span> : undefined}
              />
              {live && (
                <button type="button" onClick={() => useInboxStore.getState().removeInitiativeProject(row._id, project.id)} className="absolute -right-7 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-sol-bg-highlight/70 hover:text-sol-red group-hover/project:opacity-100" style={{ color: DIM }} aria-label={`Take ${project.title} off this goal`} title="Take it off this goal" data-project-remove>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {takes && (
          <div className="h-7 rounded-md border border-dashed text-[11.5px] leading-7 pl-2" style={{ borderColor: dropKey(d.drop) === dropKey(tail) ? INITIATIVE_ACCENT : RULE, color: DIM }} {...dropProps(d, tail, "project")} data-project-drop-tail>
            {carried.length === 0 ? `Drop here to put it under ${row.title}` : "Drop here to put it last"}
          </div>
        )}
      </div>
    </div>
  );
}

