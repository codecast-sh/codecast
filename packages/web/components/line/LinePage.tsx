"use client";
// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one horizontal flow, from what the world reported to what
// closed this week. Paints from the store: signals (useSyncSignals), tasks
// with a `cause`, runs (useSyncRuns) and the decision queue. lib/lineFlow
// derives every column, stage state and the throughput strip.
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import {
  buildLineFlow, isLineCard, DAY,
  type BuildRow, type CauseRow, type ClosedRow, type Column, type GoalRow, type LineCauseTask, type LineFlowRun, type SenseSource, type StageState, type WatchRow,
} from "../../lib/lineFlow";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { DecisionCompactCard } from "../decisions/DecisionCompactCard";
import "./line.css";

const RUNS_FEED = { limit: 200 };

const causeSig = (t: TaskItem & LineCauseTask) =>
  t.cause ? `${t.status}|${t.updated_at ?? 0}|${t.watch_until ?? 0}|${t.goal_ref ?? ""}|${t.cause.signal_count}|${t.priority ?? ""}|${t.closed_at ?? 0}` : "";
const projectSig = (p: { title?: string; priority?: string; short_id?: string }) => `${p.short_id ?? ""}|${p.title ?? ""}|${p.priority ?? ""}`;
const cardSig = (d: SessionDecisionItem) => `${d.status}|${d.updated_at ?? 0}|${d.task_id ?? ""}|${d.workflow_run_id ?? ""}`;

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
type Station = { key: StationKey; name: string; stage: string; wide?: boolean };

const STATIONS: Station[] = [
  { key: "sense", name: "Sense", stage: "var(--sol-cyan)" },
  { key: "causes", name: "Causes", stage: "var(--sol-orange)" },
  { key: "build", name: "In build", stage: "var(--sol-blue)" },
  { key: "awaiting", name: "Awaiting you", stage: "var(--sol-yellow)", wide: true },
  { key: "watching", name: "Watching", stage: "var(--sol-violet)" },
  { key: "closed", name: "Closed this week", stage: "var(--sol-green)" },
];

const taskHref = (t: { short_id?: string; _id: string }) => `/tasks/${t.short_id ?? t._id}`;

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
  const buildGroups = useMemo(() => groupBuild(flow.build.items), [flow.build.items]);
  const [parkedOpen, setParkedOpen] = useState(false);

  // Keyboard: one cursor over the whole flow, in render order.
  const hrefs: Record<StationKey, string[]> = useMemo(() => ({
    sense: flow.sense.items.map((s) => { const t = taskById.get(s.newest.task_id); return t ? taskHref(t) : "/line"; }),
    causes: [...flow.causes.items, ...(parkedOpen ? flow.causes.parked : [])].map((r) => taskHref(r.task)),
    build: buildGroups.flatMap((g) => g.rows).map((b) => runHref(b.run._id)),
    awaiting: flow.awaiting.items.map((d) => decisionHref(d)),
    watching: flow.watching.items.map((w) => taskHref(w.task)),
    closed: flow.closed.items.map((c) => taskHref(c.task)),
  }), [flow, buildGroups, taskById, parkedOpen]);

  const firstBusy = Math.max(0, STATIONS.findIndex((s) => s.key === "awaiting" && flow.awaiting.count > 0));
  const [focus, setFocus] = useState<{ col: number; row: number }>({ col: firstBusy, row: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const col = Math.min(focus.col, STATIONS.length - 1);
  const rows = hrefs[STATIONS[col].key].length;
  const row = Math.min(focus.row, Math.max(0, rows - 1));

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const move = (dc: number, dr: number) => {
        e.preventDefault();
        setFocus((f) => {
          const c = Math.max(0, Math.min(STATIONS.length - 1, Math.min(f.col, STATIONS.length - 1) + dc));
          const n = hrefs[STATIONS[c].key].length;
          const r = dc !== 0 ? 0 : Math.max(0, Math.min(n - 1, Math.min(f.row, Math.max(0, n - 1)) + dr));
          return { col: c, row: r };
        });
      };
      if (e.key === "ArrowRight" || e.key === "l") return move(1, 0);
      if (e.key === "ArrowLeft" || e.key === "h") return move(-1, 0);
      if (e.key === "ArrowDown" || e.key === "j") return move(0, 1);
      if (e.key === "ArrowUp" || e.key === "k") return move(0, -1);
      if (e.key === "Enter") {
        const href = hrefs[STATIONS[col].key][row];
        if (href) { e.preventDefault(); router.push(href); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hrefs, col, row, router]);

  // Keep the cursor on screen: the station sideways, the row inside it.
  useWatchEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const station = root.querySelector<HTMLElement>(`[data-line-col="${col}"]`);
    station?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    station?.querySelector<HTMLElement>(`[data-line-row="${row}"]`)?.scrollIntoView({ block: "nearest" });
  }, [col, row]);

  const columns: Record<StationKey, Column<unknown>> = flow as unknown as Record<StationKey, Column<unknown>>;
  const at = (key: StationKey, i: number) => STATIONS[col].key === key && row === i;

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-4 flex flex-col gap-4">
        <div className="flex items-end gap-3 flex-wrap">
          <h1 className="text-xl text-sol-text leading-none">The line</h1>
          <span className="hidden sm:inline text-[12px] text-sol-text-dim leading-none pb-px">from a signal in the world to a shipped, watched change</span>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-sol-text-dim">
            <Link href="/questions" className="hover:text-sol-text">all questions</Link>
            <Link href="/routines" className="hover:text-sol-text">workflows</Link>
          </div>
        </div>
        <Throughput t={flow.throughput} />
      </header>

      <div ref={scroller} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory sm:snap-none" data-line-flow>
        <div className="h-full flex items-stretch px-4 sm:px-6 pb-4 w-max">
          {STATIONS.map((s, i) => (
            <div key={s.key} className="flex items-stretch">
              {i > 0 && <Rail stage={s.stage} live={columns[s.key].state.kind === "running" && columns[s.key].count > 0} />}
              <StationColumn
                station={s}
                index={i}
                column={columns[s.key]}
                focused={col === i}
                now={now}
                onFocus={() => setFocus({ col: i, row: 0 })}
              >
                {s.key === "sense" && (flow.sense.items.length === 0
                  ? <Empty what="Finders write here: Sentry, PostHog, evals, lessons, or a person." cmd={'cast signal add --source person --kind bug --fingerprint <key> --title "<what you saw>"'} />
                  : flow.sense.items.map((src, r) => <SenseRow key={src.source} src={src} now={now} focused={at("sense", r)} index={r} href={hrefs.sense[r]} />))}

                {s.key === "causes" && (flow.causes.count === 0
                  ? <Empty what="A signal opens a cause, or joins the open one with its fingerprint." cmd="cast signal ls" />
                  : <>
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

                {s.key === "build" && (flow.build.count === 0
                  ? <Empty what="The sweep starts the top cause while you hold fewer than five open cards." cmd="cast workflow run line --task ct-N" />
                  : buildGroups.map((g) => (
                      <div key={g.label} className="mb-2">
                        <div className="flex items-center gap-2 px-1 pb-1 text-[11px] text-sol-text-dim">
                          <span className="w-1 h-1 rounded-full" style={{ background: s.stage }} />
                          <span className="text-sol-text-muted">{g.label}</span>
                          <span className="ml-auto">{g.rows.length}</span>
                        </div>
                        {g.rows.map((b) => <BuildRowView key={b.run._id} row={b} now={now} focused={at("build", b.order)} index={b.order} />)}
                      </div>
                    )))}

                {s.key === "awaiting" && (flow.awaiting.count === 0
                  ? <Empty what="Each run ends in one change card with its proof. Cards wait here for your answer." cmd="cast workflow runs" />
                  : <div className="space-y-2">
                      {flow.awaiting.items.map((d, r) => (
                        <div key={d._id} data-line-row={r} className={cn("rounded-lg transition-shadow", col === 3 && row === r && "ring-2 ring-sol-yellow/40")}>
                          <DecisionCompactCard decision={d as SessionDecisionItem} keys={col === 3 && row === r} />
                        </div>
                      ))}
                    </div>)}

                {s.key === "watching" && (flow.watching.count === 0
                  ? <Empty what="A shipped cause is watched. A repeat of one of its signals reopens it; a quiet watch resolves it." cmd="cast task update ct-N --watch-days 7" />
                  : flow.watching.items.map((w, r) => <WatchRowView key={w.task._id} row={w} focused={at("watching", r)} index={r} />))}

                {s.key === "closed" && (flow.closed.count === 0
                  ? <Empty what="Causes shipped, dissolved or resolved in the last seven days." cmd="cast task ls --status done" />
                  : flow.closed.items.map((c, r) => <ClosedRowView key={c.task._id} row={c} now={now} focused={at("closed", r)} index={r} />))}
              </StationColumn>
            </div>
          ))}
        </div>
      </div>

      <footer className="shrink-0 hidden sm:flex items-center gap-4 px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
        <span className="flex items-center gap-1"><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> stations</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> items</span>
        <span className="flex items-center gap-1"><KeyCap size="xs">return</KeyCap> open</span>
        {flow.awaiting.count > 0 && <span className="flex items-center gap-1"><KeyCap size="xs">1</KeyCap>to<KeyCap size="xs">9</KeyCap> answer the focused card</span>}
      </footer>
    </div>
  );
}

// ── Throughput ──

function Throughput({ t }: { t: ReturnType<typeof buildLineFlow>["throughput"] }) {
  const cells: Array<{ label: string; value: string; tone?: string }> = [
    { label: "signals in", value: String(t.signalsIn) },
    { label: "causes opened", value: String(t.opened) },
    { label: "dissolved", value: String(t.dissolved) },
    { label: "shipped", value: String(t.shipped), tone: t.shipped ? "text-sol-green" : undefined },
    { label: "reopened in watch", value: String(t.reopened), tone: t.reopened ? "text-sol-red" : undefined },
    { label: "signal to ship", value: t.medianToShip === null ? "n/a" : formatElapsed(0, t.medianToShip) ?? "n/a" },
    { label: "tokens per ship", value: t.tokensPerShip === null ? "n/a" : formatTokens(Math.round(t.tokensPerShip)) },
  ];
  return (
    <div className="line-meter rounded-xl flex overflow-x-auto sm:grid sm:grid-cols-4 lg:grid-cols-7 sm:overflow-hidden" data-line-throughput>
      {cells.map((c) => (
        <div key={c.label} className="px-4 py-3 shrink-0 min-w-[7.5rem] sm:min-w-0">
          <div className={cn("line-num text-[22px] sm:text-[28px] text-sol-text", c.tone, c.value === "n/a" && "text-sol-text-dim text-[18px] sm:text-[22px]")}>{c.value}</div>
          <div className="mt-1.5 text-[11px] text-sol-text-dim truncate">{c.label}</div>
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
  return `running · ${state.why}`;
}

function StationColumn({ station, index, column, focused, now, onFocus, children }: {
  station: Station;
  index: number;
  column: Column<unknown>;
  focused: boolean;
  now: number;
  onFocus: () => void;
  children: ReactNode;
}) {
  const state = column.state;
  const tone = state.kind === "failing" ? "text-sol-red" : state.kind === "paused" ? "text-sol-yellow" : state.kind === "starved" ? "text-sol-text-dim" : "text-sol-text-muted";
  return (
    <section
      data-line-col={index}
      data-station={station.key}
      data-focused={focused ? "true" : undefined}
      data-state={state.kind}
      onMouseDown={onFocus}
      className={cn("line-col relative rounded-[10px] flex flex-col min-h-0 snap-center shrink-0", station.wide ? "w-[86vw] sm:w-[420px]" : "w-[86vw] sm:w-[300px]")}
      style={{ "--stage": station.stage, "--i": index } as CSSProperties}
    >
      <div className="px-3.5 pt-4 pb-3 border-b border-sol-border/25">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-sol-text-dim tabular-nums">0{index + 1}</span>
          <h2 className="text-[13px] text-sol-text">{station.name}</h2>
          <span className="line-num line-col-count ml-auto text-[30px] text-sol-text">{column.count}</span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] min-w-0">
          <span className="line-lamp" data-kind={state.kind} />
          <span className={cn("truncate", tone)} title={stateWords(state, now)}>{stateWords(state, now)}</span>
          {column.oldestAt && <span className="ml-auto shrink-0 text-sol-text-dim" title="the oldest item here">oldest {formatElapsed(column.oldestAt, now)}</span>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2" data-line-body>
        {children}
      </div>
    </section>
  );
}

function Rail({ stage, live }: { stage: string; live: boolean }) {
  return (
    <div className="w-5 sm:w-7 shrink-0 flex flex-col" aria-hidden>
      <div className="h-[46px]" />
      <div className="line-rail" data-live={live ? "true" : undefined} style={{ "--stage": stage } as CSSProperties} />
    </div>
  );
}

function Empty({ what, cmd }: { what: string; cmd: string }) {
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[12px] text-sol-text-muted leading-relaxed">{what}</p>
      <code className="line-cmd mt-3 inline-block max-w-full rounded px-2 py-1 text-[10.5px] text-sol-text-dim break-all text-left">{cmd}</code>
    </div>
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
        <span className="text-[10px] text-sol-text-dim">{src.kinds.join(" · ")}</span>
        <span className="ml-auto text-[12px] text-sol-text tabular-nums">{src.day}<span className="text-sol-text-dim"> / {src.week}</span></span>
      </div>
      <div className="mt-1.5"><Spark values={src.spark} /></div>
      <div className="mt-1 text-[11px] text-sol-text-dim truncate" title={src.newest.title}>
        {src.newest.title} · {formatElapsed(src.newest.created_at, now)}
      </div>
    </RowLink>
  );
}

const GOAL_TONE: Record<string, string> = {
  initiative: "border-sol-orange/40 text-sol-orange",
  project: "border-sol-blue/40 text-sol-blue",
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

type BuildGroup = { label: string; rows: Array<BuildRow & { order: number }> };

function groupBuild(items: BuildRow[]): BuildGroup[] {
  const groups = new Map<string, BuildRow[]>();
  for (const b of items) {
    const label = b.stalled ? "stalled, silent for a day" : b.node?.label ?? (b.run.status === "pending" ? "starting" : "running");
    groups.set(label, [...(groups.get(label) ?? []), b]);
  }
  let order = 0;
  return [...groups].map(([label, rows]) => ({ label, rows: rows.map((r) => ({ ...r, order: order++ })) }));
}

function BuildRowView({ row, now, focused, index }: { row: BuildRow; now: number; focused: boolean; index: number }) {
  const r = row.run;
  const title = row.task?.title ?? r.task_title ?? r.goal_override ?? r.workflow_name ?? "a run";
  return (
    <RowLink href={runHref(r._id)} focused={focused} index={index} className={row.stalled ? "opacity-60" : undefined}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 w-1.5 h-1.5 rounded-full shrink-0", row.stalled ? "border border-sol-text-dim" : r.status === "paused" ? "bg-sol-yellow" : "bg-sol-blue animate-pulse")} />
        <span className="text-[12.5px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0">{title}</span>
        <span className="text-[11px] text-sol-text tabular-nums shrink-0">{formatElapsed(row.since, now)}</span>
      </div>
      <div className="mt-1 pl-3.5 flex items-center gap-1.5 text-[10.5px] text-sol-text-dim min-w-0">
        {r.workflow_name && r.workflow_name !== title && <span className="truncate">{r.workflow_name}</span>}
        {(row.task?.short_id ?? r.task_short_id) && <span className="ml-auto font-mono shrink-0">{row.task?.short_id ?? r.task_short_id}</span>}
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
      <div className="mt-1 flex text-[10.5px] text-sol-text-dim">
        <span>×{row.task.cause?.signal_count ?? 0} before ship</span>
        <span className="ml-auto font-mono">{row.task.short_id}</span>
      </div>
    </RowLink>
  );
}

const OUTCOME: Record<ClosedRow["outcome"], { glyph: string; tone: string }> = {
  shipped: { glyph: "✓", tone: "text-sol-green" },
  resolved: { glyph: "◆", tone: "text-sol-violet" },
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
      <div className="mt-1 pl-5 flex text-[10.5px] text-sol-text-dim">
        <span className={o.tone}>{row.outcome}</span>
        <span>&nbsp;· {formatElapsed(row.at, now)} ago</span>
        <span className="ml-auto font-mono">{row.task.short_id}</span>
      </div>
    </RowLink>
  );
}
