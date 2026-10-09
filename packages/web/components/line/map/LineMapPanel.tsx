"use client";
// A node's or an edge's panel beside the map (docs/architecture/line-map.md
// LX3). One shape for every node: Now (what is here, oldest first, each
// opening its trace), Through (what passed in the window, how each left and
// how long it stayed), Health (in words first) and Definition (what the node
// is and every value that shapes it, edited in place through the line's edit
// path, LX5), with asking an agent for a change (LX6) pinned to its footer so
// it is always in reach. An edge's panel is the items that crossed it.
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, MessageSquarePlus, X } from "lucide-react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore, type SessionDecisionItem } from "../../../store/inboxStore";
import { ageShort, type CauseRow, type LineFlow, type LineProject, type SenseSource } from "../../../lib/lineFlow";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { projectSig } from "../useLineFloor";
import { LINE_FIELDS } from "../../../lib/lineSettings";
import { decisionHref, runHref } from "../../../lib/decisionLinks";
import { stationHistory, stationWords, type LineVersion } from "../../../lib/line/runReport";
import { usualStay, type LineMap, type MapEdge, type MapItem, type MapLeft, type MapNode } from "../../../lib/line/lineMap";
import { lineTraceHref } from "../../../lib/line/lineMapUrl";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { DecisionCompactCard } from "../../decisions/DecisionCompactCard";
import { codecastEvalsPaths } from "../../evals/evalsPaths";
import { ExpectationsPanel } from "../expectations/ExpectationsPanel";
import { LineFinders } from "../settings/LineFinders";
import { ProfileFieldRow } from "../settings/ProfileFieldRow";
import { StationDefinition, StationHistory } from "../settings/LineStations";
import { useLineProfileEditor } from "../settings/useLineProfileEdits";
import { ChangeComposer } from "./ChangeComposer";
import { InlineEdit, LineValueRow } from "../settings/LineValueRow";
import { admissionHold } from "../../../lib/lineFlow";
import { useLineCauseActions } from "./useLineCause";
import type { useLineAdmission } from "./useLineAdmission";
import { edgeWords, throughWord } from "./LineMap";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { WHO_WORDS, gateAnswers, readableTemplate, stationPurpose, stationWho, type GraphEdgeIn, type GraphNodeIn } from "../../../lib/line/lineGraphs";
import { windowWords } from "../../../lib/line/lineMetricsWords";
import { sourceSentence } from "../../../lib/line/lineSources";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import "../settings/settings.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── what each node is ──

const END_WORDS: Record<string, string> = {
  held: "Shipped, and the watch ended without the problem coming back.",
  reopened: "The problem came back during the watch, so the cause opened again.",
  dissolved: "Closed without a change: the problem did not reproduce.",
  dropped: "Closed without a change, by a person's answer.",
  stopped: "The run ended without a change and without closing the cause: a refused decision, a failed ship, an eval that could not score, or a run that failed.",
};

/** The graph's own station for a map node, for its purpose and instructions. */
const graphNodeOf = (n: MapNode, stations?: PanelStations | null): GraphNodeIn => stations?.nodes.find((x) => x.id === n.id)
  ?? { id: n.id, label: n.label, type: n.who === "person" ? "human" : n.who === "script" ? "command" : "agent" };

export function nodeWhat(n: MapNode, projectId?: string | null, stations?: PanelStations | null, kinds: string[] = []): string {
  if (n.kind === "causes" && projectId === null) return "Open causes filed under no project. No line runs them until each is moved into a project.";
  if (n.kind === "expectations") return "What this project's agents should do, one cited line each. Finders that judge behavior grade against them.";
  if (n.kind === "source") return sourceSentence(n.source ?? n.label, n.finder, kinds);
  if (n.kind === "signals") return "Every signal any source reported. A signal that matches a problem already open joins it; anything new opens a problem of its own.";
  if (n.kind === "causes") return "Open problems waiting their turn, the most important first. While the line is switched on and has room, it starts the top one.";
  if (n.kind === "end") return END_WORDS[n.end ?? ""] ?? "";
  return stationPurpose(graphNodeOf(n, stations), stations?.edges ?? []) || stationWords(n.id) || "A step of this project's line.";
}

/** The profile values that shape each node, by node id or kind (LP2). */
const NODE_FIELDS: Record<string, string[]> = {
  // The slots that pace admission are the role's (Health's admission row), not the file's caps.cards, which the sweep does not read.
  causes: ["size_budget"],
  prove: ["commands.prove"],
  red: ["commands.prove"],
  implement: ["size_budget"],
  verify: ["commands.check"],
  green: ["commands.check"],
  eval: ["commands.eval"],
  review: ["principles", "prompting"],
  ship: ["commands.ship"],
  merge: ["commands.ship"],
  watch: ["watch_days"],
  "end:held": ["watch_days"],
  "end:reopened": ["watch_days"],
};
export const nodeFields = (id: string) => (NODE_FIELDS[id] ?? []).map((k) => LINE_FIELDS.find((f) => f.key === k)).filter((f): f is (typeof LINE_FIELDS)[number] => !!f);

const isStationKind = (n: MapNode) => n.kind === "station" || n.kind === "decide" || n.kind === "ship" || n.kind === "watch";

const ITEM_WORDS: Record<MapItem["kind"], string> = { signal: "signal", cause: "problem", run: "run", decision: "decision" };

const LEFT_WORDS: Record<MapLeft, string> = {
  moved: "went on", failed: "failed", live: "still here", held: "held", reopened: "reopened", dissolved: "dissolved", dropped: "dropped", stopped: "stopped", parked: "parked",
};

/** Where an item opens: its run, its card, else its cause. */
export function itemHref(item: MapItem): string | null {
  if (item.kind === "run" && item.runId) return runHref(item.runId);
  if (item.kind === "decision") return decisionHref({ _id: item.id, short_id: item.ref });
  if (item.taskId) return `/tasks/${item.taskId}`;
  return null;
}

export type PanelProps = {
  map: LineMap;
  node?: MapNode | null;
  edge?: MapEdge | null;
  projectId: string | null;
  flow: LineFlow;
  now: number;
  /** The ref the map is tracing, so its row reads as the one lit. */
  tracing: string | null;
  onTrace: (ref: string) => void;
  onSelectNode: (id: string) => void;
  onClose: () => void;
  /** Whether the line may start its next cause, and its controls (Causes' Health). */
  admit?: ReturnType<typeof useLineAdmission>;
  /** What each version of the project's line delivered, for a station's own history (LX3). */
  versions?: LineVersion[];
  /** The graph on show, with each station's instructions; `foreign` when it is not codecast's line (lineGraphs). */
  stations?: PanelStations | null;
  graphTitle?: string | null;
};

export type PanelStations = { nodes: GraphNodeIn[]; edges: GraphEdgeIn[]; foreign: boolean };

export function LineMapPanel(p: PanelProps) {
  const byId = useMemo(() => new Map(p.map.nodes.map((n) => [n.id, n])), [p.map.nodes]);
  if (p.edge) return <EdgePanel {...p} edge={p.edge} byId={byId} />;
  if (p.node) return <NodePanel {...p} node={p.node} />;
  return null;
}

function PanelFrame({ title, kicker, what, onClose, nav, children, foot, data }: { title: ReactNode; kicker?: ReactNode; what?: ReactNode; onClose: () => void; nav?: string[]; children: ReactNode; foot?: ReactNode; data: Record<string, string> }) {
  // The section strip tracks where the body is scrolled, so it says where you are.
  const body = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(nav?.[0] ?? null);
  // A picked tab jumps at once (smooth scrolling stalls in a background tab
  // and lags a click anywhere) and holds the highlight until the scroll lands
  // where the jump aimed, so neither the spy's first pass nor a short last
  // section reached at the bottom takes the highlight from the one picked.
  // A scroll that lands anywhere else is the viewer's own, and the spy resumes.
  const picked = useRef<number | null>(null);
  useWatchEffect(() => {
    const el = body.current;
    if (!el || !nav?.length) return;
    const spy = () => {
      if (picked.current != null) {
        const landed = Math.abs(el.scrollTop - picked.current) <= 2;
        picked.current = null;
        if (landed) return;
      }
      // The section whose top is nearest the body's top edge from above (or
      // the first, before any has reached it) is the one being read.
      const top = el.getBoundingClientRect().top + 32;
      let at = nav[0];
      let best = -Infinity;
      for (const s of nav) {
        const t = el.querySelector<HTMLElement>(`#lmap-${s.toLowerCase()}`)?.getBoundingClientRect().top;
        // Strictly nearer only: sections stacked at one top go to the first of them.
        if (t != null && t <= top && t > best) { best = t; at = s; }
      }
      // Scrolled to the end by the viewer: a short last section can never reach
      // the top, so the bottom stands for it. A body too short to scroll sits at
      // its end from the start, and there the first section still leads.
      if (el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) at = nav[nav.length - 1];
      setActive((a) => (a === at ? a : at));
    };
    spy();
    el.addEventListener("scroll", spy, { passive: true });
    return () => el.removeEventListener("scroll", spy);
  }, [nav]);
  return (
    <aside className="lmap-panel" aria-label="Details" {...data}>
      <div className="lmap-panel-head">
        <div className="lmap-panel-title">
          <h2>{title}</h2>
          {kicker}
          <button type="button" onClick={onClose} className="ml-auto shrink-0 inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text" aria-label="Close the panel" data-map-panel-close>
            <KeyCap size="xs">Esc</KeyCap><X className="w-3.5 h-3.5" />
          </button>
        </div>
        {what && <p className="lmap-panel-what">{what}</p>}
      </div>
      {nav && (
        <nav className="lmap-panel-nav" aria-label="Sections">
          {nav.map((s) => (
            <a
              key={s}
              href={`#lmap-${s.toLowerCase()}`}
              aria-current={active === s ? "true" : undefined}
              data-map-nav={s.toLowerCase()}
              onClick={(e) => {
                e.preventDefault();
                const sec = body.current?.querySelector<HTMLElement>(`#lmap-${s.toLowerCase()}`);
                // Rects, not offsetTop: the body is not the sections' offset parent.
                const el = body.current;
                if (sec && el) {
                  const top = Math.round(Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + sec.getBoundingClientRect().top - el.getBoundingClientRect().top - 4)));
                  // Already there: no scroll event will come, so nothing to hold for.
                  picked.current = Math.abs(top - el.scrollTop) > 2 ? top : null;
                  el.scrollTo({ top, behavior: "auto" });
                }
                setActive(s);
              }}
            >{NAV_LABEL[s] ?? s}</a>
          ))}
        </nav>
      )}
      <div ref={body} className="lmap-panel-body">{children}</div>
      {foot}
    </aside>
  );
}

/** `hideTitle`: the tab strip already names the section (Now leads the body), so its heading is for screen readers only. */
function Section({ id, title, aside, hideTitle, children }: { id: string; title: string; aside?: ReactNode; hideTitle?: boolean; children: ReactNode }) {
  return (
    <section id={`lmap-${id}`} className="lmap-sec" data-map-section={id}>
      <h3 className={hideTitle ? "sr-only" : "lmap-sec-title"}>{title}{aside && <small>{aside}</small>}</h3>
      {children}
    </section>
  );
}

// ── a node ──

/** Lists in the panel show this many rows, then "Show all". */
const ROWS_SHOWN = 8;

function NodePanel({ map, node: n, projectId, flow, now, tracing, onTrace, onClose, admit, versions, stations, graphTitle }: PanelProps & { node: MapNode }) {
  const asks = n.id === CARD_GATE_NODE_ID ? flow.awaiting.items : [];
  const label = map.window.label;
  // A source never holds work, so its panel opens on what it filed (LX3).
  const holdsNothing = n.kind === "source";
  return (
    <PanelFrame
      // The graph file names the step its own way ("Stamp"); the panel says both, so the file reads alongside the map.
      title={<>{n.label}{n.fileLabel && <span className="lmap-panel-file" title={`The graph file calls this step "${n.fileLabel}"`} data-map-file-label> {n.fileLabel} in the file</span>}</>}
      kicker={<span className="lmap-chip" data-tone={n.who === "person" ? "ask" : "muted"} data-map-who={n.who}>{kindWords(n)}</span>}
      what={nodeWhat(n, projectId, stations, n.kind === "source" ? flow.sense.items.find((s) => s.source.toLowerCase() === n.source?.toLowerCase())?.kinds : [])}
      onClose={onClose}
      nav={holdsNothing ? NODE_NAV_PASSING : NODE_NAV}
      foot={<AskBar node={n} projectId={projectId} />}
      data={{ "data-map-panel": n.id }}
    >
      {!holdsNothing && <Section id="now" title="Now" hideTitle>
        {asks.length > 0 && (
          <div className="space-y-2 mb-2" data-map-cards>
            {asks.map((d, i) => (
              <div key={d._id} className="line-card rounded-lg">
                <DecisionCompactCard decision={d as SessionDecisionItem} keys={i === 0} line folded={i > 0} />
              </div>
            ))}
          </div>
        )}
        {n.now.length > 0
          ? <Items items={n.now} node={n} now={now} tracing={tracing} onTrace={onTrace} ageWord="here" act={n.kind === "causes" && !projectId ? (it) => <MoveToProject item={it} /> : undefined} />
          : asks.length === 0 && <p className="lmap-empty">{emptyNow(n)}</p>}
      </Section>}

      <Section id="through" title="Recent" aside={windowWords(label)}>
        <Through node={n} map={map} now={now} tracing={tracing} onTrace={onTrace} />
      </Section>

      <Section id="health" title="Health">
        <Health node={n} label={label} sense={n.kind === "source" ? flow.sense.items.find((s) => s.source.toLowerCase() === n.source?.toLowerCase()) : undefined} now={now} />
        {n.kind === "causes" && flow.causes.hold?.top && <StartTopCause row={flow.causes.hold.top} projectId={projectId} />}
        {n.kind === "causes" && admit?.admission && !admit.admission.noProject && <AdmissionRow admit={admit} hold={flow.causes.hold} />}
      </Section>

      <Section id="definition" title="How it works">
        <Definition node={n} projectId={projectId} flow={flow} now={now} versions={versions} stations={stations} graphTitle={graphTitle} />
      </Section>
    </PanelFrame>
  );
}

const NODE_NAV = ["Now", "Through", "Health", "Definition"];
/** What the tabs say; their ids stay the sections' own. */
const NAV_LABEL: Record<string, string> = { Through: "Recent", Definition: "How it works" };
const NODE_NAV_PASSING = NODE_NAV.slice(1);

/** The panel's footer, always in view: one line that opens the composer
 *  asking an agent for a change to this node (LX6). Esc folds it back. Work
 *  under no project runs the shipped line, which nobody edits, so there the
 *  footer asks which project's line to change, and the composer opens for it. */
function AskBar({ node: n, projectId: own }: { node: MapNode; projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  useWatchEffect(() => setOpen(false), [n.id]);
  const projectId = own ?? picked;
  const pickedTitle = useProjectTitle(own ? null : picked);
  return (
    <div
      className="lmap-ask"
      data-open={open ? "true" : undefined}
      data-map-ask={n.id}
      onKeyDown={(e) => {
        // The composer clears its words on the first Esc; the next folds it here, not the panel.
        if (e.key === "Escape" && open && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      }}
    >
      {open ? (
        <>
          <div className="lmap-ask-head">
            <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 truncate">Ask for a change to {n.label}{pickedTitle ? ` on ${pickedTitle}'s line` : ""}</span>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto text-sol-text-dim hover:text-sol-text" aria-label="Fold the composer"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="lmap-ask-body"><ChangeComposer node={n} projectId={projectId} autoFocus /></div>
        </>
      ) : own ? (
        <button type="button" className="lmap-ask-bar" onClick={() => setOpen(true)} data-map-ask-open title="An agent works it through the line and brings you a card">
          <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Ask for a change to {n.label}...</span>
        </button>
      ) : (
        <AskProjectPick className="lmap-ask-bar lmap-ask-pick" icon value={picked} onChange={(id) => { setPicked(id); if (id) setOpen(true); }} />
      )}
    </div>
  );
}

/** A project's title from the store, for a composer opened on a picked project. */
export function useProjectTitle(id: string | null): string | null {
  const projects = useWorkspaceCollection<LineProject>("projects", projectSig);
  return id ? projects.find((p) => p._id === id)?.title ?? null : null;
}

/** The workspace's projects by title, for every picker on the map. */
function useSortedProjects(): LineProject[] {
  const projects = useWorkspaceCollection<LineProject>("projects", projectSig);
  return useMemo(() => [...projects].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")), [projects]);
}

/** Whose line a change is asked for when the map shows work under no project
 *  (LX6): the workspace's projects as a select. With no project yet there is
 *  no line to change, so it says where lines come from instead of offering
 *  an empty list. Shared by the panel's footer and the map's Ask popover. */
export function AskProjectPick({ value, onChange, className, icon }: { value: string | null; onChange: (id: string | null) => void; className?: string; icon?: boolean }) {
  const sorted = useSortedProjects();
  const mark = icon ? <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" /> : null;
  if (!sorted.length) {
    return (
      <p className={className} data-map-ask-pick="none">
        {mark}<span className="min-w-0 truncate">Lines belong to projects. <Link href="/projects" className="text-sol-blue hover:underline">Create one</Link></span>
      </p>
    );
  }
  return (
    <label className={className} data-map-ask-pick title="Work under no project runs the shipped line. Each project changes its own copy">
      {mark}
      <span className="shrink-0">Change the line for:</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="min-w-0 flex-1 truncate bg-transparent text-sol-text outline-none cursor-pointer" data-map-ask-project>
        <option value="">a project</option>
        {sorted.map((p) => <option key={p._id} value={p._id}>{p.title ?? p.short_id ?? p._id}</option>)}
      </select>
    </label>
  );
}

/** A cause filed under no project, moved into one through the task edit
 *  every task surface uses (updateTask), so its project's line can run it.
 *  The row leaves this queue the moment the store takes the edit. */
function MoveToProject({ item }: { item: MapItem }) {
  const sorted = useSortedProjects();
  if (!sorted.length || item.kind !== "cause") return null;
  return (
    <label className="lmap-move" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} title="Move this cause into a project, so that project's line runs it" data-map-move={item.ref}>
      move to project
      <select
        value=""
        aria-label={`Move ${item.title} to a project`}
        onChange={(e) => { const id = e.target.value; if (id) void useInboxStore.getState().updateTask(item.ref, { project_id: id }); }}
      >
        <option value="">Move to project</option>
        {sorted.map((p) => <option key={p._id} value={p._id}>{p.title ?? p.short_id ?? p._id}</option>)}
      </select>
    </label>
  );
}

function kindWords(n: MapNode): string {
  if (n.kind === "source") return "source";
  if (n.kind === "end") return "where runs end";
  if (n.kind === "expectations" || n.kind === "signals" || n.kind === "causes") return "intake";
  if (n.who === "person") return "you decide here";
  return n.who ? `done by ${WHO_WORDS[n.who].toLowerCase()}` : "step";
}

function emptyNow(n: MapNode): string {
  if (n.kind === "expectations") return "Expectations hold no work. Finders that judge behavior grade against them; Definition lists them.";
  if (n.kind === "signals") return "Signals do not wait here; they pass straight on.";
  if (n.kind === "end") return "An end holds nothing; Through lists what ended here.";
  if (n.kind === "causes") return "No cause waits to be built.";
  return "Nothing is at this step now.";
}

/** The item kind a node holds, which its rows leave unsaid (every row at Causes is a cause). */
const NODE_ITEM: Partial<Record<MapNode["kind"], MapItem["kind"]>> = { causes: "cause", signals: "signal", source: "signal", station: "run", ship: "run", watch: "cause" };

/** A trailing machine number on a title ("e2e keyless sink error 1791140327"):
 *  a timestamp that sets test rows apart without meaning anything, so it goes,
 *  and the rows it alone told apart merge into one with a count. */
export const plainTitle = (t: string) => t.replace(/\s+\d{10,13}\s*$/, "").trim() || t.trim();

/** A title's leading label ("Eval newly red: callActions..."), when it has one. */
const LEAD = /^(?:([A-Z][^:]{2,40}):|\[([^\]]{2,40})\])\s+(\S.*)$/;
/** A title's lead label and the words after it ("[identity] X" reads as label "identity"). */
const leadOf = (t: string): { label: string; rest: string } | null => {
  const m = t.match(LEAD);
  return m ? { label: m[1] ?? m[2], rest: m[3] } : null;
};

/** A test run's signal: a test tag ("[test] ...", "[e2e] ...") or an e2e lead
 *  ("e2e ..."). Other bracketed tags name a component ("[identity] ...") and
 *  group as a label instead (LEAD). */
const TEST_PREFIX = /^(?:\[(?:tests?|e2e|smoke)\]|e2e\b)[\s:_-]*/i;
const visible = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "").length;

/** A row's words: a test prefix dropped (its group heading says it), and a
 *  title cut to almost nothing ('InjectionError: "') read as its kind and
 *  where it came from instead ("InjectionError from sdk:e2e-sdk"). */
export function rowTitle(it: Pick<MapItem, "title" | "kind" | "source" | "signalKind">, testing = false): string {
  const t = testing ? it.title.replace(TEST_PREFIX, "").trim() || it.title : it.title;
  const loose = t.match(/^(\S{2,40}?):\s*(.*)$/);
  const m = leadOf(t) ?? (loose ? { label: loose[1], rest: loose[2] } : null);
  if (visible(t) >= 4 && !(m && visible(m.rest) < 4)) return t;
  const what = (m && visible(m.label) >= 2 ? m.label : null) ?? it.signalKind ?? ITEM_WORDS[it.kind];
  return it.source ? `${what} from ${it.source}` : what;
}

/** The kind most rows are, which their rows leave unsaid; a tie goes to the
 *  kind the node holds (every row at Causes is a cause). */
function dominantKind(items: MapItem[], implied?: MapItem["kind"]): MapItem["kind"] | undefined {
  const counts = new Map<MapItem["kind"], number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  let best: MapItem["kind"] | undefined;
  for (const [k, c] of counts) if (!best || c > counts.get(best)! || (c === counts.get(best) && k === implied)) best = k;
  return best ?? implied;
}

/** Rows the panel lists: each opens its path on the map (click or return),
 *  its title gets two lines at the list's full width, and trace and open show
 *  on hover or focus. An age reads once above each run of rows that share it
 *  (once for the list when all do), or right-aligned on a row whose age
 *  differs from the row above when runs are short; repeats of one title merge with a count; a label most titles
 *  open with becomes a group of its own, after the rows without it, so each
 *  row spends its lines on what sets it apart; and only the minority kind is tagged. */
function Items({ items: raw, node, now, tracing, onTrace, ageWord, right, rowAges, act }: {
  items: MapItem[]; node?: MapNode; now: number; tracing: string | null; onTrace: (ref: string) => void; ageWord?: string; right?: (it: MapItem) => ReactNode;
  /** One more action beside trace and open on each row (Move to project, under no project). */
  act?: (it: MapItem) => ReactNode;
  /** Every row says its own age, right-aligned and muted, with no age lines between rows (Through). */
  rowAges?: boolean;
}) {
  const given = useMemo(() => raw.map((it) => { const t = plainTitle(it.title); return t === it.title ? it : { ...it, title: t }; }), [raw]);
  const [all, setAll] = useState(false);
  // Per-visit words (right) differ row to row, so only plain lists merge.
  const { items, repeats } = useMemo(() => {
    if (right) return { items: given, repeats: new Map<MapItem, number>() };
    const first = new Map<string, MapItem>();
    const repeats = new Map<MapItem, number>();
    const out: MapItem[] = [];
    for (const it of given) {
      const k = `${it.kind}|${it.title}`;
      const seen = first.get(k);
      if (seen) { repeats.set(seen, (repeats.get(seen) ?? 1) + 1); continue; }
      first.set(k, it);
      out.push(it);
    }
    return { items: out, repeats };
  }, [given, right]);
  const implied = dominantKind(items, node ? NODE_ITEM[node.kind] : undefined);
  // Test runs' signals (two or more, beside real ones) fold into a muted group
  // at the end, closed until asked, so real causes lead the list.
  const { real, tests } = useMemo(() => {
    const tests = items.filter((it) => TEST_PREFIX.test(it.title));
    return tests.length >= 2 && tests.length < items.length ? { real: items.filter((it) => !TEST_PREFIX.test(it.title)), tests } : { real: items, tests: [] as MapItem[] };
  }, [items]);
  const [testsOpen, setTestsOpen] = useState(false);
  // A label at least three rows and a quarter of the list open with groups them, after the rest.
  const { lead, ordered } = useMemo(() => {
    const items = real;
    const counts = new Map<string, number>();
    for (const it of items) { const m = leadOf(it.title); if (m) counts.set(m.label, (counts.get(m.label) ?? 0) + 1); }
    const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (!best || n < 3 || n * 4 < items.length) return { lead: null, ordered: items };
    const has = (it: MapItem) => leadOf(it.title)?.label === best;
    // The larger group leads, so the list opens on a named group when it is most of the rows.
    const first = n >= items.length - n;
    return { lead: { label: best, n, rest: items.length - n, first }, ordered: first ? [...items.filter(has), ...items.filter((it) => !has(it))] : [...items.filter((it) => !has(it)), ...items.filter(has)] };
  }, [real]);
  const shown = all ? ordered : ordered.slice(0, ROWS_SHOWN);
  const inLead = (it: MapItem) => !!lead && leadOf(it.title)?.label === lead.label;
  const titleOf = (it: MapItem) => (inLead(it) ? rowTitle({ ...it, title: leadOf(it.title)!.rest }) : rowTitle(it, tests.includes(it)));
  const age = (it: MapItem) => `${ageShort(Math.max(0, now - it.at))}${ageWord ? ` ${ageWord}` : " ago"}`;
  // One age for every row reads once above the list; runs of equal ages read
  // once above each run when runs are long enough to save lines; else a row
  // shows its age only where it differs from the row above.
  const ages = right ? [] : shown.map(age);
  const sameAge = !right && !rowAges && shown.length > 1 && new Set(ages).size === 1;
  const runs = ages.filter((a, i) => i === 0 || a !== ages[i - 1]).length;
  const runLines = !right && !rowAges && !sameAge && runs * 2 <= shown.length;
  // Stuck on every row says nothing a row needs: the line above says it once,
  // against the usual time the node's mark and Health read too.
  const allStuck = shown.length > 1 && shown.every((it) => it.stuck);
  // The rows' own noun, for the headings and the warning ("Other causes", "runs usually leave").
  const noun = `${ITEM_WORDS[implied ?? "cause"]}s`;
  const usual = allStuck && node ? usualStay(node, noun) : null;
  // Every row stuck reads as one sentence that matches the node's mark: the oldest age, and the usual stay.
  const oldest = given.length ? Math.max(0, now - Math.min(...given.map((it) => it.at))) : 0;
  // One line before the rows: the oldest against the usual stay when every row
  // is stuck, else the shared age.
  const above = usual ? `Oldest ${ageShort(oldest)}; ${usual}` : sameAge ? age(shown[0]) : null;
  const total = given.length;
  /** One row; `ownAge` gives it its age on the right (the test group's rows, outside the age runs). */
  const row = (it: MapItem, i: number, ownAge?: string) => {
    const href = itemHref(it);
    const times = repeats.get(it) ?? 1;
    const title = titleOf(it);
    const newAge = !right && !sameAge && (i === 0 || ages[i] !== ages[i - 1]);
    return (
    <div
      role="button"
      tabIndex={0}
      className="lmap-item"
      data-active={tracing === it.ref ? "true" : undefined}
      onClick={() => onTrace(it.ref)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTrace(it.ref); } }}
      title={title === it.title ? "Draw its path on the map" : it.title}
      data-map-item={it.ref}
    >
      <span className="lmap-item-title">{title}{times > 1 && <span className="lmap-item-count" title={`${times} with this title; the newest is drawn`} data-map-item-repeats={times}>x{times}</span>}</span>
      <span className="lmap-item-meta">
        <span className="lmap-item-acts">
          <Link href={lineTraceHref(it.ref)} onClick={(e) => e.stopPropagation()} data-map-trace-link title="Every step it took, from the first signal on">trace</Link>
          {href && <Link href={href} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5">open<ArrowUpRight className="w-3 h-3" /></Link>}
          {act?.(it)}
        </span>
        {ownAge ? <span data-map-item-age>{ownAge}</span> : rowAges || (!runLines && newAge) ? <span data-map-item-age>{ages[i]}</span> : null}
      </span>
      {(right || it.kind !== implied || (it.stuck && !allStuck) || it.stalled) && (
        <span className="lmap-item-sub">
          {/* Longer words (where it went and how long it stayed) read under the title. */}
          {right && <span className="text-sol-text-muted">{right(it)}</span>}
          {it.kind !== implied && <span>{ITEM_WORDS[it.kind]}</span>}
          {it.stuck && !allStuck && <span className="lmap-chip" data-tone="warn">stuck</span>}
          {it.stalled && <span className="lmap-chip" data-tone="warn">silent a day</span>}
        </span>
      )}
    </div>
    );
  };
  return (
    <>
      {above && <div className="lmap-item-age" data-map-age data-warn={allStuck ? "true" : undefined}>{above}</div>}
      <ul className="lmap-items" data-map-items>
        {shown.map((it, i) => {
          // The group headings: the rows without the label first, then the label's group.
          // The unlabeled rows leading the list need no heading; the label's group below names itself.
          const heading = lead && (i === 0 ? inLead(it) : inLead(shown[i - 1]) !== inLead(it))
            ? (inLead(it) ? <>{lead.label}<span>, {lead.n}</span></> : <>Other {noun}<span>, {lead.rest}</span></>)
            : null;
          const newAge = !right && !sameAge && (i === 0 || ages[i] !== ages[i - 1]);
          // The line above already names the oldest age; the first run does not repeat it.
          const ageLine = runLines && newAge && !(i === 0 && usual && ageShort(Math.max(0, now - it.at)) === ageShort(oldest));
          return (
            <li key={`${it.kind}:${it.id}:${i}`} className="contents">
              {heading && <div className="lmap-items-prefix" data-map-items-prefix={inLead(it) ? lead!.label : "others"}>{heading}</div>}
              {ageLine && <div className="lmap-item-age" data-map-age-run>{ages[i]}</div>}
              {row(it, i)}
            </li>
          );
        })}
        {tests.length > 0 && (
          <li className="contents">
            <button type="button" className="lmap-items-prefix lmap-items-tests" onClick={() => setTestsOpen((o) => !o)} aria-expanded={testsOpen} data-map-items-tests={tests.length}>
              <ChevronRight className={testsOpen ? "w-3 h-3 rotate-90" : "w-3 h-3"} aria-hidden /><span className="text-inherit">Test signals<span>, {tests.length}</span></span>
            </button>
            {testsOpen && tests.map((it, i) => <Fragment key={`test:${it.kind}:${it.id}`}>{row(it, -1 - i, age(it))}</Fragment>)}
          </li>
        )}
      </ul>
      {real.length > ROWS_SHOWN && (
        <button type="button" className="lmap-more" onClick={() => setAll((v) => !v)} data-map-show-all={total}>
          {all ? "Show fewer" : `Show all ${total - tests.length}`}
        </button>
      )}
    </>
  );
}

/** What passed in the window: a station's visits with how each left, or what crossed into any other node. */
function Through({ node: n, map, now, tracing, onTrace }: { node: MapNode; map: LineMap; now: number; tracing: string | null; onTrace: (ref: string) => void }) {
  const crossedIn = useMemo(() => {
    if (n.passed.length) return [];
    const seen = new Set<string>();
    const out: MapItem[] = [];
    // A source has nothing flowing in: what passed is what it filed onward.
    const source = n.kind === "source";
    for (const e of map.edges) if (source ? e.from === n.id : e.to === n.id) for (const it of e.items) {
      const k = `${it.kind}:${it.id}`;
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [map.edges, n]);
  const byId = useMemo(() => new Map(map.nodes.map((x) => [x.id, x.label])), [map.nodes]);
  if (n.passed.length) {
    const tally = new Map<MapLeft, number>();
    for (const v of n.passed) tally.set(v.left, (tally.get(v.left) ?? 0) + 1);
    const items = n.passed.map((v) => ({ ...v.item, at: v.at }));
    const visit = new Map(n.passed.map((v, i) => [i, v]));
    return (
      <>
        <div className="lmap-left-bar" role="img" aria-label={[...tally].map(([k, c]) => `${c} ${LEFT_WORDS[k]}`).join(", ")}>
          {[...tally].map(([k, c]) => <span key={k} data-left={k} style={{ flex: c }} title={`${c} ${LEFT_WORDS[k]}`} />)}
        </div>
        <p className="lmap-empty mb-1" data-map-passed-words>{passedWords(n, map, byId)}</p>
        <ItemsWithIndex items={items} node={n} now={now} tracing={tracing} onTrace={onTrace} right={(i) => {
          const v = visit.get(i)!;
          const where = v.to && v.left === "moved" ? `to ${byId.get(v.to) ?? v.to}` : LEFT_WORDS[v.left];
          return <>{where}{v.durationMs != null ? `, ${v.durationMs < 60_000 ? "under a minute" : ageShort(v.durationMs)}` : ""}</>;
        }} />
      </>
    );
  }
  if (!crossedIn.length) return <p className="lmap-empty">Nothing passed through in the last {map.window.label}.</p>;
  return <Items items={crossedIn} node={n} now={now} tracing={tracing} onTrace={onTrace} rowAges />;
}

/** Items whose right-hand words depend on their place in the list. */
function ItemsWithIndex({ items, right, ...rest }: { items: MapItem[]; node?: MapNode; now: number; tracing: string | null; onTrace: (ref: string) => void; right: (i: number) => ReactNode }) {
  const idx = new Map(items.map((it, i) => [it, i]));
  return <Items items={items} {...rest} right={(it) => right(idx.get(it)!)} />;
}

function Health({ node: n, label, sense, now }: { node: MapNode; label: string; sense?: SenseSource; now: number }) {
  const stats: Array<{ v: string; k: string; warn?: boolean }> = [];
  if (n.kind !== "source" && n.kind !== "expectations" && n.kind !== "signals" && n.kind !== "end") stats.push({ v: String(n.now.length), k: "here now" });
  stats.push({ v: String(n.through), k: `${throughWord(n)} in ${label}` });
  if (n.medianMs != null) stats.push({ v: n.medianMs < 60_000 ? "<1m" : ageShort(n.medianMs), k: n.kind === "causes" ? "usual wait" : "usual time here" });
  const oldest = n.now[0];
  if (oldest && n.kind !== "end") stats.push({ v: ageShort(Math.max(0, now - oldest.at)), k: "oldest here", warn: n.now.some((it) => it.stuck) });
  if (isStationKind(n) && n.through > 0) stats.push({ v: `${Math.round((n.failed / n.through) * 100)}%`, k: "failed" });
  if (sense) stats.push({ v: sense.newest ? `${ageShort(now - sense.newest.created_at)} ago` : "never", k: "last signal" });
  return (
    <div className="lmap-health" data-map-health>
      {n.marks.length
        ? n.marks.map((m) => <p key={m.words} className="lmap-health-words" data-level={m.level}>{m.words}.</p>)
        : <p className="lmap-health-words">{healthyWords(n, label)}</p>}
      <div className="lmap-stats">
        {stats.map((s) => <div key={s.k} className="lmap-stat" data-warn={s.warn ? "true" : undefined}><b>{s.v}</b><span>{s.k}</span></div>)}
      </div>
    </div>
  );
}

function healthyWords(n: MapNode, label: string): string {
  if (n.through === 0 && n.now.length === 0) return `Quiet: nothing reached it in the last ${label}.`;
  if (n.kind === "source") return "Healthy: it is reporting as usual.";
  if (n.kind === "end") return `${n.through} ended here in the last ${label}.`;
  return `Nothing wrong in the last ${label}.`;
}

/** What shapes the node, edited in place: finder declarations, a station's prompt, script and timeout, the profile values it reads, the expectations. */
function Definition({ node: n, projectId, flow, now, versions, stations, graphTitle }: { node: MapNode; projectId: string | null; flow: LineFlow; now: number; versions?: LineVersion[]; stations?: PanelStations | null; graphTitle?: string | null }) {
  if (!projectId) return <p className="lmap-empty">This map draws codecast's line. Problems filed under no project have no settings and nothing runs them: move a problem into a project to run it through that project's line.</p>;
  if (n.kind === "expectations") return <ExpectationsPanel projectId={projectId} scroll={false} />;
  if (stations?.foreign && isStationKind(n)) return <StationInstructions node={graphNodeOf(n, stations)} stations={stations} graphTitle={graphTitle ?? "this line"} />;
  return (
    <div className="flex flex-col gap-3">
      {n.who === "person" && <GateAnswers answers={gateAnswers(n.id, stations?.edges ?? [])} />}
      {isStationKind(n) && <StationDefinition projectId={projectId} stationId={n.id} />}
      {isStationKind(n) && versions && <StationHistory history={stationHistory(versions, n.id)} />}
      <ProfileValues node={n} projectId={projectId} flow={flow} now={now} />
      {n.kind === "source" && n.source?.toLowerCase() === "evals" && (
        <Link href={codecastEvalsPaths.senseHref(flow.sense.items.find((s) => s.source === "evals")?.newest?.subject)} className="text-[12px] text-sol-blue hover:underline" data-map-evals-link>Read its drops in Evals</Link>
      )}
    </div>
  );
}

/** A line nothing published: every value reads as its default (lineValue). */
const DEFAULTS_ONLY: PublishedLineProfile = { finders: [], changed_at: 0 };

function ProfileValues({ node: n, projectId, flow, now }: { node: MapNode; projectId: string; flow: LineFlow; now: number }) {
  const { edits, gate, device } = useLineProfileEditor(projectId);
  const lp = edits.lp ?? DEFAULTS_ONLY;
  const fields = nodeFields(n.id);
  const finders = n.kind === "source" || n.kind === "signals";
  if (!fields.length && !finders) return null;
  const first = gate.writable && gate.first;
  const shown = n.kind === "source" ? { ...lp, finders: lp.finders.filter((f) => f.source.toLowerCase() === n.source?.toLowerCase()) } : lp;
  const sense = n.kind === "source" ? flow.sense.items.filter((s) => s.source.toLowerCase() === n.source?.toLowerCase()) : flow.sense.items;
  return (
    <div className="flex flex-col gap-1" data-map-values>
      {first && <p className="lmap-empty" data-map-defaults>These are the defaults. Your first edit writes <code>{gate.file}</code> on {device} and publishes this line.</p>}
      {!gate.writable && <p className="lmap-empty">Read only. {gate.reason}</p>}
      {finders && <LineFinders lp={shown} sense={sense} now={now} writable={gate.writable} states={edits.states} device={device} send={edits.send} clear={edits.clear} />}
      {fields.length > 0 && (
        <div className="lset-rows">
          {fields.map((f) => <ProfileFieldRow key={f.key} field={f} lp={lp} writable={gate.writable} states={edits.states} device={device} now={edits.now} send={edits.send} clear={edits.clear} />)}
        </div>
      )}
    </div>
  );
}

/** The switch and the slots that decide whether the line starts its next
 *  cause (LE6), edited where the queue says why nothing starts (LX5). They
 *  belong to the role that starts the project's line, so an edit goes to the
 *  role (updateOrgRole) and paints at once from the org tree. */
/** The way out when the sweep is not starting a ready cause (LE6, LX3): the
 *  top one started by hand, the same start "Start now" on a cause makes. */
function StartTopCause({ row, projectId }: { row: CauseRow; projectId: string | null }) {
  const { start, error } = useLineCauseActions(projectId);
  const [sent, setSent] = useState(false);
  const ref = row.task.short_id ?? row.task._id;
  return (
    <div className="lmap-start-top" data-map-start-top={ref}>
      <button type="button" className="lmap-start-top-button" disabled={sent && !error} onClick={() => { setSent(true); start(row.task._id); }} data-map-start-top-button>
        {sent && !error ? "Starting the top problem" : "Start the top problem"}
      </button>
      <Link href={lineTraceHref(ref)} className="min-w-0 truncate text-sol-text-dim hover:text-sol-text" title={row.task.title}>{row.task.title}</Link>
      {error && <p className="lmap-start-top-error" role="alert">{error}</p>}
    </div>
  );
}

function AdmissionRow({ admit, hold: queueHold }: { admit: NonNullable<PanelProps["admit"]>; hold: LineFlow["causes"]["hold"] }) {
  const a = admit.admission!;
  // The queue's own hold when causes wait (a stall included), else the switch and the caps alone.
  const hold = queueHold ?? admissionHold(a);
  if (!a.role) {
    return (
      <div className="lset-rows mt-2" data-map-admission="none">
        <p className="lmap-empty">No role looks after this project, so the line never starts a cause on its own. A role takes the project into its area on its page in <Link href="/org" className="underline underline-offset-2">the org</Link>.</p>
      </div>
    );
  }
  const busy = a.busy != null ? `${a.busy} of ${a.slots} busy now` : null;
  const commit = (text: string) => {
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 1 || n > 50) return "A whole number from 1 to 50";
    if (n !== a.slots) admit.setSlots(n);
    return null;
  };
  return (
    <div className="lset-rows mt-2" data-map-admission={a.on ? "on" : "off"}>
      <LineValueRow
        label="Admission"
        what={`@${a.role.handle} starts the top cause while a slot is free. Each run holds a slot until you decide on its fix.`}
        note={a.role.paused ? `@${a.role.handle} is paused; nothing starts until it resumes.` : null}
        status={hold && !a.role.paused && a.on ? <span className="lset-status" data-state="warn" role="status">{hold.short}</span> : busy && a.on ? <span className="lset-status" data-state="saved">{busy}</span> : null}
      >
        <button
          type="button"
          role="switch"
          aria-checked={a.on}
          className="lset-value"
          onClick={() => admit.setOn(!a.on)}
          title={a.on ? "Stop starting problems on its own" : "Start problems on its own"}
          data-map-admission-switch
        >{a.sweepOff ? (a.on ? "on, but starting is off everywhere" : "off") : a.on ? "on" : "off"}</button>
        {a.on && !a.sweepOff && (
          <>
            <span className="lset-unit">up to</span>
            <InlineEdit text={String(a.slots)} label="Admission slots" onCommit={commit} display={<span data-map-admission-slots>{a.slots}</span>} />
            <span className="lset-unit">at a time</span>
          </>
        )}
      </LineValueRow>
      {a.sweepOff && (
        <p className="lmap-empty break-words" data-map-sweep-off>
          Automatic starting is switched off in codecast itself for every line, so nothing starts on its own whatever this switch says. Until it is switched back on, start a problem by hand from its row under Causes.
        </p>
      )}
    </div>
  );
}

// ── an edge ──

function EdgePanel({ map, edge: e, byId, now, tracing, onTrace, onSelectNode, onClose }: PanelProps & { edge: MapEdge; byId: Map<string, MapNode> }) {
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  const items = [...e.items].sort((a, b) => b.at - a.at);
  return (
    <PanelFrame
      title={<>{from?.label ?? e.from} <span className="text-sol-text-dim">{e.kind === "loop" ? "back to" : "to"}</span> {to?.label ?? e.to}</>}
      kicker={<span className="lmap-chip" data-tone="muted">{e.kind === "loop" ? "loop" : e.kind}</span>}
      what={edgeWords(e, byId)}
      onClose={onClose}
      data={{ "data-map-panel": e.id }}
    >
      <div className="flex gap-3 pt-3 text-[12px]">
        {from && <button type="button" className="text-sol-text-dim hover:text-sol-text" onClick={() => onSelectNode(from.id)}>From <span className="text-sol-blue">{from.label}</span></button>}
        {to && <button type="button" className="text-sol-text-dim hover:text-sol-text" onClick={() => onSelectNode(to.id)}>To <span className="text-sol-blue">{to.label}</span></button>}
      </div>
      <Section id="crossed" title="Crossed" aside={`${plural(e.count, "crossing")} in the last ${map.window.label}`}>
        {items.length ? <Items items={items} now={now} tracing={tracing} onTrace={onTrace} /> : <p className="lmap-empty">Nothing crossed in the last {map.window.label}.</p>}
      </Section>
    </PanelFrame>
  );
}

/** What passed a station in the window, in one sentence: how many, and where
 *  they went ("10 passed this step in the last 30 days, all went on to Analyze"). */
export function passedWords(n: MapNode, map: LineMap, byId: Map<string, string>): string {
  const total = n.passed.length;
  const head = `${total} ${total === 1 ? "run" : "runs"} passed this step in ${windowWords(map.window.label)}`;
  const parts = new Map<string, number>();
  for (const v of n.passed) {
    const key = v.left === "moved" && v.to ? `went on to ${byId.get(v.to) ?? v.to}` : v.left === "live" ? "are still here" : `${LEFT_WORDS[v.left]}`;
    parts.set(key, (parts.get(key) ?? 0) + 1);
  }
  const ranked = [...parts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1) return `${head}, ${total === 1 ? "and it" : "all"} ${ranked[0][0].replace(/^are /, total === 1 ? "is " : "are ")}.`;
  return `${head}: ${ranked.map(([k, c]) => `${c} ${k.replace(/^are /, c === 1 ? "is " : "are ")}`).join(", ")}.`;
}

/** A station of a graph that is not codecast's line: who does it and its
 *  instructions in full, read only, since the graph lives in its project's
 *  repo and changes there. */
function StationInstructions({ node, stations, graphTitle }: { node: GraphNodeIn; stations: PanelStations; graphTitle: string }) {
  const prompt = typeof node.prompt === "string" ? readableTemplate(node.prompt.trim(), stations.nodes) : "";
  const script = typeof node.script === "string" ? node.script.trim() : "";
  const person = stationWho(node) === "person";
  const answers = person ? gateAnswers(node.id, stations.edges) : [];
  return (
    <div className="flex flex-col gap-2" data-station-instructions={node.id}>
      <GateAnswers answers={answers} />
      {prompt ? (
        <>
          <p className="lmap-empty">{person ? "What you are shown:" : "The agent's instructions, in full:"}</p>
          <div className="lmap-instructions" data-station-prompt><MarkdownRenderer content={prompt} /></div>
        </>
      ) : script ? (
        <>
          <p className="lmap-empty">A script runs this step:</p>
          <pre className="lmap-script" data-station-script>{script}</pre>
        </>
      ) : (
        <p className="lmap-empty">Its instructions are not shared with you: the line records that this step ran, not what it was told.</p>
      )}
      <p className="lmap-empty">This step belongs to {graphTitle}, which lives in the project's own repository and changes there.</p>
    </div>
  );
}

/** A person's step: the answers they can give there, and what each does. */
function GateAnswers({ answers }: { answers: ReturnType<typeof gateAnswers> }) {
  if (!answers.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="lmap-empty">Your answers here, and what each does:</p>
      <ul className="lmap-answers" data-station-answers>
        {answers.map((a) => <li key={a.answer}><b>{a.answer}</b>{a.does && <span>{a.does}</span>}</li>)}
      </ul>
    </div>
  );
}
