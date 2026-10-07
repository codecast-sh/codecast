"use client";
// A node's or an edge's panel beside the map (docs/architecture/line-map.md
// LX3). One shape for every node: Now (what is here, oldest first, each
// opening its trace), Through (what passed in the window, how each left and
// how long it stayed), Health (in words first), Definition (what the node is
// and every value that shapes it, edited in place through the line's edit
// path, LX5) and Change (asking an agent for a change, LX6). An edge's panel
// is the items that crossed it.
import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { SessionDecisionItem } from "../../../store/inboxStore";
import { ageShort, type LineFlow, type SenseSource } from "../../../lib/lineFlow";
import { LINE_FIELDS } from "../../../lib/lineSettings";
import { decisionHref, runHref } from "../../../lib/decisionLinks";
import { stationWords } from "../../../lib/line/runReport";
import type { LineMap, MapEdge, MapItem, MapLeft, MapNode } from "../../../lib/line/lineMap";
import { lineTraceHref } from "../../../lib/line/lineMapUrl";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { DecisionCompactCard } from "../../decisions/DecisionCompactCard";
import { codecastEvalsPaths } from "../../evals/evalsPaths";
import { ExpectationsPanel } from "../expectations/ExpectationsPanel";
import { LineFinders } from "../settings/LineFinders";
import { ProfileFieldRow } from "../settings/ProfileFieldRow";
import { StationDefinition } from "../settings/LineStations";
import { useLineProfileEditor } from "../settings/useLineProfileEdits";
import { ChangeComposer } from "./ChangeComposer";
import { edgeWords, nodeTone } from "./LineMap";
import "../settings/settings.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── what each node is ──

const END_WORDS: Record<string, string> = {
  held: "Shipped, and the watch ended without the problem coming back.",
  reopened: "The problem came back during the watch, so the cause opened again.",
  dissolved: "Closed without a change: the problem did not reproduce.",
  dropped: "Closed without a change, by a person's answer.",
  stopped: "The run ended without a change and without closing the cause: a refused card, a failed ship, an eval that could not score, or a run that failed.",
};

export function nodeWhat(n: MapNode): string {
  if (n.kind === "expectations") return "What this project's agents should do, one cited line each. Finders that judge behavior grade against them.";
  if (n.kind === "source") return n.finder ? `Files signals into this line: ${n.finder.kind === "any" ? "any kind" : n.finder.kind.join(", ")}, grouped by ${n.finder.fingerprint}.` : "Files signals into this line without being declared in the line's profile.";
  if (n.kind === "signals") return "Every signal filed into the line. A signal joins the open cause that shares its fingerprint, or opens a new one.";
  if (n.kind === "causes") return "The admission queue: open causes, ranked by goal and how often they were seen. The line starts the top one while few enough cards wait on you.";
  if (n.kind === "end") return END_WORDS[n.end ?? ""] ?? "";
  return stationWords(n.id) ?? "A step of this project's line.";
}

/** The profile values that shape each node, by node id or kind (LP2). */
const NODE_FIELDS: Record<string, string[]> = {
  causes: ["caps.cards", "size_budget"],
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

const ITEM_WORDS: Record<MapItem["kind"], string> = { signal: "signal", cause: "cause", run: "run", decision: "card" };

const LEFT_WORDS: Record<MapLeft, string> = {
  moved: "moved on", failed: "failed", live: "still here", held: "held", reopened: "reopened", dissolved: "dissolved", dropped: "dropped", stopped: "stopped", parked: "parked",
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
};

export function LineMapPanel(p: PanelProps) {
  const byId = useMemo(() => new Map(p.map.nodes.map((n) => [n.id, n])), [p.map.nodes]);
  if (p.edge) return <EdgePanel {...p} edge={p.edge} byId={byId} />;
  if (p.node) return <NodePanel {...p} node={p.node} />;
  return null;
}

function PanelFrame({ title, kicker, what, onClose, nav, children, data }: { title: ReactNode; kicker?: ReactNode; what?: ReactNode; onClose: () => void; nav?: string[]; children: ReactNode; data: Record<string, string> }) {
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
          {nav.map((s) => <a key={s} href={`#lmap-${s.toLowerCase()}`} onClick={(e) => { e.preventDefault(); document.getElementById(`lmap-${s.toLowerCase()}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>{s}</a>)}
        </nav>
      )}
      <div className="lmap-panel-body">{children}</div>
    </aside>
  );
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={`lmap-${id}`} className="lmap-sec" data-map-section={id}>
      <h3 className="lmap-sec-title">{title}{aside && <small>{aside}</small>}</h3>
      {children}
    </section>
  );
}

// ── a node ──

function NodePanel({ map, node: n, projectId, flow, now, tracing, onTrace, onClose }: PanelProps & { node: MapNode }) {
  const asks = n.id === CARD_GATE_NODE_ID ? flow.awaiting.items : [];
  const tone = nodeTone(n, asks.length);
  const label = map.window.label;
  return (
    <PanelFrame
      title={n.label}
      kicker={<span className="lmap-chip" data-tone={tone === "fail" ? "fail" : tone === "warn" ? "warn" : "muted"}>{kindWords(n)}</span>}
      what={nodeWhat(n)}
      onClose={onClose}
      nav={["Now", "Through", "Health", "Definition", "Change"]}
      data={{ "data-map-panel": n.id }}
    >
      <Section id="now" title="Now" aside={n.now.length + asks.length ? `${n.now.length + asks.length}, oldest first` : undefined}>
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
          ? <Items items={n.now} now={now} tracing={tracing} onTrace={onTrace} ageWord="here" />
          : asks.length === 0 && <p className="lmap-empty">{emptyNow(n)}</p>}
      </Section>

      <Section id="through" title="Through" aside={`the last ${label}`}>
        <Through node={n} map={map} now={now} tracing={tracing} onTrace={onTrace} />
      </Section>

      <Section id="health" title="Health">
        <Health node={n} label={label} sense={n.kind === "source" ? flow.sense.items.find((s) => s.source.toLowerCase() === n.source?.toLowerCase()) : undefined} now={now} />
      </Section>

      <Section id="definition" title="Definition">
        <Definition node={n} projectId={projectId} flow={flow} now={now} />
      </Section>

      <Section id="change" title="Change">
        <ChangeComposer node={n} projectId={projectId} />
      </Section>
    </PanelFrame>
  );
}

function kindWords(n: MapNode): string {
  if (n.kind === "source") return n.finder ? "source" : "undeclared source";
  if (n.kind === "end") return "end";
  if (n.kind === "decide") return "your answer";
  if (n.kind === "expectations" || n.kind === "signals" || n.kind === "causes") return "intake";
  return n.main ? "station" : "branch";
}

function emptyNow(n: MapNode): string {
  if (n.kind === "expectations") return "Expectations hold no work. Finders that judge behavior grade against them; Definition lists them.";
  if (n.kind === "source" || n.kind === "signals") return "Signals do not wait here; they pass straight on.";
  if (n.kind === "end") return "An end holds nothing; Through lists what ended here.";
  if (n.kind === "causes") return "No cause waits to be built.";
  return "Nothing is at this step now.";
}

function Items({ items, now, tracing, onTrace, ageWord, right }: { items: MapItem[]; now: number; tracing: string | null; onTrace: (ref: string) => void; ageWord?: string; right?: (it: MapItem) => ReactNode }) {
  return (
    <ul className="lmap-items" data-map-items>
      {items.map((it, i) => {
        const href = itemHref(it);
        return (
          <li
            key={`${it.kind}:${it.id}:${i}`}
            className="lmap-item"
            data-active={tracing === it.ref ? "true" : undefined}
            onClick={() => onTrace(it.ref)}
            title="Draw its path on the map"
            data-map-item={it.ref}
          >
            <span className="lmap-item-title">{it.title}</span>
            <span className="lmap-item-meta">
              {right ? right(it) : <>{ageShort(Math.max(0, now - it.at))}{ageWord ? ` ${ageWord}` : " ago"}</>}
            </span>
            <span className="lmap-item-sub">
              <span>{ITEM_WORDS[it.kind]}</span>
              {it.stuck && <span className="lmap-chip" data-tone="warn">stuck</span>}
              {it.stalled && <span className="lmap-chip" data-tone="warn">silent a day</span>}
              <span className="flex-1" />
              <Link href={lineTraceHref(it.ref)} onClick={(e) => e.stopPropagation()} data-map-trace-link title="Every step it took, from the first signal on">trace</Link>
              {href && <Link href={href} onClick={(e) => e.stopPropagation()}>open</Link>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What passed in the window: a station's visits with how each left, or what crossed into any other node. */
function Through({ node: n, map, now, tracing, onTrace }: { node: MapNode; map: LineMap; now: number; tracing: string | null; onTrace: (ref: string) => void }) {
  const crossedIn = useMemo(() => {
    if (n.passed.length) return [];
    const seen = new Set<string>();
    const out: MapItem[] = [];
    for (const e of map.edges) if (e.to === n.id) for (const it of e.items) {
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
        <p className="lmap-empty mb-1">{[...tally].map(([k, c]) => `${c} ${LEFT_WORDS[k]}`).join(", ")}.</p>
        <ItemsWithIndex items={items} now={now} tracing={tracing} onTrace={onTrace} right={(i) => {
          const v = visit.get(i)!;
          const where = v.to && v.left === "moved" ? `to ${byId.get(v.to) ?? v.to}` : LEFT_WORDS[v.left];
          return <>{where}{v.durationMs != null ? `, ${ageShort(v.durationMs)}` : ""}</>;
        }} />
      </>
    );
  }
  if (!crossedIn.length) return <p className="lmap-empty">Nothing passed through in the last {map.window.label}.</p>;
  return <Items items={crossedIn} now={now} tracing={tracing} onTrace={onTrace} />;
}

/** Items whose right-hand words depend on their place in the list. */
function ItemsWithIndex({ items, right, ...rest }: { items: MapItem[]; now: number; tracing: string | null; onTrace: (ref: string) => void; right: (i: number) => ReactNode }) {
  const idx = new Map(items.map((it, i) => [it, i]));
  return <Items items={items} {...rest} right={(it) => right(idx.get(it)!)} />;
}

function Health({ node: n, label, sense, now }: { node: MapNode; label: string; sense?: SenseSource; now: number }) {
  const stats: Array<{ v: string; k: string }> = [];
  if (n.kind !== "source" && n.kind !== "expectations" && n.kind !== "signals" && n.kind !== "end") stats.push({ v: String(n.now.length), k: "here now" });
  stats.push({ v: String(n.through), k: `through in ${label}` });
  if (n.medianMs != null) stats.push({ v: ageShort(n.medianMs), k: "usual time here" });
  if (isStationKind(n) && n.through > 0) stats.push({ v: `${Math.round((n.failed / n.through) * 100)}%`, k: "failed" });
  if (sense) stats.push({ v: sense.newest ? `${ageShort(now - sense.newest.created_at)} ago` : "never", k: "last signal" });
  return (
    <div className="lmap-health" data-map-health>
      {n.marks.length
        ? n.marks.map((m) => <p key={m.words} className="lmap-health-words" data-level={m.level}>{m.words}.</p>)
        : <p className="lmap-health-words">{healthyWords(n, label)}</p>}
      <div className="lmap-stats">
        {stats.map((s) => <div key={s.k} className="lmap-stat"><b>{s.v}</b><span>{s.k}</span></div>)}
      </div>
    </div>
  );
}

function healthyWords(n: MapNode, label: string): string {
  if (n.through === 0 && n.now.length === 0) return `Quiet: nothing reached it in the last ${label}.`;
  if (n.kind === "source") return "Filing as expected.";
  if (n.kind === "end") return `${n.through} ended here in the last ${label}.`;
  return `Nothing wrong in the last ${label}.`;
}

/** What shapes the node, edited in place: finder declarations, a station's prompt, script and timeout, the profile values it reads, the expectations. */
function Definition({ node: n, projectId, flow, now }: { node: MapNode; projectId: string | null; flow: LineFlow; now: number }) {
  if (!projectId) return <p className="lmap-empty">Work filed under no project runs the shipped line and has no settings of its own.</p>;
  if (n.kind === "expectations") return <ExpectationsPanel projectId={projectId} scroll={false} />;
  return (
    <div className="flex flex-col gap-3">
      {isStationKind(n) && <StationDefinition projectId={projectId} stationId={n.id} />}
      <ProfileValues node={n} projectId={projectId} flow={flow} now={now} />
      {n.kind === "source" && n.source?.toLowerCase() === "evals" && (
        <Link href={codecastEvalsPaths.senseHref(flow.sense.items.find((s) => s.source === "evals")?.newest?.subject)} className="text-[12px] text-sol-blue hover:underline" data-map-evals-link>Read its drops in Evals</Link>
      )}
    </div>
  );
}

function ProfileValues({ node: n, projectId, flow, now }: { node: MapNode; projectId: string; flow: LineFlow; now: number }) {
  const { edits, gate, device } = useLineProfileEditor(projectId);
  const lp = edits.lp;
  const fields = nodeFields(n.id);
  const finders = n.kind === "source" || n.kind === "signals";
  if (!fields.length && !finders) return null;
  if (!lp) return <p className="lmap-empty">This project has published no line profile, so its values are the defaults. In its checkout, run <code>cast line profile --publish</code>.</p>;
  const shown = n.kind === "source" ? { ...lp, finders: lp.finders.filter((f) => f.source.toLowerCase() === n.source?.toLowerCase()) } : lp;
  const sense = n.kind === "source" ? flow.sense.items.filter((s) => s.source.toLowerCase() === n.source?.toLowerCase()) : flow.sense.items;
  return (
    <div className="flex flex-col gap-1" data-map-values>
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
