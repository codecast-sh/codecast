"use client";
// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one horizontal flow, from what the world reported to what
// closed this week. Paints from the store: signals (useSyncSignals), tasks
// with a `cause`, runs (useSyncRuns) and the decision queue. lib/lineFlow
// derives every column, stage state and the throughput strip. One project's
// line at a time (line-profile.md LP1): LineProjects holds the switcher and
// the "all projects" roll-up, and scopeLine narrows the rows.
import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
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
  ageShort, buildLineFlow, groupBuild, isLineCard, lineHeadline, lineRollup, scopeLine, ALL_PROJECTS, DAY,
  type LineProject, type BuildBlock, type HeadlinePart, type CauseRow, type ClosedRow, type Column, type GoalRow, type LineCauseTask, type LineFlowRun, type SenseSource, type StageState, type WatchRow,
} from "../../lib/lineFlow";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { LineProjectSwitcher, LineRollup, lineKeys, useLineProject } from "./LineProjects";
import { DecisionCompactCard } from "../decisions/DecisionCompactCard";
import { cardAnswerIndexes } from "../decisions/ChangeCardView";
import "./line.css";

const RUNS_FEED = { limit: 200 };

const causeSig = (t: TaskItem & LineCauseTask) =>
  t.cause ? `${t.status}|${t.updated_at ?? 0}|${t.watch_until ?? 0}|${t.goal_ref ?? ""}|${t.cause.signal_count}|${t.priority ?? ""}|${t.closed_at ?? 0}|${t.resolved_at ?? 0}|${t.project_id ?? ""}` : `|${t.project_id ?? ""}`;
const projectSig = (p: LineProject) => `${p.short_id ?? ""}|${p.title ?? ""}|${p.priority ?? ""}|${p.project_path ?? ""}|${p.line_profile?.changed_at ?? 0}`;
const cardSig = (d: SessionDecisionItem) => `${d.status}|${d.updated_at ?? 0}|${d.task_id ?? ""}|${d.workflow_run_id ?? ""}`;

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
/** what and cmd teach an empty station: what feeds it, and the command. */
type Station = { key: StationKey; name: string; short: string; sub?: string; wide?: boolean; what: string; cmd: string };

const STATIONS: Station[] = [
  { key: "sense", name: "Sense", short: "Sense", sub: "last 24h", what: "Finders write signals here: Sentry, PostHog, evals, lessons, or a person.", cmd: "cast signal add" },
  { key: "causes", name: "Causes", short: "Causes", what: "A signal opens a cause, or joins the open one that shares its fingerprint.", cmd: "cast signal ls" },
  { key: "build", name: "In build", short: "Build", what: "The sweep starts the top cause while you hold fewer than five open cards.", cmd: "cast workflow run line --task ct-N" },
  { key: "awaiting", name: "Awaiting you", short: "Yours", wide: true, what: "Each run ends in one change card with its proof. Cards wait here for your answer.", cmd: "cast workflow runs" },
  { key: "watching", name: "Watching", short: "Watch", what: "A shipped cause is watched. A repeat of its signal reopens it; a quiet watch resolves it.", cmd: "cast task update ct-N --watch-days 7" },
  { key: "closed", name: "Closed", short: "Closed", sub: "last 7d", what: "Causes shipped, dissolved or resolved in the last seven days.", cmd: "cast task ls -s done" },
];

/** The first command a new line needs: file one signal by hand. */
const FIRST_SIGNAL = `cast signal add --source person --kind bug --title "What you saw"`;

const taskHref = (t: { short_id?: string; _id: string }) => `/tasks/${t.short_id ?? t._id}`;

// Columns size from the flow's own width (a container query), so the inbox
// panel opening narrows the line the way a smaller window does. An empty
// station is a slimmer tile so the live ones get the width, and its command
// wraps at flag boundaries. The tight set takes over under 1360px and the
// compact one under 1000px, where an idle station still reads its name,
// count and what feeds it. Only under 840px does an empty station fold to a
// 40px labelled slot (lamp, count, name) so the stations holding work keep
// their width. Below sm the stations snap one per screen and scroll sideways.
const ROOMY = { rail: "24px", empty: "minmax(148px, 0.6fr)", wide: "minmax(256px, 1.4fr)", live: "minmax(180px, 1fr)" };
const TIGHT = { rail: "12px", empty: "minmax(136px, 0.55fr)", wide: "minmax(216px, 1.4fr)", live: "minmax(156px, 1fr)" };
const COMPACT = { rail: "8px", empty: "minmax(112px, 0.5fr)", wide: "minmax(208px, 1.3fr)", live: "minmax(168px, 1fr)" };
const SLIM = { rail: "10px", empty: "40px", wide: "minmax(232px, 1.4fr)", live: "minmax(168px, 1fr)" };
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
  const projects = useWorkspaceCollection<LineProject>("projects", projectSig);

  // One project's line (LP1): the roll-up counts every line, the switcher
  // picks one, and the flow below is built from that project's rows only.
  const lineRows = useMemo(() => ({ signals, tasks, runs, decisions: cards as Array<SessionDecisionItem & { created_at?: number }> }), [signals, tasks, runs, cards]);
  const rollup = useMemo(() => lineRollup(lineRows, projects, now), [lineRows, projects, now]);
  const line = useLineProject(rollup, projects);
  // With no line anywhere the roll-up has nothing to count: the page teaches instead.
  const rollupView = line.key === ALL_PROJECTS && rollup.length > 0;
  const finders = useMemo(() => projects.find((p) => p._id === line.key)?.line_profile?.finders, [projects, line.key]);

  const flow = useMemo(() => buildLineFlow({
    ...scopeLine(lineRows, line.key),
    initiatives: initiatives.map((i: InitiativeRow) => ({ short_id: i.short_id, title: i.title, priority: i.priority as GoalRow["priority"] })),
    projects,
    now,
    finders,
  }), [lineRows, line.key, initiatives, projects, now, finders]);

  // Every ranked cause lacks a goal: said once in the header, not per row.
  const ungrounded = flow.causes.items.length > 0 && flow.causes.items.every((c) => c.goal.kind === "ungrounded");
  const taskById = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks]);
  const buildBlocks = useMemo(() => groupBuild(flow.build.items), [flow.build.items]);
  const [parkedOpen, setParkedOpen] = useState(false);

  // Keyboard: one cursor over the whole flow, in render order.
  const hrefs: Record<StationKey, string[]> = useMemo(() => ({
    sense: flow.sense.items.map((s) => { const t = s.newest ? taskById.get(s.newest.task_id) : undefined; return t ? taskHref(t) : line.href; }),
    causes: [...flow.causes.items, ...(parkedOpen ? flow.causes.parked : [])].map((r) => taskHref(r.task)),
    build: buildBlocks.flatMap((g) => g.rows).map((b) => runHref(b.run._id)),
    awaiting: flow.awaiting.items.map((d) => decisionHref(d)),
    watching: flow.watching.items.map((w) => taskHref(w.task)),
    closed: flow.closed.items.map((c) => taskHref(c.task)),
  }), [flow, buildBlocks, taskById, parkedOpen, line.href]);

  const columns: Record<StationKey, Column<unknown>> = flow as unknown as Record<StationKey, Column<unknown>>;
  // Sense counts today's signals but lists the week's sources.
  const empty = (key: StationKey) => (key === "sense" ? flow.sense.items.length === 0 : columns[key].count === 0);
  // Nothing anywhere: the floor folds into one band that teaches the start.
  const allEmpty = STATIONS.every((s) => empty(s.key));

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
      // Sideways skips stations with nothing in them, unless every station
      // is empty; a number jumps to any.
      const side = (dc: number) => {
        e.preventDefault();
        for (let c = col + dc; c >= 0 && c < STATIONS.length; c += dc) {
          if (allEmpty || hrefs[STATIONS[c].key].length > 0) return setFocus({ col: c, row: 0 });
        }
      };
      const down = (dr: number) => {
        e.preventDefault();
        setFocus({ col, row: Math.max(0, Math.min(rows - 1, row + dr)) });
      };
      // Brackets walk the lines: the roll-up, then each project.
      if ((e.key === "[" || e.key === "]") && rollup.length > 0) {
        e.preventDefault();
        const keys = lineKeys(rollup);
        const idx = Math.max(0, keys.indexOf(line.key));
        setFocus(null);
        return line.select(keys[(idx + (e.key === "]" ? 1 : -1) + keys.length) % keys.length]);
      }
      if (rollupView) return;
      if (e.key === "ArrowRight" || e.key === "l") return side(1);
      if (e.key === "ArrowLeft" || e.key === "h") return side(-1);
      if (e.key === "ArrowDown" || e.key === "j") return down(1);
      if (e.key === "ArrowUp" || e.key === "k") return down(-1);
      // Shift and a digit jumps to a station. A bare digit belongs to the card
      // under the cursor, which answers with it (DecisionAnswerControls).
      const jump = e.shiftKey && /^Digit\d$/.test(e.code) ? Number(e.code.slice(5)) : 0;
      if (jump >= 1 && jump <= STATIONS.length) { e.preventDefault(); return setFocus({ col: jump - 1, row: 0 }); }
      if ((e.key === "c" || e.key === "C") && rows === 0) { e.preventDefault(); void copyText(allEmpty ? FIRST_SIGNAL : STATIONS[col].cmd, "Command copied"); return; }
      if (e.key === "Enter" && !cardTakesReturn) {
        const href = hrefs[STATIONS[col].key][row];
        if (href) { e.preventDefault(); router.push(href); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hrefs, col, row, rows, router, cardTakesReturn, allEmpty, rollup, line, rollupView]);

  // Keep the cursor on screen: the station sideways, the row inside it.
  useWatchEffect(() => {
    const root = scroller.current;
    if (!root || !moved) return;
    const station = root.querySelector<HTMLElement>(`[data-line-col="${col}"]`);
    station?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    station?.querySelector<HTMLElement>(`[data-line-row="${row}"]`)?.scrollIntoView({ block: "nearest" });
  }, [col, row]);

  const at = (key: StationKey, i: number) => STATIONS[col].key === key && row === i;
  const grid = {
    "--line-cols": template(ROOMY, (s) => empty(s.key)),
    "--line-cols-tight": template(TIGHT, (s) => empty(s.key)),
    "--line-cols-compact": template(COMPACT, (s) => empty(s.key)),
    "--line-cols-slim": template(SLIM, (s) => empty(s.key)),
    "--line-cols-narrow": template(NARROW, (s) => empty(s.key)),
  } as CSSProperties;

  const options = Math.min(9, focusedCard?.options?.length ?? 0);
  // On narrow screens the stations snap one per screen: track which one shows.
  const [shown, setShown] = useState(0);
  const onFlowScroll = () => {
    const root = scroller.current;
    if (!root) return;
    // Rects, not offsetLeft: offsetLeft counts from the nearest positioned
    // ancestor, which is outside the scroller and shifts with the layout.
    const box = root.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    let best = 0;
    let bestGap = Infinity;
    root.querySelectorAll<HTMLElement>("[data-line-col]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const gap = Math.abs(r.left + r.width / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = Number(el.dataset.lineCol); }
    });
    if (best !== shown) setShown(best);
  };
  const showStation = (i: number) => {
    setFocus({ col: i, row: 0 });
    setShown(i);
    scroller.current?.querySelector<HTMLElement>(`[data-line-col="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  };

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-4 flex flex-col gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[13px] font-semibold text-sol-text leading-none">The line</h1>
          <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">a signal in the world to a shipped, watched change</span>
        </div>
        <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={(k) => { setFocus(null); line.select(k); }} />
        {!allEmpty && !rollupView && <><Headline parts={lineHeadline(flow, now)} onStation={(key) => showStation(STATIONS.findIndex((x) => x.key === key))} /><Throughput t={flow.throughput} /></>}
      </header>

      {rollupView ? <LineRollup rollup={rollup} onSelect={(k) => { setFocus(null); line.select(k); }} /> : allEmpty ? <Onboarding focusedCol={col} onFocus={(i) => setFocus({ col: i, row: 0 })} /> : (<>
      <nav className="line-tabs sm:hidden shrink-0 flex gap-1 overflow-x-auto px-4 pb-2" aria-label="Stations">
        {STATIONS.map((s, i) => (
          <button key={s.key} onClick={() => showStation(i)} data-active={shown === i ? "true" : undefined} className="line-tab shrink-0 rounded-full px-2.5 py-1 text-[11px] whitespace-nowrap">
            {s.short} <span className="tabular-nums" data-zero={columns[s.key].count === 0 ? "true" : undefined}>{columns[s.key].count}</span>
          </button>
        ))}
      </nav>

      <div ref={scroller} onScroll={onFlowScroll} className="line-flow flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory sm:snap-none" data-line-flow>
        <div className="line-track h-full px-4 sm:px-5 pb-4" style={grid}>
          {STATIONS.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && <Rail live={!empty(s.key)} />}
              <StationColumn
                station={s}
                index={i}
                column={columns[s.key]}
                empty={empty(s.key)}
                moved={flow.moved[s.key as keyof typeof flow.moved] ?? 0}
                week={s.key === "sense" ? flow.throughput.signalsIn : undefined}
                focused={col === i}
                now={now}
                onFocus={() => setFocus({ col: i, row: 0 })}
                note={s.key === "causes" && ungrounded ? <>None of these serve a goal yet. <code className="text-sol-text-muted">cast task update ct-N --goal-ref in-N:key</code></> : undefined}
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
                        <div key={d._id} data-line-row={r} data-focused={at("awaiting", r) ? "true" : undefined} className="line-card rounded-lg">
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
      </>)}

      <footer className="shrink-0 flex items-center gap-4 px-4 sm:px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
        {rollup.length > 0 && <Hint label="projects"><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap></Hint>}
        {!rollupView && <>
        <Hint label="stations"><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap></Hint>
        <Hint label="items"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap></Hint>
        <Hint label="jump to a station"><KeyCap size="xs">Shift</KeyCap><KeyCap size="xs">1</KeyCap>-<KeyCap size="xs">{String(STATIONS.length)}</KeyCap></Hint>
        <span className="ml-auto hidden sm:flex items-center gap-4 min-w-0" data-line-hint>
          {focusedCard && options > 0 && <Hint label="answer the card" className="text-sol-yellow/90"><KeyCap size="xs">1</KeyCap>{options > 1 && <>-<KeyCap size="xs">{String(options)}</KeyCap></>}</Hint>}
          {rows > 0
            ? <Hint label={cardTakesReturn ? "submit" : "open"}><KeyCap size="xs">↵</KeyCap></Hint>
            : <Hint label={allEmpty ? "copy the first command" : "copy the command"}><KeyCap size="xs">c</KeyCap></Hint>}
        </span>
        </>}
        <span className="ml-auto sm:ml-0 shrink-0 whitespace-nowrap flex items-center gap-3 pl-3 sm:border-l border-sol-border/40">
          <Link href="/questions" className="hover:text-sol-text">all questions</Link>
          <Link href="/routines" className="hover:text-sol-text">workflows</Link>
        </span>
      </footer>
    </div>
  );
}

/** A footer key hint. Its words drop on a narrow floor (line.css), and the
 *  tooltip keeps saying them. */
function Hint({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <span className={cn("hidden sm:flex items-center gap-1 whitespace-nowrap shrink-0", className)} title={label}>
      {children}<span className="line-hint-text">{label}</span>
    </span>
  );
}

// ── Headline and throughput ──

// Color only what needs the founder: cards waiting, a stall, a failure.
// An all-clear part is plain text.
const TONE: Record<HeadlinePart["tone"], string> = {
  ask: "text-sol-yellow",
  warn: "text-sol-orange",
  fail: "text-sol-red",
  live: "",
  calm: "",
  clear: "",
};

/** The sentence's counts in bold, so the numbers are what the eye lands on. */
const boldNumbers = (text: string) => text.split(/(\d+)/).map((t, i) => (i % 2 ? <b key={i} className="font-semibold">{t}</b> : t));

/** The five-second read. A part that names a station links to it: the
 *  cursor moves there and the flow scrolls it into view. */
function Headline({ parts, onStation }: { parts: HeadlinePart[]; onStation: (key: StationKey) => void }) {
  return (
    <p className="line-headline text-sol-text" data-line-headline>
      {parts.map((p, i) => {
        const text = i === 0 ? p.text.charAt(0).toUpperCase() + p.text.slice(1) : p.text;
        const station = p.station;
        // The comma rides the part before it, so a wrap never opens a line with one.
        const sep = i < parts.length - 1 ? ", " : "";
        return (
          <Fragment key={i}>
            {station
              ? <a href={`#line-${station}`} onClick={(e) => { e.preventDefault(); onStation(station); }} className={cn("line-headline-link", TONE[p.tone])} data-line-headline-link={station}>{boldNumbers(text)}</a>
              : <span className={TONE[p.tone] || undefined}>{boldNumbers(text)}</span>}
            {sep}
          </Fragment>
        );
      })}
      .
    </p>
  );
}

/** A week's bars earn their place with three days that moved; fewer is a
 *  few pixels of nothing, and the number alone says it better. */
const sparkable = (days: number[]) => days.filter((d) => d > 0).length >= 3;

/** A metric with nothing to measure yet: a dim dash, so it never reads as a value. */
function NoValue({ className }: { className?: string }) {
  return <span className={cn("line-num text-sol-text-dim opacity-50", className)} aria-label="no data yet">–</span>;
}

/** "2d", "2d 5h", "40m": the elapsed time without its zero units. */
const compactElapsed = (ms: number) => (formatElapsed(0, ms) ?? "").replace(/ 0[hm]$/, "");

function Throughput({ t }: { t: ReturnType<typeof buildLineFlow>["throughput"] }) {
  // On a phone the strip is one line that opens on tap.
  const [open, setOpen] = useState(false);
  const moved = t.signalsIn + t.opened + t.dissolved + t.shipped + t.reopened > 0;
  if (!moved) {
    return <p className="text-[11px] text-sol-text-dim" data-line-throughput="quiet">No signals this week. Throughput appears once the line moves.</p>;
  }
  // The two numbers a founder reads first lead; the flow counts sit quieter.
  const lead: Array<{ label: string; value: string | number | null; tip: string; spark?: number[] }> = [
    { label: "shipped this week", value: t.shipped, spark: t.daily.shipped, tip: "Causes shipped in the last 7 days, per day" },
    { label: "median signal to ship", value: t.medianToShip === null ? null : compactElapsed(t.medianToShip), tip: "From a cause's first signal to its ship, median over this week's ships" },
  ];
  const flowCells: Array<{ label: string; value: number; tone?: string; spark: number[] }> = [
    { label: "signals in", value: t.signalsIn, spark: t.daily.signalsIn },
    { label: "causes opened", value: t.opened, spark: t.daily.opened },
    { label: "dissolved", value: t.dissolved, spark: t.daily.dissolved },
    { label: "reopened", value: t.reopened, tone: t.reopened ? "text-sol-red" : undefined, spark: t.daily.reopened },
  ];
  const summary = [`${t.shipped} shipped`, t.medianToShip !== null && `${compactElapsed(t.medianToShip)} median`, `${t.signalsIn} in`].filter(Boolean).join(" · ");
  return (
    <>
    <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="line-meter-summary rounded-lg px-3 py-2 text-[12px] text-sol-text-muted items-center gap-1.5 text-left" data-line-throughput-summary>
      <span className="line-num font-normal truncate min-w-0">{summary}</span>
      <ChevronDown className={cn("ml-auto w-3.5 h-3.5 shrink-0 transition-transform", open && "rotate-180")} />
    </button>
    <div className="line-meter rounded-xl" data-open={open ? "true" : undefined} data-line-throughput>
      <div className="line-meter-lead">
        {lead.map((c) => (
          <div key={c.label} className="line-meter-big min-w-0" title={c.tip}>
            <div className="flex items-end gap-2.5 h-[30px]">
              {c.value === null
                ? <NoValue className="text-[28px]" />
                : <span className="line-num line-display-num text-[28px] text-sol-text" data-zero={c.value === 0 ? "true" : undefined}>{c.value}</span>}
              {c.spark && sparkable(c.spark) && <Spark values={c.spark} bar={4} height={20} className="mb-0.5" label={`${c.label}, per day`} />}
            </div>
            <div className="mt-1.5 text-[11px] text-sol-text-muted whitespace-nowrap">{c.label}</div>
          </div>
        ))}
      </div>
      <div className="line-meter-flow">
        {flowCells.map((c) => (
          <div key={c.label} className="min-w-0" title={`${c.label} this week, per day`}>
            <div className="flex items-center gap-1.5">
              <span className={cn("line-num text-[15px] text-sol-text-muted", c.tone)} data-zero={c.value === 0 ? "true" : undefined}>{c.value}</span>
              {sparkable(c.spark) && <Spark values={c.spark} bar={2} height={10} label={`${c.label} per day`} />}
            </div>
            <div className="mt-1 text-[11px] text-sol-text-dim truncate">{c.label}</div>
          </div>
        ))}
        <div className="min-w-0" title="Cost per shipped change, in run tokens. Runs record tokens, not dollars.">
          <div className="flex items-baseline gap-1">
            {t.tokensPerShip === null
              ? <NoValue className="text-[15px]" />
              : <><span className="line-num text-[15px] text-sol-text-muted">{formatTokens(Math.round(t.tokensPerShip))}</span><span className="text-[11px] text-sol-text-dim">tokens</span></>}
          </div>
          <div className="mt-1 text-[11px] text-sol-text-dim truncate">cost per ship</div>
        </div>
      </div>
    </div>
    </>
  );
}

// ── A station ──

function stateWords(state: StageState, now: number): string {
  const since = state.since ? formatElapsed(state.since, now) : null;
  if (state.kind === "idle") return state.why;
  if (state.kind === "ask") return `${state.why}${since ? `, oldest ${since}` : ""}`;
  if (state.kind === "paused") return `paused${since ? ` ${since}` : ""}: ${state.why}`;
  if (state.kind === "failing") return `failing${since ? ` ${since}` : ""}: ${state.why}`;
  if (state.kind === "starved") return `starved: ${state.why}${since ? `, last ${since} ago` : ""}`;
  if (state.kind === "clear") return `clear: ${state.why}`;
  return `running: ${state.why}`;
}

/** The short tag beside the lamp; the why lives in its tooltip, and for a
 *  stage in trouble in one line at the foot of the column. */
function stateTag(state: StageState, oldestAt: number | null, now: number): string {
  const since = state.since ? ` ${ageShort(now - state.since)}` : "";
  if (state.kind === "ask") return `waiting${since}`;
  if (state.kind === "paused" || state.kind === "starved" || state.kind === "failing") return `${state.kind}${since}`;
  // Running is the ordinary case: the header spends its words on the oldest age.
  if (state.kind === "running" && oldestAt) return `oldest ${ageShort(now - oldestAt)}`;
  return state.kind;
}
const TROUBLE = new Set<StageState["kind"]>(["paused", "starved", "failing"]);

const STATE_TONE: Record<StageState["kind"], string> = {
  failing: "text-sol-red",
  paused: "text-sol-yellow",
  starved: "text-sol-orange",
  ask: "text-sol-yellow",
  idle: "text-sol-text-dim",
  clear: "text-sol-text-dim",
  running: "text-sol-text-muted",
};

/** What a station's count measures and what entered it this week, said
 *  beside the count: "today · 5 this week", "+3 this wk". */
function countWords(key: StationKey, count: number, moved: number, week?: number): ReactNode {
  if (key === "sense") return <>today{week !== undefined && week !== count && <span className="line-count-of"> · {week} this week</span>}</>;
  if (key === "closed") return "this week";
  return moved > 0 ? <span title={`${moved} entered this week`}>+{moved} this wk</span> : null;
}

function StationColumn({ station, index, column, empty, moved, week, focused, now, onFocus, note, children }: {
  station: Station;
  /** One line under the count that speaks for every row at once. */
  note?: ReactNode;
  index: number;
  column: Column<unknown>;
  empty: boolean;
  /** What entered this week, said beside the count. */
  moved: number;
  /** Sense only: the week's signals, said dimly beside the 24h count. */
  week?: number;
  focused: boolean;
  now: number;
  onFocus: () => void;
  children: ReactNode;
}) {
  const state = column.state;
  const words = stateWords(state, now);
  const countTip = column.oldestAt ? `oldest ${formatElapsed(column.oldestAt, now)}` : "";
  const unit = empty ? null : countWords(station.key, column.count, moved, week);
  return (
    <section
      data-line-col={index}
      data-station={station.key}
      data-focused={focused ? "true" : undefined}
      data-state={state.kind}
      data-empty={empty ? "true" : undefined}
      onMouseDown={onFocus}
      className="line-col group relative rounded-[10px] flex flex-col min-h-0 min-w-0 snap-center"
      style={{ "--i": index } as CSSProperties}
    >
      {/* Folded: an empty station in a tight flow is a slot that still says
          what it is, how it stands, and how much it holds. */}
      <div className="line-col-slim" title={`${station.name}, ${words}. ${station.what}`} aria-label={`${station.name}, ${column.count}`}>
        <span className="line-num line-display-num text-[17px]" data-zero="true">{column.count}</span>
        <span className="line-lamp" data-kind={state.kind} />
        <span className="line-col-slim-name text-[11px] text-sol-text-muted">{station.name}</span>
      </div>
      <div className="line-col-head shrink-0 px-3 pt-3 pb-3 border-b border-sol-border/25">
        <div className="flex items-center h-[24px] min-w-0">
          <h2 className="text-[13px] font-medium text-sol-text whitespace-nowrap">
            <span className="line-name-full">{station.name}</span>
            <span className="line-name-short">{station.short}</span>
          </h2>
        </div>
        <div className="mt-2 flex items-end gap-2 min-w-0">
          <span className={cn("line-num line-display-num line-col-count text-[34px]", state.kind === "ask" ? "text-sol-yellow" : "text-sol-text")} data-zero={column.count === 0 ? "true" : undefined} title={countTip || undefined}>{column.count}</span>
          {unit && <span className="pb-[3px] text-[11px] text-sol-text-dim whitespace-nowrap min-w-0 truncate" data-line-unit>{unit}</span>}
          <span className={cn("ml-auto pb-[3px] flex items-center gap-1.5 text-[11px] whitespace-nowrap min-w-0", STATE_TONE[state.kind])} data-line-state title={words}>
            <span className="line-lamp" data-kind={state.kind} />
            <span className="line-state-text truncate">{stateTag(state, column.oldestAt, now)}</span>
          </span>
        </div>
        {note && <div className="mt-2 text-[11px] text-sol-text-dim leading-snug" data-line-note>{note}</div>}
      </div>
      <div className={cn("line-col-body min-h-0 flex-1 p-2", !empty && "overflow-y-auto")} data-line-body>
        {children}
      </div>
      {TROUBLE.has(state.kind) && (
        <div className={cn("line-col-why shrink-0 px-3 py-2 text-[11px] truncate", STATE_TONE[state.kind])} title={words} data-line-why>{state.why}</div>
      )}
    </section>
  );
}

function Rail({ live }: { live: boolean }) {
  return (
    <div className="line-rail-slot relative" aria-hidden>
      <div className="line-rail" data-live={live ? "true" : undefined} />
    </div>
  );
}

/** An empty station: what feeds it and the command that does. */
function Empty({ station, focused, after }: { station: Station; focused: boolean; after?: ReactNode }) {
  return (
    <div className="line-empty rounded-lg flex flex-col gap-2.5 p-2.5" data-line-empty title={`${station.what} ${station.cmd}`}>
      <p className="text-[11px] text-sol-text-muted leading-relaxed">{station.what}</p>
      <Cmd cmd={station.cmd} shown={focused} />
      {after}
    </div>
  );
}

/** A command split where it may wrap: the words before the first flag, then
 *  each `--flag value` pair whole. Quoted values stay one token. */
function cmdChunks(cmd: string): string[] {
  const tokens = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const chunks: string[] = [];
  for (const t of tokens) {
    const last = chunks.length - 1;
    const pairs = last >= 0 && chunks[last].startsWith("--") && !chunks[last].includes(" ") && !t.startsWith("--");
    if (pairs) chunks[last] += ` ${t}`;
    else chunks.push(t);
  }
  return chunks;
}

/** A command chip that wraps between words and flag pairs, and splits a pair
 *  at its space only when the pair alone is wider than the chip; a token never
 *  splits, not even at its hyphens. The copy button floats in the first line,
 *  so the lines below it get the chip's full width: shown on hover, or always
 *  when the station holds the cursor. */
function Cmd({ cmd, shown, primary }: { cmd: string; shown?: boolean; primary?: boolean }) {
  return (
    <div className={cn("line-cmd group/cmd relative rounded-md min-w-0", primary && "line-cmd-primary")} data-line-cmd>
      <code className={cn("block whitespace-normal break-normal px-2 py-1.5 leading-[16px]", primary ? "text-[13px] text-sol-text" : "text-[11px] text-sol-text-muted")}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void copyText(cmd, "Command copied"); }}
          title="Copy the command"
          aria-label="Copy the command"
          className={cn(
            "line-cmd-copy float-right ml-1 -mr-1 w-5 h-4 rounded flex items-center justify-center text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-opacity",
            shown || primary ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-hover/cmd:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Copy className="w-3 h-3" />
        </button>
        {cmdChunks(cmd).map((c, i) => (
          <Fragment key={i}>
            {i > 0 && " "}
            <span className="line-cmd-chunk">{c.split(" ").map((t, j) => <Fragment key={j}>{j > 0 && " "}<span className="whitespace-nowrap">{t}</span></Fragment>)}</span>
          </Fragment>
        ))}
      </code>
    </div>
  );
}

/** The line before anything has reached it: the first command, then the six
 *  stations in one row, each saying what will feed it. */
function Onboarding({ focusedCol, onFocus }: { focusedCol: number; onFocus: (i: number) => void }) {
  return (
    <div className="line-onboard flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-5 flex flex-col gap-5" data-line-onboarding>
      <div className="line-start shrink-0 max-w-[760px] rounded-xl p-5 sm:p-6">
        <div className="line-start-title text-sol-text">File the first signal.</div>
        <p className="mt-2 text-[13px] text-sol-text-muted leading-relaxed max-w-[60ch]">
          A signal is one thing someone saw. It opens a cause, the line builds a fix, and you answer one card.
          Sentry, PostHog and evals file their own once connected.
        </p>
        <div className="mt-5"><Cmd cmd={FIRST_SIGNAL} primary /></div>
      </div>
      <div className="line-ghost-scroll shrink-0">
      <ol className="line-ghost" aria-label="Stations">
        {STATIONS.map((s, i) => (
          <li
            key={s.key}
            data-line-col={i}
            data-focused={focusedCol === i ? "true" : undefined}
            onMouseDown={() => onFocus(i)}
            className="line-ghost-col relative rounded-[10px] min-w-0"
            style={{ "--i": i } as CSSProperties}
          >
            <div className="flex items-center h-[24px]">
              <span className="text-[13px] font-medium text-sol-text whitespace-nowrap">{s.name}</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-sol-text-muted">{s.what}</p>
          </li>
        ))}
      </ol>
      </div>
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

/** Bars oldest first; the last few, when non-zero, read bright. */
function Spark({ values, bar = 4, height = 20, label = "signals per day, last 7 days", className }: { values: number[]; bar?: number; height?: number; label?: string; className?: string }) {
  const max = Math.max(1, ...values);
  const gap = 1;
  const hot = Math.max(1, Math.round(values.length / 8));
  return (
    <svg className={cn("line-spark shrink-0", className)} width={values.length * (bar + gap)} height={height} viewBox={`0 0 ${values.length * (bar + gap)} ${height}`} aria-label={label}>
      {values.map((v, i) => {
        const h = v === 0 ? 1 : Math.max(3, Math.round((v / max) * height));
        return <rect key={i} x={i * (bar + gap)} y={height - h} width={bar} height={h} rx={1} data-hot={i >= values.length - hot && v > 0 ? "true" : undefined} opacity={v === 0 ? 0.35 : 1} />;
      })}
    </svg>
  );
}

/** A source of signals: a finder the project's profile declares (LP3), or
 *  one that filed without being declared. A declared finder with nothing in
 *  24 hours says since when it is silent; with nothing in the window, that
 *  it has not filed in two weeks. */
function SenseRow({ src, now, focused, index, href }: { src: SenseSource; now: number; focused: boolean; index: number; href: string }) {
  const f = src.finder;
  const tip = f ? [`finder ${f.id}`, f.kind === "any" ? "any kind" : f.kind.join(", "), f.runs].filter(Boolean).join(" · ") : src.undeclared ? "Files signals here but the project's line profile does not declare it" : undefined;
  return (
    <RowLink href={href} focused={focused} index={index} className={src.day === 0 ? "line-row-quiet" : undefined}>
      <div className="flex items-center gap-2 min-w-0" title={tip}>
        <span className="text-[13px] text-sol-text whitespace-nowrap shrink-0">{src.source}</span>
        {src.undeclared
          ? <span className="text-[11px] text-sol-text-dim italic truncate min-w-0">undeclared</span>
          : <span className="text-[11px] text-sol-text-dim truncate min-w-0">{src.kinds.join(" · ")}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-sol-text-dim tabular-nums whitespace-nowrap" title={`${src.day} in the last 24 hours, ${src.week} this week`}>
          <span className={cn("text-[13px]", src.day > 0 ? "text-sol-text" : "text-sol-text-dim")}>{src.day}</span> today{src.week !== src.day && <span className="line-count-of">, {src.week} this week</span>}
        </span>
      </div>
      {sparkable(src.spark) && <div className="mt-1.5"><Spark values={src.spark} bar={6} height={14} label="signals per day, last 7 days" /></div>}
      {src.newest
        ? (
          <div className="mt-1 text-[11px] text-sol-text-dim truncate" title={src.newest.title}>
            {src.silent && <span className="text-sol-orange" data-line-silent>silent {formatElapsed(src.newest.created_at, now)} · </span>}
            {src.newest.title}{!src.silent && <> · {formatElapsed(src.newest.created_at, now)}</>}
          </div>
        )
        : <div className="mt-1 text-[11px] text-sol-orange truncate" data-line-silent title={f?.runs}>no signal in 14 days{f?.runs ? ` · ${f.runs}` : ""}</div>}
    </RowLink>
  );
}

/** A chip only where a goal exists. Ungrounded causes carry none (the
 *  column header says so once), and parked ones sit under their own fold. */
const GOAL_TONE: Partial<Record<CauseRow["goal"]["kind"], string>> = {
  initiative: "border-sol-text-muted/50 text-sol-text",
  project: "border-sol-border text-sol-text-muted",
  unknown: "border-sol-border text-sol-text-dim",
};

function CauseRowView({ row, rank, max, focused, index, muted }: { row: CauseRow; rank?: number; max: number; focused: boolean; index: number; muted?: boolean }) {
  const t = row.task;
  // The row is a scan line: rank, title, signal count and goal. The rest of
  // the triage sits on hover and on the task page.
  const tip = [t.short_id, t.category, t.risk && t.risk !== "low" ? `${t.risk} risk` : null, `priority ${row.score.toFixed(1)}`].filter(Boolean).join(" · ");
  const unready = t.readiness && t.readiness !== "ready";
  return (
    <RowLink href={taskHref(t)} focused={focused} index={index} className={cn("relative", muted && "opacity-70")}>
      {/* Priority is a meter on the row's left edge that fills upward, never a
          bar across it: a bar under a title reads as progress. */}
      <span className="line-prio" style={{ "--p": `${Math.max(8, Math.min(100, (row.score / (max || 1)) * 100))}%` } as CSSProperties} title={`priority ${row.score.toFixed(1)}`} aria-label={`priority ${row.score.toFixed(1)}`} />
      <div className="flex items-start gap-2" title={tip}>
        {rank !== undefined && <span className="line-num text-[13px] text-sol-text-dim w-4 shrink-0 pt-px">{rank}</span>}
        <span className="text-[13px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0">{t.title}</span>
      </div>
      <div className={cn("mt-1.5 flex items-center gap-1.5 text-[11px] min-w-0", rank !== undefined && "pl-6")}>
        <span className="text-sol-text tabular-nums shrink-0" title="signals attached">×{row.signals}</span>
        {GOAL_TONE[row.goal.kind] && <span className={cn("px-1.5 py-px rounded border min-w-0 truncate", GOAL_TONE[row.goal.kind])} title={row.goal.ref}>{row.goal.label}</span>}
        {unready && <span className="ml-auto shrink-0 text-sol-yellow" title={t.readiness_note ?? undefined}>{t.readiness!.replace("_", " ")}</span>}
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
        <span className="text-[13px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0" title={row.name}>{row.name}</span>
        <span className={cn("text-[11px] tabular-nums shrink-0", old ? "text-sol-orange" : "text-sol-text-dim")} title={old ? "at this step over a day" : undefined}>{formatElapsed(row.since, now)}</span>
      </div>
      <div className="mt-1 pl-3.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim min-w-0">
        {row.chip && <span className="shrink-0 max-w-[60%] truncate px-1.5 rounded border border-sol-border/60 text-sol-text-muted">{row.chip}</span>}
        {row.workflow && <span className="truncate">{row.workflow}</span>}
        {ref && <span className="ml-auto font-mono shrink-0">{ref}</span>}
      </div>
      {row.node?.activity && <div className="mt-1 pl-3.5 text-[11px] text-sol-text-muted truncate" title={row.node.activity}>{row.node.activity}</div>}
    </RowLink>
  );
}

function WatchRowView({ row, focused, index }: { row: WatchRow; focused: boolean; index: number }) {
  const span = Math.max(1, Math.ceil((row.until - (row.task.closed_at ?? row.until - 7 * DAY)) / DAY));
  return (
    <RowLink href={taskHref(row.task)} focused={focused} index={index}>
      <div className="flex items-start gap-2">
        <span className="text-[13px] text-sol-text leading-snug line-clamp-2 flex-1 min-w-0">{row.task.title}</span>
        <span className="text-[11px] text-sol-text tabular-nums shrink-0">{row.daysLeft}d left</span>
      </div>
      <div className="line-countdown mt-1.5" title={`${row.daysLeft} of ${span} watch days left`}>
        <span style={{ "--left": `${Math.max(4, Math.min(100, (row.daysLeft / span) * 100))}%` } as CSSProperties} />
      </div>
      <div className="mt-1 flex gap-2 text-[11px] text-sol-text-dim">
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
        <span className={cn("text-[13px] w-3 shrink-0", o.tone)}>{o.glyph}</span>
        <span className={cn("text-[13px] leading-snug line-clamp-2 flex-1 min-w-0", row.outcome === "dissolved" ? "text-sol-text-muted" : "text-sol-text")}>{row.task.title}</span>
      </div>
      <div className="mt-1 pl-5 flex gap-2 text-[11px] text-sol-text-dim min-w-0">
        <span className="truncate"><span className={o.tone}>{row.outcome}</span> · {formatElapsed(row.at, now)} ago</span>
        <span className="ml-auto shrink-0 font-mono">{row.task.short_id}</span>
      </div>
    </RowLink>
  );
}
