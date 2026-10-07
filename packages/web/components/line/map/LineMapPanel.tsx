"use client";
// A node's or an edge's panel beside the map (docs/architecture/line-map.md
// LX3). One shape for every node: Now (what is here, oldest first, each
// opening its trace), Through (what passed in the window, how each left and
// how long it stayed), Health (in words first) and Definition (what the node
// is and every value that shapes it, edited in place through the line's edit
// path, LX5), with asking an agent for a change (LX6) pinned to its footer so
// it is always in reach. An edge's panel is the items that crossed it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, MessageSquarePlus, X } from "lucide-react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import type { SessionDecisionItem } from "../../../store/inboxStore";
import { ageShort, type LineFlow, type SenseSource } from "../../../lib/lineFlow";
import { LINE_FIELDS } from "../../../lib/lineSettings";
import { decisionHref, runHref } from "../../../lib/decisionLinks";
import { stationWords } from "../../../lib/line/runReport";
import { usualWords, type LineMap, type MapEdge, type MapItem, type MapLeft, type MapNode } from "../../../lib/line/lineMap";
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
import { edgeWords, throughWord } from "./LineMap";
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
  if (n.kind === "source") return n.finder ? `Files signals into this line: ${n.finder.kind === "any" ? "any kind" : n.finder.kind.join(", ")}, grouped by ${n.finder.fingerprint}.` : "Files signals into this line. The line's profile does not declare it yet, so its signals group by the fingerprint each one carries.";
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

function PanelFrame({ title, kicker, what, onClose, nav, children, foot, data }: { title: ReactNode; kicker?: ReactNode; what?: ReactNode; onClose: () => void; nav?: string[]; children: ReactNode; foot?: ReactNode; data: Record<string, string> }) {
  // The section strip tracks where the body is scrolled, so it says where you are.
  const body = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(nav?.[0] ?? null);
  // A picked tab jumps at once (smooth scrolling stalls in a background tab
  // and lags a click anywhere) and holds the highlight until that jump's
  // scroll event has passed, so a short last section reached at the bottom
  // does not take the highlight from the one picked.
  const picked = useRef(0);
  useEffect(() => {
    const el = body.current;
    if (!el || !nav?.length) return;
    const spy = () => {
      if (Date.now() - picked.current < 250) return;
      const top = el.getBoundingClientRect().top + 32;
      let at = nav[0];
      for (const s of nav) {
        const sec = el.querySelector<HTMLElement>(`#lmap-${s.toLowerCase()}`);
        if (sec && sec.getBoundingClientRect().top <= top) at = s;
      }
      // Scrolled to the end: the last section is the one in view.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) at = nav[nav.length - 1];
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
                picked.current = Date.now();
                // Rects, not offsetTop: the body is not the sections' offset parent.
                const el = body.current;
                if (sec && el) el.scrollTo({ top: el.scrollTop + sec.getBoundingClientRect().top - el.getBoundingClientRect().top - 4, behavior: "auto" });
                setActive(s);
              }}
            >{s}</a>
          ))}
        </nav>
      )}
      <div ref={body} className="lmap-panel-body">{children}</div>
      {foot}
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

/** Lists in the panel show this many rows, then "Show all". */
const ROWS_SHOWN = 8;

function NodePanel({ map, node: n, projectId, flow, now, tracing, onTrace, onClose }: PanelProps & { node: MapNode }) {
  const asks = n.id === CARD_GATE_NODE_ID ? flow.awaiting.items : [];
  const label = map.window.label;
  return (
    <PanelFrame
      title={n.label}
      kicker={<span className="lmap-chip" data-tone="muted">{kindWords(n)}</span>}
      what={nodeWhat(n)}
      onClose={onClose}
      nav={NODE_NAV}
      foot={<AskBar node={n} projectId={projectId} />}
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
          ? <Items items={n.now} node={n} now={now} tracing={tracing} onTrace={onTrace} ageWord="here" />
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
    </PanelFrame>
  );
}

const NODE_NAV = ["Now", "Through", "Health", "Definition"];

/** The panel's footer, always in view: one line that opens the composer
 *  asking an agent for a change to this node (LX6). Esc folds it back. */
function AskBar({ node: n, projectId }: { node: MapNode; projectId: string | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [n.id]);
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
            <span>Ask for a change to {n.label}</span>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto text-sol-text-dim hover:text-sol-text" aria-label="Fold the composer"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="lmap-ask-body"><ChangeComposer node={n} projectId={projectId} autoFocus /></div>
        </>
      ) : (
        <button type="button" className="lmap-ask-bar" onClick={() => setOpen(true)} disabled={!projectId} data-map-ask-open title={projectId ? "An agent works it through the line and brings you a card" : "Work under no project runs the shipped line"}>
          <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{projectId ? `Ask for a change to ${n.label}...` : "Pick a project to change its line"}</span>
        </button>
      )}
    </div>
  );
}

function kindWords(n: MapNode): string {
  if (n.kind === "source") return n.undeclared ? "undeclared source" : "source";
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

/** The item kind a node holds, which its rows leave unsaid (every row at Causes is a cause). */
const NODE_ITEM: Partial<Record<MapNode["kind"], MapItem["kind"]>> = { causes: "cause", signals: "signal", source: "signal", station: "run", ship: "run", watch: "cause" };

/** A title's leading label ("Eval newly red: callActions..."), when it has one. */
const LEAD = /^([A-Z][^:]{2,40}):\s+(\S.*)$/;

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
 *  its title gets two lines, and trace and open show on hover or focus. Each
 *  row's age reads right-aligned on it, or once above the list when every row
 *  shares it; repeats of one title merge with a count; a label most titles
 *  open with becomes a group of its own, after the rows without it, so each
 *  row spends its lines on what sets it apart; and only the minority kind is tagged. */
function Items({ items: given, node, now, tracing, onTrace, ageWord, right }: { items: MapItem[]; node?: MapNode; now: number; tracing: string | null; onTrace: (ref: string) => void; ageWord?: string; right?: (it: MapItem) => ReactNode }) {
  const [all, setAll] = useState(false);
  // Per-visit words (right) differ row to row, so only plain lists merge.
  const { items, repeats } = useMemo(() => {
    if (right) return { items: given, repeats: new Map<MapItem, number>() };
    const first = new Map<string, MapItem>();
    const repeats = new Map<MapItem, number>();
    const out: MapItem[] = [];
    for (const it of given) {
      const k = `${it.kind}|${it.title.trim()}`;
      const seen = first.get(k);
      if (seen) { repeats.set(seen, (repeats.get(seen) ?? 1) + 1); continue; }
      first.set(k, it);
      out.push(it);
    }
    return { items: out, repeats };
  }, [given, right]);
  const implied = dominantKind(items, node ? NODE_ITEM[node.kind] : undefined);
  // A label at least half the rows open with groups them, after the rest.
  const { lead, ordered } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) { const m = it.title.match(LEAD); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1); }
    const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (!best || n < 2 || n * 2 < items.length) return { lead: null, ordered: items };
    const has = (it: MapItem) => it.title.match(LEAD)?.[1] === best;
    return { lead: { label: best, n, rest: items.length - n }, ordered: [...items.filter((it) => !has(it)), ...items.filter(has)] };
  }, [items]);
  const shown = all ? ordered : ordered.slice(0, ROWS_SHOWN);
  const inLead = (it: MapItem) => !!lead && it.title.match(LEAD)?.[1] === lead.label;
  const titleOf = (it: MapItem) => (inLead(it) ? it.title.match(LEAD)![2] : it.title);
  const age = (it: MapItem) => `${ageShort(Math.max(0, now - it.at))}${ageWord ? ` ${ageWord}` : " ago"}`;
  // One age for every row reads once above the list; else each row keeps its own.
  const sameAge = !right && shown.length > 1 && new Set(shown.map(age)).size === 1;
  // Stuck on every row says nothing a row needs: the line above says it once,
  // against the usual time the node's mark and Health read too.
  const allStuck = shown.length > 1 && shown.every((it) => it.stuck);
  const usual = allStuck && node?.medianMs != null ? usualWords(node.medianMs) : null;
  const above = sameAge ? `${age(shown[0])}${usual ? `; usually ${usual}` : ""}` : usual ? `All here longer than usual; usually ${usual}` : null;
  const total = given.length;
  return (
    <>
      {above && <div className="lmap-item-age" data-map-age data-warn={allStuck ? "true" : undefined}>{above}</div>}
      <ul className="lmap-items" data-map-items>
        {shown.map((it, i) => {
          const href = itemHref(it);
          const times = repeats.get(it) ?? 1;
          const title = titleOf(it);
          // The group headings: the rows without the label first, then the label's group.
          const heading = lead && (i === 0 || inLead(shown[i - 1]) !== inLead(it))
            ? (inLead(it) ? <>{lead.label}<span>, {lead.n}</span></> : <>Others<span>, {lead.rest}</span></>)
            : null;
          return (
            <li key={`${it.kind}:${it.id}:${i}`} className="contents">
              {heading && <div className="lmap-items-prefix" data-map-items-prefix={inLead(it) ? lead!.label : "others"}>{heading}</div>}
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
                  </span>
                  {right || sameAge ? null : <span data-map-item-age>{age(it)}</span>}
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
            </li>
          );
        })}
      </ul>
      {items.length > ROWS_SHOWN && (
        <button type="button" className="lmap-more" onClick={() => setAll((v) => !v)} data-map-show-all={total}>
          {all ? "Show fewer" : `Show all ${total}`}
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
        <p className="lmap-empty mb-1">{[...tally].map(([k, c]) => `${c} ${LEFT_WORDS[k]}`).join(", ")}.</p>
        <ItemsWithIndex items={items} node={n} now={now} tracing={tracing} onTrace={onTrace} right={(i) => {
          const v = visit.get(i)!;
          const where = v.to && v.left === "moved" ? `to ${byId.get(v.to) ?? v.to}` : LEFT_WORDS[v.left];
          return <>{where}{v.durationMs != null ? `, ${v.durationMs < 60_000 ? "under a minute" : ageShort(v.durationMs)}` : ""}</>;
        }} />
      </>
    );
  }
  if (!crossedIn.length) return <p className="lmap-empty">Nothing passed through in the last {map.window.label}.</p>;
  return <Items items={crossedIn} node={n} now={now} tracing={tracing} onTrace={onTrace} />;
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
      {!edits.lp && <p className="lmap-cli" data-map-cli>Or in the checkout: <code>cast line profile --publish</code></p>}
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
