"use client";
// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one horizontal flow, from what the world reported to what
// closed this week. Paints from the store: signals (useSyncSignals), tasks
// with a `cause`, runs (useSyncRuns) and the decision queue. lib/lineFlow
// derives every column, stage state and the throughput strip.
import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatTokens } from "@codecast/shared/render/changeCardHtml";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { SessionDecisionItem, TaskItem } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useSyncRuns, useWorkspaceRuns } from "../../hooks/useSyncRuns";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";
import { formatElapsed } from "../../lib/taskLine";
import { runHref, decisionHref } from "../../lib/decisionLinks";
import { cn } from "../../lib/utils";
import { copyText } from "../../lib/copyText";
import {
  buildLineFlow, groupBuild, isLineCard, lineHeadline, DAY,
  type BuildBlock, type HeadlinePart, type CauseRow, type ClosedRow, type Column, type GoalRow, type LineCauseTask, type LineFlowRun, type SenseSource, type StageState, type WatchRow,
} from "../../lib/lineFlow";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { DecisionCompactCard } from "../decisions/DecisionCompactCard";
import { cardAnswerIndexes } from "../decisions/ChangeCardView";
import "./line.css";

const RUNS_FEED = { limit: 200 };

const causeSig = (t: TaskItem & LineCauseTask) =>
  t.cause ? `${t.status}|${t.updated_at ?? 0}|${t.watch_until ?? 0}|${t.goal_ref ?? ""}|${t.cause.signal_count}|${t.priority ?? ""}|${t.closed_at ?? 0}|${t.resolved_at ?? 0}` : "";
const projectSig = (p: { title?: string; priority?: string; short_id?: string }) => `${p.short_id ?? ""}|${p.title ?? ""}|${p.priority ?? ""}`;
const cardSig = (d: SessionDecisionItem) => `${d.status}|${d.updated_at ?? 0}|${d.task_id ?? ""}|${d.workflow_run_id ?? ""}`;

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
/** what and cmd teach an empty station: what feeds it, and the command. */
type Station = { key: StationKey; name: string; short: string; sub?: string; wide?: boolean; what: string; cmd: string };

const STATIONS: Station[] = [
  { key: "sense", name: "Sense", short: "Sense", sub: "24h", what: "Finders write signals here: Sentry, PostHog, evals, lessons, or a person.", cmd: "cast signal add" },
  { key: "causes", name: "Causes", short: "Causes", what: "A signal opens a cause, or joins the open one that shares its fingerprint.", cmd: "cast signal ls" },
  { key: "build", name: "In build", short: "Build", what: "The sweep starts the top cause while you hold fewer than five open cards.", cmd: "cast workflow run line --task ct-N" },
  { key: "awaiting", name: "Awaiting you", short: "You", wide: true, what: "Each run ends in one change card with its proof. Cards wait here for your answer.", cmd: "cast workflow runs" },
  { key: "watching", name: "Watching", short: "Watch", what: "A shipped cause is watched. A repeat of its signal reopens it; a quiet watch resolves it.", cmd: "cast task update ct-N --watch-days 7" },
  { key: "closed", name: "Closed", short: "Closed", sub: "7d", what: "Causes shipped, dissolved or resolved in the last seven days.", cmd: "cast task ls --status done" },
];

const taskHref = (t: { short_id?: string; _id: string }) => `/tasks/${t.short_id ?? t._id}`;

// Columns size from the container so the whole line fits a laptop; an empty
// station is a slimmer tile so the live ones get the width, never so slim its
// command wraps. Below sm the stations snap one per screen and scroll sideways.
// A tight set takes over when the flow is narrower than the roomy minimums
// (a laptop with the inbox panel open); past that the flow scrolls.
const ROOMY = { rail: "30px", empty: "minmax(176px, 0.6fr)", wide: "minmax(272px, 1.4fr)", live: "minmax(196px, 1fr)" };
const TIGHT = { rail: "16px", empty: "minmax(164px, 0.55fr)", wide: "minmax(244px, 1.4fr)", live: "minmax(172px, 1fr)" };
const NARROW = { rail: "18px", empty: "68vw", wide: "86vw", live: "86vw" };
const template = (set: typeof ROOMY, emptyOf: (s: Station) => boolean) =>
  STATIONS.flatMap((s, i) => [...(i ? [set.rail] : []), emptyOf(s) ? set.empty : s.wide ? set.wide : set.live]).join(" ");

export function LinePage() {
  useSyncSignals();
  useSyncRuns(RUNS_FEED);
  const router = useRouter();
  const now = useCoarseNow(30_000);

  const signals = useWorkspaceSignals();
  const tasks = useWorkspaceCollection<TaskItem & LineCauseTask>("tasks", causeSig);
  const runs = useWorkspaceRuns() as LineFlowRun[];
  const cards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: isLineCard as (d: SessionDecisionItem) => boolean, sig: cardSig });
  const initiatives = useInitiatives();
  const projects = useWorkspaceCollection<GoalRow>("projects", projectSig);

  const flow = useMemo(() => buildLineFlow({
    signals,
    tasks,
    runs,
    decisions: cards as Array<SessionDecisionItem & { created_at?: number }>,
    initiatives: initiatives.map((i: InitiativeRow) => ({ short_id: i.short_id, title: i.title, priority: i.priority as GoalRow["priority"] })),
    projects,
    now,
  }), [signals, tasks, runs, cards, initiatives, projects, now]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks]);
  const buildBlocks = useMemo(() => groupBuild(flow.build.items), [flow.build.items]);
  const [parkedOpen, setParkedOpen] = useState(false);

  // Keyboard: one cursor over the whole flow, in render order.
  const hrefs: Record<StationKey, string[]> = useMemo(() => ({
    sense: flow.sense.items.map((s) => { const t = taskById.get(s.newest.task_id); return t ? taskHref(t) : "/line"; }),
    causes: [...flow.causes.items, ...(parkedOpen ? flow.causes.parked : [])].map((r) => taskHref(r.task)),
    build: buildBlocks.flatMap((g) => g.rows).map((b) => runHref(b.run._id)),
    awaiting: flow.awaiting.items.map((d) => decisionHref(d)),
    watching: flow.watching.items.map((w) => taskHref(w.task)),
    closed: flow.closed.items.map((c) => taskHref(c.task)),
  }), [flow, buildBlocks, taskById, parkedOpen]);

  // Until the viewer moves, the cursor sits where the work is: a card waiting
  // on them, else the first station holding anything.
  const defaultCol = flow.awaiting.count > 0
    ? STATIONS.findIndex((s) => s.key === "awaiting")
    : Math.max(0, STATIONS.findIndex((s) => hrefs[s.key].length > 0));
  const [moved, setFocus] = useState<{ col: number; row: number } | null>(null);
  const focus = moved ?? { col: defaultCol, row: 0 };
  const scroller = useRef<HTMLDivElement>(null);
  const col = Math.min(focus.col, STATIONS.length - 1);
  const rows = hrefs[STATIONS[col].key].length;
  const row = Math.min(focus.row, Math.max(0, rows - 1));
  const focusedCard = STATIONS[col].key === "awaiting" ? flow.awaiting.items[row] as SessionDecisionItem | undefined : undefined;
  // A multi, rank or form card claims return to submit; every other row opens.
  const cardTakesReturn = !!focusedCard && !cardAnswerIndexes(focusedCard) && (focusedCard.kind ?? "single") !== "single";

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      // Sideways skips stations with nothing in them; a number jumps to any.
      const side = (dc: number) => {
        e.preventDefault();
        for (let c = col + dc; c >= 0 && c < STATIONS.length; c += dc) {
          if (hrefs[STATIONS[c].key].length > 0) return setFocus({ col: c, row: 0 });
        }
      };
      const down = (dr: number) => {
        e.preventDefault();
        setFocus({ col, row: Math.max(0, Math.min(rows - 1, row + dr)) });
      };
      if (e.key === "ArrowRight" || e.key === "l") return side(1);
      if (e.key === "ArrowLeft" || e.key === "h") return side(-1);
      if (e.key === "ArrowDown" || e.key === "j") return down(1);
      if (e.key === "ArrowUp" || e.key === "k") return down(-1);
      const jump = Number(e.key);
      if (jump >= 1 && jump <= STATIONS.length) { e.preventDefault(); return setFocus({ col: jump - 1, row: 0 }); }
      if ((e.key === "c" || e.key === "C") && rows === 0) { e.preventDefault(); void copyText(STATIONS[col].cmd, "Command copied"); return; }
      if (e.key === "Enter" && !cardTakesReturn) {
        const href = hrefs[STATIONS[col].key][row];
        if (href) { e.preventDefault(); router.push(href); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hrefs, col, row, rows, router, cardTakesReturn]);

  // Keep the cursor on screen: the station sideways, the row inside it.
  useWatchEffect(() => {
    const root = scroller.current;
    if (!root || !moved) return;
    const station = root.querySelector<HTMLElement>(`[data-line-col="${col}"]`);
    station?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    station?.querySelector<HTMLElement>(`[data-line-row="${row}"]`)?.scrollIntoView({ block: "nearest" });
  }, [col, row]);

  const columns: Record<StationKey, Column<unknown>> = flow as unknown as Record<StationKey, Column<unknown>>;
  const at = (key: StationKey, i: number) => STATIONS[col].key === key && row === i;
  // Sense counts today's signals but lists the week's sources.
  const empty = (key: StationKey) => (key === "sense" ? flow.sense.items.length === 0 : columns[key].count === 0);
  const grid = {
    "--line-cols": template(ROOMY, (s) => empty(s.key)),
    "--line-cols-tight": template(TIGHT, (s) => empty(s.key)),
    "--line-cols-narrow": template(NARROW, (s) => empty(s.key)),
  } as CSSProperties;

  const options = Math.min(9, focusedCard?.options?.length ?? 0);
  // On narrow screens the stations snap one per screen: track which one shows.
  const [shown, setShown] = useState(0);
  const onFlowScroll = () => {
    const root = scroller.current;
    if (!root) return;
    const mid = root.scrollLeft + root.clientWidth / 2;
    let best = 0;
    let bestGap = Infinity;
    root.querySelectorAll<HTMLElement>("[data-line-col]").forEach((el) => {
      const gap = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = Number(el.dataset.lineCol); }
    });
    if (best !== shown) setShown(best);
  };
  const showStation = (i: number) => {
    setFocus({ col: i, row: 0 });
    scroller.current?.querySelector<HTMLElement>(`[data-line-col="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  };

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-4 flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[13px] text-sol-text-muted leading-none">The line</h1>
          <span className="hidden md:inline text-[11px] text-sol-text-dim leading-none">a signal in the world to a shipped, watched change</span>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-sol-text-dim">
            <Link href="/questions" className="hover:text-sol-text">all questions</Link>
            <Link href="/routines" className="hover:text-sol-text">workflows</Link>
          </div>
        </div>
        <Headline parts={lineHeadline(flow, now)} />
        <Throughput t={flow.throughput} />
      </header>

      <nav className="line-tabs sm:hidden shrink-0 flex gap-1 overflow-x-auto px-4 pb-2" aria-label="Stations">
        {STATIONS.map((s, i) => (
          <button key={s.key} onClick={() => showStation(i)} data-active={shown === i ? "true" : undefined} className="line-tab shrink-0 rounded-full px-2.5 py-1 text-[11.5px] whitespace-nowrap">
            {s.short} <span className="tabular-nums" data-zero={columns[s.key].count === 0 ? "true" : undefined}>{columns[s.key].count}</span>
          </button>
        ))}
      </nav>

      <div ref={scroller} onScroll={onFlowScroll} className="line-flow flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory sm:snap-none" data-line-flow>
        <div className="line-track h-full px-4 sm:px-5 pb-4" style={grid}>
          {STATIONS.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && <Rail live={!empty(s.key)} moved={flow.moved[s.key as keyof typeof flow.moved] ?? 0} into={s.name} />}
              <StationColumn
                station={s}
                index={i}
                column={columns[s.key]}
                empty={empty(s.key)}
                focused={col === i}
                now={now}
                onFocus={() => setFocus({ col: i, row: 0 })}
              >
                {empty(s.key) && <Empty station={s} focused={col === i} after={s.key === "build" && <OtherRuns n={flow.build.otherRuns} />} />}

                {s.key === "sense" && !empty("sense") && ( flow.sense.items.map((src, r) => <SenseRow key={src.source} src={src} now={now} focused={at("sense", r)} index={r} href={hrefs.sense[r]} />))}

                {s.key === "causes" && !empty("causes") && (<>
                      {flow.causes.items.map((c, r) => <CauseRowView key={c.task._id} row={c} rank={r + 1} max={flow.causes.items[0]?.score ?? 1} focused={at("causes", r)} index={r} />)}
                      {flow.causes.parked.length > 0 && (
                        <div className="pt-2">
                          <button onClick={() => setParkedOpen((v) => !v)} className="w-full flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text px-1 py-1">
                            {parkedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            parked, no goal <span className="ml-auto">{flow.causes.parked.length}</span>
                          </button>
                          {parkedOpen && flow.causes.parked.map((c, r) => {
                            const idx = flow.causes.items.length + r;
                            return <CauseRowView key={c.task._id} row={c} max={flow.causes.items[0]?.score ?? c.score} focused={at("causes", idx)} index={idx} muted />;
                          })}
                        </div>
                      )}
                    </>)}

                {s.key === "build" && !empty("build") && (<>
                  {buildBlocks.map((g, gi) => <BuildBlockView key={g.label ?? `solo-${gi}`} block={g} now={now} at={(r) => at("build", r)} />)}
                  <OtherRuns n={flow.build.otherRuns} />
                </>)}

                {s.key === "awaiting" && !empty("awaiting") && (<div className="space-y-2">
                      {flow.awaiting.items.map((d, r) => (
                        <div key={d._id} data-line-row={r} className={cn("rounded-lg transition-shadow", at("awaiting", r) && "ring-2 ring-sol-yellow/40")}>
                          <DecisionCompactCard decision={d as SessionDecisionItem} keys={at("awaiting", r)} />
                        </div>
                      ))}
                    </div>)}

                {s.key === "watching" && !empty("watching") && (flow.watching.items.map((w, r) => <WatchRowView key={w.task._id} row={w} focused={at("watching", r)} index={r} />))}

                {s.key === "closed" && !empty("closed") && (flow.closed.items.map((c, r) => <ClosedRowView key={c.task._id} row={c} now={now} focused={at("closed", r)} index={r} />))}
              </StationColumn>
            </Fragment>
          ))}
        </div>
      </div>

      <footer className="shrink-0 hidden sm:flex items-center gap-4 px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
        <span className="flex items-center gap-1"><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> stations</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> items</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">1</KeyCap>-<KeyCap size="xs">{String(STATIONS.length)}</KeyCap> jump</span>
        <span className="ml-auto flex items-center gap-4" data-line-hint>
          {focusedCard && options > 0 && <span className="text-sol-yellow/90 flex items-center gap-1"><KeyCap size="xs">1</KeyCap>{options > 1 && <>-<KeyCap size="xs">{String(options)}</KeyCap></>} answer the card</span>}
          {rows > 0
            ? <span className="flex items-center gap-1"><KeyCap size="xs">↵</KeyCap> {cardTakesReturn ? "submit" : "open"}</span>
            : <span className="flex items-center gap-1"><KeyCap size="xs">c</KeyCap> copy the command</span>}
        </span>
      </footer>
    </div>
  );
}

// ── Headline and throughput ──

const TONE: Record<HeadlinePart["tone"], string> = {
  ask: "text-sol-yellow",
  warn: "text-sol-orange",
  fail: "text-sol-red",
  live: "text-sol-text",
  calm: "text-sol-text-muted",
};

function Headline({ parts }: { parts: HeadlinePart[] }) {
  return (
    <p className="line-headline text-[17px] sm:text-[19px] leading-snug" data-line-headline>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-sol-text-dim">, </span>}
          <span className={TONE[p.tone]}>{i === 0 ? p.text.charAt(0).toUpperCase() + p.text.slice(1) : p.text}</span>
        </Fragment>
      ))}
      <span className="text-sol-text-dim">.</span>
    </p>
  );
}

function Throughput({ t }: { t: ReturnType<typeof buildLineFlow>["throughput"] }) {
  const cells: Array<{ label: string; value: number | string | null; tone?: string; tip?: string }> = [
    { label: "signals in", value: t.signalsIn },
    { label: "causes opened", value: t.opened },
    { label: "dissolved", value: t.dissolved },
    { label: "shipped", value: t.shipped },
    { label: "reopened in watch", value: t.reopened, tone: t.reopened ? "text-sol-red" : undefined },
    { label: "signal to ship", value: t.medianToShip === null ? null : formatElapsed(0, t.medianToShip) },
    { label: "tokens per ship", value: t.tokensPerShip === null ? null : formatTokens(Math.round(t.tokensPerShip)), tip: "Cost per shipped change, in run tokens: runs record tokens, not dollars, so tokens stand in for cost" },
  ];
  return (
    <div className="line-meter rounded-xl grid grid-cols-4 lg:grid-cols-7 overflow-hidden" data-line-throughput>
      {cells.map((c) => (
        <div key={c.label} className="line-meter-cell px-3 sm:px-4 py-2.5 min-w-0" title={c.tip ?? c.label}>
          {c.value === null
            ? <div className="h-[20px] sm:h-[22px] flex items-end text-[11.5px] text-sol-text-dim/80 whitespace-nowrap">none yet</div>
            : <div className={cn("line-num text-[20px] sm:text-[22px] text-sol-text", c.tone)} data-zero={c.value === 0 ? "true" : undefined}>{c.value}</div>}
          <div className="mt-1 text-[10.5px] sm:text-[11px] text-sol-text-dim truncate">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── A station ──

function stateWords(state: StageState, now: number): string {
  const since = state.since ? formatElapsed(state.since, now) : null;
  if (state.kind === "paused") return `paused${since ? ` ${since}` : ""} · ${state.why}`;
  if (state.kind === "failing") return `failing${since ? ` ${since}` : ""} · ${state.why}`;
  if (state.kind === "starved") return `starved · ${state.why}${since ? `, last ${since} ago` : ""}`;
  if (state.kind === "clear") return `clear · ${state.why}`;
  return `running · ${state.why}`;
}

const STATE_TONE: Record<StageState["kind"], string> = {
  failing: "text-sol-red",
  paused: "text-sol-yellow",
  starved: "text-sol-orange/80",
  clear: "text-sol-text-dim",
  running: "text-sol-text-muted",
};

function StationColumn({ station, index, column, empty, focused, now, onFocus, children }: {
  station: Station;
  index: number;
  column: Column<unknown>;
  empty: boolean;
  focused: boolean;
  now: number;
  onFocus: () => void;
  children: ReactNode;
}) {
  const state = column.state;
  const words = stateWords(state, now);
  return (
    <section
      data-line-col={index}
      data-station={station.key}
      data-focused={focused ? "true" : undefined}
      data-state={state.kind}
      data-empty={empty ? "true" : undefined}
      onMouseDown={onFocus}
      className="line-col relative rounded-[10px] flex flex-col min-h-0 min-w-0 snap-center"
      style={{ "--i": index } as CSSProperties}
    >
      <div className="line-col-head shrink-0 px-3 pt-3 pb-2.5 border-b border-sol-border/25">
        <div className="flex items-start gap-2 h-[38px]">
          <div className="min-w-0 flex-1 flex items-center gap-1.5 h-[24px]">
            <KeyCap size="xs">{String(index + 1)}</KeyCap>
            <h2 className="text-[13px] text-sol-text whitespace-nowrap truncate">{station.name}</h2>
            {station.sub && <span className="text-[10.5px] text-sol-text-dim whitespace-nowrap">{station.sub}</span>}
          </div>
          <div className="shrink-0 text-right">
            <div className={cn("line-num line-col-count text-sol-text", empty ? "text-[18px] pt-[3px]" : "text-[24px]")} data-zero={empty ? "true" : undefined}>{column.count}</div>
            {column.oldestAt && <div className="mt-0.5 text-[10px] text-sol-text-dim whitespace-nowrap" title="the oldest item here">oldest {formatElapsed(column.oldestAt, now)}</div>}
          </div>
        </div>
        <div className="mt-1 flex items-start gap-2 text-[11px] h-[30px]" data-line-state title={words}>
          <span className="line-lamp mt-[4px]" data-kind={state.kind} />
          <span className={cn("leading-[15px] min-w-0 line-clamp-2", STATE_TONE[state.kind])}>{words}</span>
        </div>
      </div>
      <div className={cn("min-h-0 flex-1 p-2", !empty && "overflow-y-auto")} data-line-body>
        {children}
      </div>
    </section>
  );
}

function Rail({ live, moved, into }: { live: boolean; moved: number; into: string }) {
  return (
    <div className="line-rail-slot relative" aria-hidden>
      <div className="line-rail" data-live={live ? "true" : undefined} />
      {moved > 0 && <span className="line-rail-chip" title={`${moved} entered ${into} this week`}>{moved}</span>}
    </div>
  );
}

/** An empty station: what feeds it and the command, on one line that scrolls
 *  sideways before it ever wraps. Focused, c copies the command. */
function Empty({ station, focused, after }: { station: Station; focused: boolean; after?: ReactNode }) {
  return (
    <div className="line-empty h-full rounded-lg flex flex-col gap-2.5 p-2.5" data-line-empty>
      <p className="text-[11.5px] text-sol-text-muted leading-relaxed">{station.what}</p>
      <div className="line-cmd-scroll overflow-x-auto min-w-0">
        <code className="line-cmd inline-block whitespace-nowrap rounded px-2 py-1 text-[10.5px] text-sol-text-muted">{station.cmd}</code>
      </div>
      <div className="-mt-1 h-[18px]">
        <button
          type="button"
          onClick={() => void copyText(station.cmd, "Command copied")}
          className={cn("shrink-0 flex items-center gap-1 text-[10.5px] text-sol-text-dim hover:text-sol-text transition-opacity", focused ? "opacity-100" : "opacity-0 pointer-events-none")}
          tabIndex={focused ? 0 : -1}
        >
          <KeyCap size="xs">c</KeyCap> copy
        </button>
      </div>
      {after}
    </div>
  );
}

function OtherRuns({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <Link href="/routines" className="mt-1 block px-2.5 py-1.5 text-[11px] text-sol-text-dim hover:text-sol-text-muted" data-line-other-runs>
      {n} other run{n === 1 ? "" : "s"}, not from the line
    </Link>
  );
}

function RowLink({ href, focused, index, children, className }: { href: string; focused: boolean; index: number; children: ReactNode; className?: string }) {
  return (
    <Link href={href} data-line-row={index} data-focused={focused ? "true" : undefined} className={cn("line-row block rounded-md px-2.5 py-2", className)}>
      {children}
    </Link>
  );
}

// ── Rows ──

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 4;
  const gap = 1;
  return (
    <svg className="line-spark" width={values.length * (w + gap)} height={20} viewBox={`0 0 ${values.length * (w + gap)} 20`} aria-label="signals per hour, last 24 hours">
      {values.map((v, i) => {
        const h = v === 0 ? 1 : Math.max(3, Math.round((v / max) * 20));
        return <rect key={i} x={i * (w + gap)} y={20 - h} width={w} height={h} rx={1} data-hot={i >= values.length - 3 && v > 0 ? "true" : undefined} opacity={v === 0 ? 0.35 : 1} />;
      })}
    </svg>
  );
}

function SenseRow({ src, now, focused, index, href }: { src: SenseSource; now: number; focused: boolean; index: number; href: string }) {
  return (
    <RowLink href={href} focused={focused} index={index}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-sol-text">{src.source}</span>
        <span className="text-[10px] text-sol-text-dim truncate min-w-0">{src.kinds.join(" · ")}</span>
        <span className="ml-auto shrink-0 text-[12px] text-sol-text tabular-nums">{src.day}<span className="text-sol-text-dim"> / {src.week}</span></span>
      </div>
      <div className="mt-1.5"><Spark values={src.spark} /></div>
      <div className="mt-1 text-[11px] text-sol-text-dim truncate" title={src.newest.title}>
        {src.newest.title} · {formatElapsed(src.newest.created_at, now)}
      </div>
    </RowLink>
  );
}

const GOAL_TONE: Record<string, string> = {
  initiative: "border-sol-text-muted/50 text-sol-text",
  project: "border-sol-border text-sol-text-muted",
  unknown: "border-sol-border text-sol-text-dim",
  parked: "border-sol-border text-sol-text-dim",
  ungrounded: "border-dashed border-sol-border text-sol-text-dim",
};

function CauseRowView({ row, rank, max, focused, index, muted }: { row: CauseRow; rank?: number; max: number; focused: boolean; index: number; muted?: boolean }) {
  const t = row.task;
  return (
    <RowLink href={taskHref(t)} focused={focused} index={index} className={muted ? "opacity-70" : undefined}>
      <div className="flex items-start gap-2">
        {rank !== undefined && <span className="line-num text-[15px] text-sol-text-dim w-4 shrink-0 pt-px">{rank}</span>}
        <span className="text-[12.5px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0">{t.title}</span>
      </div>
      <div className={cn("mt-1.5 flex items-center gap-1.5 flex-wrap text-[10.5px]", rank !== undefined && "pl-6")}>
        <span className="text-sol-text tabular-nums" title="signals attached">×{row.signals}</span>
        <span className={cn("px-1.5 py-px rounded border max-w-[10rem] truncate", GOAL_TONE[row.goal.kind])} title={row.goal.ref || "the ground node has not run"}>{row.goal.label}</span>
        {t.category && <span className="text-sol-text-dim">{t.category}</span>}
        {t.risk && t.risk !== "low" && <span className="text-sol-text-dim">· {t.risk}</span>}
        {t.readiness && t.readiness !== "ready" && <span className="text-sol-yellow" title={t.readiness_note ?? undefined}>· {t.readiness.replace("_", " ")}</span>}
        <span className="ml-auto text-sol-text-dim font-mono">{t.short_id}</span>
      </div>
      <div className={cn("line-bar mt-1.5 h-[3px] rounded-full overflow-hidden", rank !== undefined && "ml-6")} title={`priority ${row.score.toFixed(1)}`}>
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, (row.score / (max || 1)) * 100))}%` }} />
      </div>
    </RowLink>
  );
}

function BuildBlockView({ block, now, at }: { block: BuildBlock; now: number; at: (row: number) => boolean }) {
  return (
    <div className="mb-2">
      {block.label && (
        <div className="flex items-center gap-2 px-1 pb-1 text-[11px] text-sol-text-dim">
          <span className={cn("w-1 h-1 rounded-full", block.stalled ? "bg-sol-text-dim" : "bg-[var(--line-belt)]")} />
          <span className="text-sol-text-muted">{block.label}</span>
          <span className="ml-auto tabular-nums">{block.rows.length}</span>
        </div>
      )}
      {block.rows.map((b) => <BuildRowView key={b.run._id} row={b} now={now} focused={at(b.order)} index={b.order} />)}
    </div>
  );
}

function BuildRowView({ row, now, focused, index }: { row: BuildBlock["rows"][number]; now: number; focused: boolean; index: number }) {
  const r = row.run;
  const ref = row.task?.short_id ?? r.task_short_id;
  const old = now - row.since > DAY;
  return (
    <RowLink href={runHref(r._id)} focused={focused} index={index} className={row.stalled ? "opacity-60" : undefined}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 w-1.5 h-1.5 rounded-full shrink-0", row.stalled ? "border border-sol-text-dim" : r.status === "paused" ? "bg-sol-yellow" : "line-live-dot")} />
        <span className="text-[12.5px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0" title={row.name}>{row.name}</span>
        <span className={cn("text-[11px] tabular-nums shrink-0", old ? "text-sol-orange" : "text-sol-text-dim")} title={old ? "at this step over a day" : undefined}>{formatElapsed(row.since, now)}</span>
      </div>
      <div className="mt-1 pl-3.5 flex items-center gap-1.5 text-[10.5px] text-sol-text-dim min-w-0">
        {row.chip && <span className="shrink-0 max-w-[60%] truncate px-1.5 rounded border border-sol-border/60 text-sol-text-muted">{row.chip}</span>}
        {row.workflow && <span className="truncate">{row.workflow}</span>}
        {ref && <span className="ml-auto font-mono shrink-0">{ref}</span>}
      </div>
      {row.node?.activity && <div className="mt-1 pl-3.5 text-[10.5px] text-sol-text-muted truncate" title={row.node.activity}>{row.node.activity}</div>}
    </RowLink>
  );
}

function WatchRowView({ row, focused, index }: { row: WatchRow; focused: boolean; index: number }) {
  const span = Math.max(1, Math.ceil((row.until - (row.task.closed_at ?? row.until - 7 * DAY)) / DAY));
  return (
    <RowLink href={taskHref(row.task)} focused={focused} index={index}>
      <div className="flex items-start gap-2">
        <span className="text-[12.5px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0">{row.task.title}</span>
        <span className="text-[11px] text-sol-text tabular-nums shrink-0">{row.daysLeft}d left</span>
      </div>
      <div className="line-bar mt-1.5 h-[3px] rounded-full overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, (row.daysLeft / span) * 100))}%` }} />
      </div>
      <div className="mt-1 flex gap-2 text-[10.5px] text-sol-text-dim">
        <span>×{row.task.cause?.signal_count ?? 0} before ship</span>
        <span className="ml-auto font-mono">{row.task.short_id}</span>
      </div>
    </RowLink>
  );
}

const OUTCOME: Record<ClosedRow["outcome"], { glyph: string; tone: string }> = {
  shipped: { glyph: "✓", tone: "text-sol-green" },
  resolved: { glyph: "◆", tone: "text-sol-text-muted" },
  dissolved: { glyph: "○", tone: "text-sol-text-dim" },
};

function ClosedRowView({ row, now, focused, index }: { row: ClosedRow; now: number; focused: boolean; index: number }) {
  const o = OUTCOME[row.outcome];
  return (
    <RowLink href={taskHref(row.task)} focused={focused} index={index}>
      <div className="flex items-start gap-2">
        <span className={cn("text-[12px] w-3 shrink-0", o.tone)}>{o.glyph}</span>
        <span className={cn("text-[12.5px] leading-snug line-clamp-2 flex-1 min-w-0", row.outcome === "dissolved" ? "text-sol-text-muted" : "text-sol-text")}>{row.task.title}</span>
      </div>
      <div className="mt-1 pl-5 flex gap-2 text-[10.5px] text-sol-text-dim min-w-0">
        <span className="truncate"><span className={o.tone}>{row.outcome}</span> · {formatElapsed(row.at, now)} ago</span>
        <span className="ml-auto shrink-0 font-mono">{row.task.short_id}</span>
      </div>
    </RowLink>
  );
}
