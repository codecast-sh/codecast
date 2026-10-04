"use client";
// The line page (docs/architecture/the-line-end-to-end.md LE13): the whole
// factory as one horizontal flow, from what the world reported to what
// closed this week. Paints from the store (useLineFloor): signals, tasks
// with a `cause`, runs and the decision queue. lib/lineFlow
// derives every column, stage state and the throughput strip. One project's
// line at a time (line-profile.md LP1): LineProjects holds the switcher and
// the "all projects" roll-up, and scopeLine narrows the rows.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { formatTokens } from "@codecast/shared/render/changeCardHtml";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { SessionDecisionItem } from "../../store/inboxStore";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";
import { formatElapsed } from "../../lib/taskLine";
import { runHref, decisionHref } from "../../lib/decisionLinks";
import { cn } from "../../lib/utils";
import { copyText } from "../../lib/copyText";
import {
  ageShort, buildLineFlow, groupBuild, lineHeadline, scopeLine, ALL_PROJECTS, DAY, LINE_STEPS,
  type BuildBlock, type HeadlinePart, type CauseRow, type ClosedRow, type Column, type GoalRow, type SenseSource, type StageState, type WatchRow,
} from "../../lib/lineFlow";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { LineProjectSwitcher, LineRollup, lineKeys } from "./LineProjects";
import { useLineFloor } from "./useLineFloor";
import { DecisionCompactCard } from "../decisions/DecisionCompactCard";
import { edgeAttrs, useScrollEdges } from "./useScrollEdges";
import { cardAnswerIndexes, GoalChip } from "../decisions/ChangeCardView";
import { evalsSenseHref } from "../evals/evalsPaths";
import "./line.css";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";

/** formatElapsed without its zero units: "2d", "2d 5h", "40m", never "2d 0h". */
const ago = (from: number | null | undefined, now: number) => (from == null ? null : (formatElapsed(from, now) ?? "").replace(/ 0[hm]$/, ""));
const compactElapsed = (ms: number) => ago(0, ms) ?? "";

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
/** what and cmd teach an empty station: what feeds it, and the command. */
type Station = { key: StationKey; name: string; short: string; sub?: string; wide?: boolean; slim?: boolean; tail?: boolean; what: string; cmd: string };

const STATIONS: Station[] = [
  { key: "sense", name: "Sense", short: "Sense", sub: "last 24h", slim: true, what: "Finders write signals here: Sentry, PostHog, evals, lessons, or a person.", cmd: "cast signal add" },
  { key: "causes", name: "Causes", short: "Causes", what: "A signal opens a cause, or joins the open one that shares its fingerprint.", cmd: "cast signal ls" },
  { key: "build", name: "In build", short: "In build", what: "The sweep starts the top cause while you hold fewer than five open cards.", cmd: "cast workflow run line --task ct-N" },
  { key: "awaiting", name: "Awaiting you", short: "Yours", wide: true, what: "Each run ends in one change card with its proof. Cards wait here for your answer.", cmd: "cast workflow runs" },
  { key: "watching", name: "Watching", short: "Watching", tail: true, what: "A shipped cause is watched. A repeat of its signal reopens it; a quiet watch resolves it.", cmd: "cast task update ct-N --watch-days 7" },
  { key: "closed", name: "Closed", short: "Closed", sub: "last 7d", tail: true, what: "Causes shipped, dissolved or resolved in the last seven days.", cmd: "cast task ls -s done" },
];

/** The first command a new line needs: file one signal by hand. */
const FIRST_SIGNAL = `cast signal add --source person --kind bug --title "What you saw"`;

const taskHref = (t: { short_id?: string; _id: string }) => `/tasks/${t.short_id ?? t._id}`;

// Columns size from the flow's own width (a container query), so the inbox
// panel opening narrows the line the way a smaller window does. An empty
// station is a narrow tile at every width (its name, lamp, count and what
// feeds it), so the eye goes to the stations holding work. Sense is a list of
// one line sources, so it takes a fixed width that fits a source name and its
// count and no more (a station is a size container, so its content cannot
// size its track). Causes and
// Awaiting you hold the work the founder reads, so they take the most of what
// is left; In build and the "After ship" track (Watching over Closed, stacked
// at 1600px and under by line.css .line-after) take less. The tight set takes
// over under 1360px and its minimums fit a 1000px flow, so every station
// shows whole on a laptop or a split screen; the compact one under 1000px
// scrolls, and its edge fades to say there is more. Under 840px an empty
// station folds to a 40px labelled slot. Below sm the stations snap one per
// screen and scroll sideways.
type TrackSet = { rail: string; empty: string; wide: string; slim: string; tail: string; live: string; causes: string; after: string };
const ROOMY: TrackSet = { rail: "24px", empty: "minmax(132px, 0.42fr)", wide: "minmax(340px, 2.2fr)", slim: "168px", tail: "minmax(160px, 0.8fr)", live: "minmax(200px, 1fr)", causes: "minmax(220px, 1.7fr)", after: "minmax(180px, 0.85fr)" };
const TIGHT: TrackSet = { rail: "8px", empty: "minmax(110px, 0.4fr)", wide: "minmax(290px, 2.2fr)", slim: "150px", tail: "minmax(135px, 0.8fr)", live: "minmax(165px, 1fr)", causes: "minmax(185px, 1.7fr)", after: "minmax(135px, 0.85fr)" };
const COMPACT: TrackSet = { rail: "8px", empty: "minmax(108px, 0.4fr)", wide: "minmax(290px, 2fr)", slim: "150px", tail: "minmax(150px, 0.8fr)", live: "minmax(180px, 1fr)", causes: "minmax(200px, 1.4fr)", after: "minmax(150px, 0.8fr)" };
const SLIM: TrackSet = { ...COMPACT, rail: "10px", empty: "40px" };
// Each station fills the flow less its padding, and the rail is wider than
// that padding, so a neighbour never peeks in as a stray border.
const ONE = "calc(100cqw - 32px)";
const NARROW: TrackSet = { rail: "18px", empty: ONE, wide: ONE, slim: ONE, tail: ONE, live: ONE, causes: ONE, after: ONE };
/** `stacked` folds Watching and Closed into one track: empty only when both are. */
const template = (set: TrackSet, emptyOf: (s: Station) => boolean, stacked = false) =>
  STATIONS.flatMap((s, i) => {
    if (stacked && s.key === "closed") return [];
    const after = stacked && s.key === "watching";
    const isEmpty = after ? STATIONS.filter((x) => x.tail).every(emptyOf) : emptyOf(s);
    const track = isEmpty ? set.empty : after ? set.after : s.wide ? set.wide : s.slim ? set.slim : s.tail ? set.tail : s.key === "causes" ? set.causes : set.live;
    return [...(i ? [set.rail] : []), track];
  }).join(" ");

export function LinePage() {
  const router = useRouter();
  const initiatives = useInitiatives();
  const { now, tasks, projects, lineRows, rollup, line } = useLineFloor();
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
  // Sources quiet for 24 hours fold under their own line, the way parked
  // causes do, while any source is live; with none live they all show.
  const [quietOpen, setQuietOpen] = useState(false);
  // A silent finder never folds away: finder health shows where it lives.
  const sense = useMemo(() => {
    const live = flow.sense.items.filter((s) => s.day > 0);
    const silent = flow.sense.items.filter((s) => s.silent);
    const quiet = live.length ? flow.sense.items.filter((s) => s.day === 0 && !s.silent) : [];
    return { live: live.length ? [...live, ...silent] : flow.sense.items, quiet, silent };
  }, [flow.sense.items]);
  const senseRows = useMemo(() => [...sense.live, ...(quietOpen ? sense.quiet : [])], [sense, quietOpen]);

  // Keyboard: one cursor over the whole flow, in render order.
  const hrefs: Record<StationKey, string[]> = useMemo(() => ({
    // The evals finder's row opens the Evals area, where the drop can be read and attributed.
    sense: senseRows.map((s) => { if (s.source === "evals") return evalsSenseHref(s.newest?.subject); const t = s.newest ? taskById.get(s.newest.task_id) : undefined; return t ? taskHref(t) : line.href; }),
    causes: [...flow.causes.items, ...(parkedOpen ? flow.causes.parked : [])].map((r) => taskHref(r.task)),
    build: buildBlocks.flatMap((g) => g.rows).map((b) => runHref(b.run._id)),
    awaiting: flow.awaiting.items.map((d) => decisionHref(d)),
    watching: flow.watching.items.map((w) => taskHref(w.task)),
    closed: flow.closed.items.map((c) => taskHref(c.task)),
  }), [flow, senseRows, buildBlocks, taskById, parkedOpen, line.href]);

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
  const openingCard = useRef<string | null>(null);
  const col = Math.min(focus.col, STATIONS.length - 1);
  const rows = hrefs[STATIONS[col].key].length;
  const row = Math.min(focus.row, Math.max(0, rows - 1));
  const focusedCard = STATIONS[col].key === "awaiting" ? flow.awaiting.items[row] as SessionDecisionItem | undefined : undefined;
  // A multi, rank or form card claims return to submit; every other row opens.
  const cardTakesReturn = !!focusedCard && !cardAnswerIndexes(focusedCard) && (focusedCard.kind ?? "single") !== "single";

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      if (keyBelongsElsewhere(e.target)) return;
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
    "--line-cols-mid": template(ROOMY, (s) => empty(s.key), true),
    "--line-cols-tight": template(TIGHT, (s) => empty(s.key), true),
    "--line-cols-compact": template(COMPACT, (s) => empty(s.key), true),
    "--line-cols-slim": template(SLIM, (s) => empty(s.key), true),
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
  // Which edges hide stations, so the flow can fade them (line.css). The
  // scroller mounts only on a project's flow.
  const edges = useScrollEdges(scroller, `${rollupView}|${allEmpty}`);
  const tabsRow = useRef<HTMLElement>(null);
  const tabEdges = useScrollEdges(tabsRow, `${rollupView}|${allEmpty}`);
  // A phone opens on the founder's station when a card waits there: the
  // five-second read lands on what needs them, once, on first paint.
  const awaitingIdx = STATIONS.findIndex((x) => x.key === "awaiting");
  const openedOnCards = useRef(false);
  useEffect(() => {
    const root = scroller.current;
    if (openedOnCards.current || !root || flow.awaiting.count === 0) return;
    openedOnCards.current = true;
    if (!window.matchMedia?.("(max-width: 639px)").matches) return;
    const el = root.querySelector<HTMLElement>(`[data-line-col="${awaitingIdx}"]`);
    // Rects, not offsetLeft: see onFlowScroll.
    if (el) root.scrollLeft += el.getBoundingClientRect().left - root.getBoundingClientRect().left - (root.clientWidth - el.offsetWidth) / 2;
    setShown(awaitingIdx);
  }, [flow.awaiting.count, awaitingIdx]);
  // The tab for the station on screen is scrolled to the row's start, on a
  // snap point (line.css .line-tabs), so the first visible tab is whole. Near
  // the end the row stops at the last tab start it can reach, not the clamp.
  useEffect(() => {
    const nav = tabsRow.current;
    const tab = nav?.querySelector<HTMLElement>("[data-active=true]");
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const pad = parseFloat(getComputedStyle(nav).scrollPaddingLeft) || 0;
    const box = nav.getBoundingClientRect().left;
    const startOf = (el: Element) => nav.scrollLeft + el.getBoundingClientRect().left - box - pad;
    const limit = Math.min(startOf(tab), nav.scrollWidth - nav.clientWidth);
    const left = Math.max(0, ...Array.from(nav.children).map(startOf).filter((x) => x <= limit + 1));
    nav.scrollTo({ left });
    // The edge fades follow scroll events, which a hidden tab never delivers
    // after a programmatic scroll; say it now so the cut tab is masked.
    nav.dispatchEvent(new Event("scroll"));
  }, [shown]);
  const showStation = (i: number) => {
    setFocus({ col: i, row: 0 });
    setShown(i);
    scroller.current?.querySelector<HTMLElement>(`[data-line-col="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  };

  // One station, drawn by key; the flow below lays them out.
  const station = (s: Station, i: number) => (
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
      note={s.key === "causes" && ungrounded
        ? <>None of these serve a goal yet. <code className="text-sol-text-muted">cast task update ct-N --goal-ref in-N:key</code></>
        : s.key === "sense" && sense.silent.length > 0
          ? <button type="button" onClick={(e) => { e.stopPropagation(); setFocus({ col: i, row: Math.max(0, senseRows.findIndex((x) => x.source === sense.silent[0].source)) }); }} className="line-chip-warn line-chip-wrap hover:brightness-125" title={`Declared finders that filed nothing in 24 hours: ${sense.silent.map((x) => x.source).join(", ")}. Shows the finder and how it runs.`} data-line-silent-note>{silentWords(sense.silent, now)}</button>
          : undefined}
    >
      {empty(s.key) && <Empty station={s} focused={col === i} what={s.key === "closed" && flow.throughput.shippedInWatch > 0 ? closedInWatch(flow.throughput.shippedInWatch) : undefined} after={s.key === "build" ? <OtherRuns n={flow.build.otherRuns} /> : s.key === "closed" && flow.watching.count > 0 && flow.throughput.shippedInWatch > 0 ? <button type="button" onClick={(e) => { e.stopPropagation(); showStation(STATIONS.findIndex((x) => x.key === "watching")); }} className="self-start text-[11px] text-sol-text-muted underline underline-offset-2 decoration-sol-border hover:text-sol-text" data-line-see-watching>see Watching</button> : undefined} />}

      {s.key === "sense" && !empty("sense") && (<>
        {sense.live.map((src, r) => <SenseRow key={src.source} src={src} now={now} focused={at("sense", r)} index={r} href={hrefs.sense[r]} />)}
        {sense.quiet.length > 0 && (
          <div className="pt-2">
            <Fold open={quietOpen} onToggle={() => setQuietOpen((v) => !v)} label="nothing today" count={sense.quiet.length} />
            {quietOpen && sense.quiet.map((src, r) => {
              const idx = sense.live.length + r;
              return <SenseRow key={src.source} src={src} now={now} focused={at("sense", idx)} index={idx} href={hrefs.sense[idx]} />;
            })}
          </div>
        )}
      </>)}

      {s.key === "causes" && !empty("causes") && (<>
            {flow.causes.items.map((c, r) => <CauseRowView key={c.task._id} row={c} rank={r + 1} focused={at("causes", r)} index={r} />)}
            {flow.causes.parked.length > 0 && (
              <div className="pt-2">
                <Fold open={parkedOpen} onToggle={() => setParkedOpen((v) => !v)} label="parked until given a goal" count={flow.causes.parked.length} />
                {parkedOpen && flow.causes.parked.map((c, r) => {
                  const idx = flow.causes.items.length + r;
                  return <CauseRowView key={c.task._id} row={c} focused={at("causes", idx)} index={idx} muted />;
                })}
              </div>
            )}
          </>)}

      {s.key === "build" && !empty("build") && (<>
        {buildBlocks.map((g, gi) => <BuildBlockView key={g.label ?? `solo-${gi}`} block={g} now={now} at={(r) => at("build", r)} />)}
        <OtherRuns n={flow.build.otherRuns} />
      </>)}

      {/* A queue to work down: only the card under the cursor (or,
          with the cursor elsewhere, the first) opens; the rest are
          two lines, and a click on one opens it instead of leaving. */}
      {s.key === "awaiting" && !empty("awaiting") && (<div className="space-y-2">
            {flow.awaiting.items.map((d, r) => {
              const open = STATIONS[col].key === "awaiting" ? row === r : r === 0;
              // The press opens a folded card, so its click (which
              // lands after the card has re-rendered open) stays.
              const press = (e: MouseEvent) => { e.stopPropagation(); openingCard.current = open ? null : d._id; setFocus({ col: i, row: r }); };
              const click = (e: MouseEvent) => {
                if (openingCard.current !== d._id && open) return;
                openingCard.current = null;
                e.preventDefault();
                e.stopPropagation();
                setFocus({ col: i, row: r });
              };
              return (
                <div key={d._id} data-line-row={r} data-focused={at("awaiting", r) ? "true" : undefined} data-open={open ? "true" : undefined} onMouseDown={press} onClickCapture={click} className="line-card rounded-lg">
                  <DecisionCompactCard decision={d as SessionDecisionItem} keys={at("awaiting", r)} line folded={!open} />
                </div>
              );
            })}
          </div>)}

      {s.key === "watching" && !empty("watching") && (flow.watching.items.map((w, r) => <WatchRowView key={w.task._id} row={w} focused={at("watching", r)} index={r} />))}

      {s.key === "closed" && !empty("closed") && (flow.closed.items.map((c, r) => <ClosedRowView key={c.task._id} row={c} now={now} focused={at("closed", r)} index={r} />))}
    </StationColumn>
  );

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-4 flex flex-col gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[13px] font-semibold text-sol-text leading-none">The line</h1>
          <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">a signal in the world to a shipped, watched change</span>
        </div>
        <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={(k) => { setFocus(null); line.select(k); }} />
        {!allEmpty && !rollupView && <Throughput t={flow.throughput} lead={<Headline parts={headlineLead(lineHeadline(flow, now))} onStation={(key) => showStation(STATIONS.findIndex((x) => x.key === key))} />} />}
      </header>

      {rollupView ? <LineRollup rollup={rollup} onSelect={(k) => { setFocus(null); line.select(k); }} /> : allEmpty ? <Onboarding focusedCol={col} onFocus={(i) => setFocus({ col: i, row: 0 })} /> : (<>
      <nav ref={tabsRow} className="line-tabs line-edge-fade line-scroll-quiet sm:hidden shrink-0 flex gap-1 overflow-x-auto px-4 pb-2" aria-label="Stations" {...edgeAttrs(tabEdges)}>
        {STATIONS.map((s, i) => (
          <button key={s.key} onClick={() => showStation(i)} data-active={shown === i ? "true" : undefined} data-ask={s.key === "awaiting" && columns[s.key].count > 0 ? "true" : undefined} className="line-tab shrink-0 rounded-full px-2.5 py-1 text-[11px] whitespace-nowrap">
            {s.name} <span className="tabular-nums" data-zero={columns[s.key].count === 0 ? "true" : undefined}>{columns[s.key].count}</span>
          </button>
        ))}
      </nav>

      <div ref={scroller} onScroll={onFlowScroll} className="line-flow line-edge-fade flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory sm:snap-none" data-line-flow {...edgeAttrs(edges)}>
        <div className="line-track h-full px-4 sm:px-5 pb-4" style={grid}>
          {STATIONS.map((s, i) => {
            const tail = STATIONS[i + 1];
            if (s.key === "closed") return null;
            // Watching and Closed share one wrapper: two tracks on a wide
            // floor (display: contents), one stacked "After ship" track at
            // 1600px and under (line.css .line-after).
            if (s.key === "watching" && tail?.key === "closed") return (
              <Fragment key={s.key}>
                <Rail live={!empty(s.key)} />
                <div className="line-after" aria-label="After ship" data-line-after>
                  {station(s, i)}
                  <Rail live={!empty(tail.key)} />
                  {station(tail, i + 1)}
                </div>
              </Fragment>
            );
            return (
              <Fragment key={s.key}>
                {i > 0 && <Rail live={!empty(s.key)} />}
                {station(s, i)}
              </Fragment>
            );
          })}
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
          {focusedCard && options > 0 && <Hint label={cardTakesReturn ? "answer the card" : "pick, then return"} className="text-sol-yellow/90"><KeyCap size="xs">1</KeyCap>{options > 1 && <>-<KeyCap size="xs">{String(options)}</KeyCap></>}</Hint>}
          {rows > 0
            ? <Hint label={cardTakesReturn ? "submit" : "open"}><KeyCap size="xs">↵</KeyCap></Hint>
            : <Hint label={allEmpty ? "copy the first command" : "copy the command"}><KeyCap size="xs">c</KeyCap></Hint>}
        </span>
        </>}
        <span className="shrink-0 whitespace-nowrap flex items-center gap-3 sm:pl-3 sm:border-l border-sol-border/40" data-line-footer-links>
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

/** The headline says only what needs the founder (cards waiting, a stall, a
 *  failure), or that nothing does: the station counts right below carry the
 *  rest, so no number is said twice. */
const LEAD_TONES = new Set<HeadlinePart["tone"]>(["ask", "warn", "fail", "clear"]);
const headlineLead = (parts: HeadlinePart[]) => {
  const lead = parts.filter((p) => LEAD_TONES.has(p.tone));
  return lead.length ? lead : parts.slice(0, 1);
};

/** The sentence's counts in bold, so the numbers are what the eye lands on. */
const boldNumbers = (text: string) => text.split(/(\d+)/).map((t, i) => (i % 2 ? <b key={i} className="font-semibold">{t}</b> : t));

/** The five-second read. A part that names a station links to it: the
 *  cursor moves there and the flow scrolls it into view. */
function Headline({ parts, onStation }: { parts: HeadlinePart[]; onStation: (key: StationKey) => void }) {
  return (
    <p className="line-headline text-sol-text" data-line-headline>
      {parts.map((p, i) => {
        // A count never ends a line apart from the word it counts, nor an
        // age apart from the word before it ("oldest 1d").
        const text = (i === 0 ? p.text.charAt(0).toUpperCase() + p.text.slice(1) : p.text).replace(/(\d+) /g, "$1\u00a0").replace(/ (\d+\w*)$/, "\u00a0$1");
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

/** The headline, then the week as one dim trailing clause on its row; a
 *  click on the clause opens the week's figures under it. */
function Throughput({ t, lead: headline }: { t: ReturnType<typeof buildLineFlow>["throughput"]; lead: ReactNode }) {
  const [open, setOpen] = useState(false);
  const moved = t.signalsIn + t.opened + t.dissolved + t.shipped + t.reopened > 0;
  if (!moved) {
    return <div className="line-head-row">{headline}<span className="text-[12px] text-sol-text-dim" data-line-throughput="quiet">no signals this week</span></div>;
  }
  const inWatch = t.shippedInWatch > 0 ? (t.shippedInWatch === t.shipped ? "now in watch" : `${t.shippedInWatch} in watch`) : null;
  const median = t.medianToShip === null ? null : compactElapsed(t.medianToShip);
  // A metric with nothing measured yet stays out, so it never reads as a value.
  const lead: Array<{ label: string; value: string | number; tip: string; spark?: number[]; note?: string | null }> = [
    { label: "shipped this week", value: t.shipped, spark: t.daily.shipped, note: inWatch, tip: `Causes shipped in the last 7 days, per day.${t.shippedInWatch ? ` ${t.shippedInWatch} still in Watching; a ship moves to Closed when its watch ends quiet.` : ""}` },
    ...(median ? [{ label: "median signal to ship", value: median, tip: "From a cause's first signal to its ship, median over this week's ships" }] : []),
  ];
  const flowCells: Array<{ label: string; value: string | number; tone?: string; spark?: number[]; tip: string; unit?: string }> = [
    { label: "signals in", value: t.signalsIn, spark: t.daily.signalsIn, tip: "signals in this week, per day" },
    { label: "causes opened", value: t.opened, spark: t.daily.opened, tip: "causes opened this week, per day" },
    { label: "dissolved", value: t.dissolved, spark: t.daily.dissolved, tip: "causes dissolved this week, per day" },
    { label: "reopened", value: t.reopened, tone: t.reopened ? "text-sol-red" : undefined, spark: t.daily.reopened, tip: "causes reopened this week, per day" },
    ...(t.tokensPerShip === null ? [] : [{ label: "cost per ship", value: formatTokens(Math.round(t.tokensPerShip)), unit: "tokens", tip: "Cost per shipped change, in run tokens. Runs record tokens, not dollars." }]),
  ];
  // The station headers already count signals in and what sits in watch, so
  // the clause says only the week's outcome: what shipped, how fast, and a
  // reopen when there is one.
  const summary: Array<{ n: string | number; words: string; tone?: string }> = [
    { n: t.shipped, words: " shipped this week" },
    ...(median ? [{ n: median, words: " median to ship" }] : []),
    ...(t.reopened ? [{ n: t.reopened, words: " reopened", tone: "text-sol-red" }] : []),
  ];
  return (
    <div className="flex flex-col gap-2 min-w-0">
    <div className="line-head-row">
    {headline}
    {/* Each figure stays whole and the clause wraps between them; the
        chevron rides the last figure, so a wrap never strands it. */}
    <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="line-meter-summary max-w-full text-[12px] text-sol-text-dim text-left hover:text-sol-text" data-line-throughput-summary title={open ? "Hide the week's figures" : "The week's figures"}>
      {summary.map((p, i) => (
        <span key={p.words}>
          {i > 0 && <span> · </span>}
          <span className="whitespace-nowrap"><span className={cn("line-num", p.tone ?? "text-sol-text-muted")}>{p.n}</span>{p.words}{i === summary.length - 1 && <ChevronDown className={cn("inline-block align-[-2px] ml-1 w-3.5 h-3.5 transition-transform", open && "rotate-180")} />}</span>
        </span>
      ))}
    </button>
    </div>
    {open && (
    <div className="line-meter rounded-xl" data-line-throughput>
      <div className="line-meter-lead">
        {lead.map((c) => (
          <div key={c.label} className="line-meter-big min-w-0" title={c.tip}>
            <div className="flex items-end gap-2.5 h-[26px]">
              <span className="line-display-num line-meter-num text-sol-text" data-zero={c.value === 0 ? "true" : undefined}>{c.value}</span>
              {c.spark && sparkable(c.spark) && <Spark values={c.spark} bar={4} height={18} className="mb-0.5" label={`${c.label}, per day`} />}
            </div>
            <div className="mt-1.5 text-[11px] text-sol-text-muted whitespace-nowrap">{c.label}{c.note && <span className="text-sol-text-dim">, {c.note}</span>}</div>
          </div>
        ))}
      </div>
      <div className="line-meter-flow">
        {flowCells.map((c) => (
          <div key={c.label} className="min-w-0" title={c.tip}>
            <div className="flex items-center gap-1.5">
              <span className={cn("line-num text-[15px] text-sol-text-muted", c.tone)} data-zero={c.value === 0 ? "true" : undefined}>{c.value}</span>
              {c.unit && <span className="text-[11px] text-sol-text-dim">{c.unit}</span>}
              {c.spark && sparkable(c.spark) && <Spark values={c.spark} bar={2} height={10} label={c.tip} />}
            </div>
            <div className="mt-1 text-[11px] text-sol-text-dim truncate">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
    )}
    </div>
  );
}

// ── A station ──

function stateWords(state: StageState, now: number): string {
  const since = state.since ? ago(state.since, now) : null;
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

/** What a station's count is: the header's qualifier when its state has no words. */
const COUNT_NOUN: Record<StationKey, string> = { sense: "today", causes: "open", build: "running", awaiting: "waiting", watching: "in watch", closed: "last 7 days" };

/** What entered the station this week, for the header's tooltip. Closed
 *  already counts the week, so it has none. */
function weekWords(key: StationKey, count: number, moved: number, week?: number): string | null {
  if (key === "sense") return week !== undefined && week !== count ? `${week} this week` : null;
  if (key === "closed") return null;
  return moved > 0 ? `${moved} in this week` : null;
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
  const unit = COUNT_NOUN[station.key];
  const weekLine = empty ? null : weekWords(station.key, column.count, moved, week);
  // One qualifier beside the count: the state's own words when it has any
  // (oldest 3d, waiting 1d, starved 2d), else what the count measures (last
  // 7 days, in watch). The rest of the numbers live in the tooltip.
  const tag = stateTag(state, column.oldestAt, now);
  // An age is pressure only where work waits to move (Causes, In build).
  const aged = state.kind === "running" && !!column.oldestAt && (station.key === "causes" || station.key === "build");
  const qualifier = empty ? (state.kind === "idle" || state.kind === "clear" ? state.kind : tag) : state.kind === "ask" || TROUBLE.has(state.kind) || aged ? tag : unit;
  // A count's own noun is plain dim text: no lamp, no pill, no state ink.
  const qKind = !empty && qualifier === unit ? "running" : state.kind;
  const countTip = [`${column.count} ${unit}`, weekLine, column.oldestAt ? `oldest ${ago(column.oldestAt, now)}` : null, words].filter(Boolean).join("\n");
  const body = useRef<HTMLDivElement>(null);
  const more = useRowsBelow(body, !empty);
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
        <span className="line-display-num text-[19px]" data-zero="true">{column.count}</span>
        <span className="line-lamp" data-kind={state.kind} />
        <span className="line-col-slim-name text-[11px] text-sol-text-muted">{station.name}</span>
      </div>
      {/* One row: the name, the count, one qualifier. What entered this
          week and the state's why sit in the tooltip. A phone shows one
          station under its tab, which names and counts it, so the row drops
          there and only a note stays (line.css). */}
      <div className="line-col-head shrink-0 px-3 pt-3 pb-2.5 border-b border-sol-border/25" title={countTip}>
        <div className="line-col-title flex items-center gap-2 h-[24px] min-w-0">
          <h2 className="text-[13px] font-medium text-sol-text whitespace-nowrap">
            <span className="line-name-full">{station.name}</span>
            <span className="line-name-short">{station.short}</span>
          </h2>
          <span className={cn("line-col-count line-num", state.kind === "ask" ? "text-sol-yellow" : "text-sol-text")} data-zero={column.count === 0 ? "true" : undefined}>{column.count}</span>
          <span className={cn("line-state ml-auto flex items-center gap-1.5 text-[11px] whitespace-nowrap min-w-0", STATE_TONE[qKind])} data-kind={qKind} data-line-state data-line-unit>
            <span className="line-lamp" data-kind={qKind} />
            <span className="line-state-text truncate">{qualifier}</span>
          </span>
        </div>
        {note && <div className="line-col-note mt-2 text-[11px] text-sol-text-dim leading-snug" data-line-note>{note}</div>}
      </div>
      <div ref={body} className={cn("line-col-body min-h-0 flex-1 p-2", !empty && "overflow-y-auto")} data-line-body>
        {children}
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); body.current?.scrollBy({ top: body.current.clientHeight * 0.8, behavior: "smooth" }); }}
          className="line-col-more shrink-0 flex items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-sol-text-muted hover:text-sol-text"
          data-line-more
        >
          +{more} more<ChevronDown className="w-3 h-3" />
        </button>
      )}
      {TROUBLE.has(state.kind) && (
        <div className={cn("line-col-why shrink-0 px-3 py-2 text-[11px] truncate", STATE_TONE[state.kind])} title={words} data-line-why>{state.why}</div>
      )}
    </section>
  );
}

/** How many rows sit wholly or partly below a scrolling body's fold, so a
 *  station that clips says so ("+3 more") instead of cutting off silently. */
function useRowsBelow(ref: RefObject<HTMLElement | null>, on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) { setN(0); return; }
    const count = () => {
      const fold = el.getBoundingClientRect().bottom - 2;
      let below = 0;
      el.querySelectorAll<HTMLElement>("[data-line-row]").forEach((row) => { if (row.getBoundingClientRect().bottom > fold) below++; });
      setN(below);
    };
    count();
    void document.fonts?.ready.then(count);
    el.addEventListener("scroll", count, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(count);
    ro?.observe(el);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(count);
    mo?.observe(el, { childList: true, subtree: true });
    return () => { el.removeEventListener("scroll", count); ro?.disconnect(); mo?.disconnect(); };
  }, [ref, on]);
  return n;
}

function Rail({ live }: { live: boolean }) {
  return (
    <div className="line-rail-slot relative" aria-hidden>
      <div className="line-rail" data-live={live ? "true" : undefined} />
    </div>
  );
}

/** Closed is empty while this week's ships still sit in their watch: it says
 *  where they are, so the strip's shipped count never reads as a bug. */
const closedInWatch = (n: number) => `${n === 1 ? "This week's ship is" : `This week's ${n} ships are`} in Watching. ${n === 1 ? "It lands" : "They land"} here when the watch ends quiet.`;

/** A silent finder said in words on the chip itself, since a tooltip never
 *  shows on touch: "union.guard: no signals 2d". */
const silentWords = (silent: SenseSource[], now: number) => {
  if (silent.length > 1) return `${silent.length} finders: no signals 24h`;
  const s = silent[0];
  return `${s.source}: no signals ${s.newest ? ageShort(now - s.newest.created_at) : "in 14d"}`;
};

/** An empty station: what feeds it and the command that does. */
function Empty({ station, focused, what, after }: { station: Station; focused: boolean; what?: string; after?: ReactNode }) {
  return (
    <div className="line-empty rounded-lg flex flex-col gap-2.5 p-2.5" data-line-empty title={`${what ?? station.what} ${station.cmd}`}>
      <p className="text-[11px] text-sol-text-muted leading-relaxed">{what ?? station.what}</p>
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
 *  stations in one row, each saying what will feed it and, on hover or under
 *  the cursor, the command that does. */
function Onboarding({ focusedCol, onFocus }: { focusedCol: number; onFocus: (i: number) => void }) {
  return (
    <div className="line-onboard flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-5 flex flex-col" data-line-onboarding>
      {/* The start card, then the stations, top aligned at the header's
          rhythm: what to do, then where it will flow. The card is as wide as
          its copy, and the command chip as wide as the command. */}
      <div className="flex flex-col gap-5 pt-1 pb-4">
      <div className="line-start shrink-0 rounded-xl p-5 sm:p-6 max-w-[760px]">
        <div className="line-start-title text-sol-text">File the first signal.</div>
        <p className="mt-2 text-[13px] text-sol-text-muted leading-relaxed max-w-[60ch]">
          A signal is one thing someone saw. It opens a cause, the line builds a fix, and you answer one card.
          Sentry, PostHog and evals file their own once connected.
        </p>
        <div className="mt-5 w-fit max-w-full"><Cmd cmd={FIRST_SIGNAL} primary /></div>
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
            <div className="line-ghost-head flex items-center gap-2 h-[24px]">
              <span className="line-ghost-num line-num text-[11px] text-sol-text-dim">{i + 1}</span>
              <span className="text-[13px] font-medium text-sol-text whitespace-nowrap">{s.name}</span>
            </div>
            <p className="line-ghost-what mt-2 text-[11px] leading-relaxed text-sol-text-muted" title={s.what}>{s.what}</p>
            <div className="line-ghost-cmd mt-auto pt-3"><Cmd cmd={s.cmd} shown={focusedCol === i} /></div>
          </li>
        ))}
      </ol>
      </div>
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

/** A folded group inside a station: parked causes, quiet sources. */
function Fold({ open, onToggle, label, count }: { open: boolean; onToggle: () => void; label: string; count: number }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text px-1 py-1 whitespace-nowrap min-w-0" data-line-fold>
      {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      <span className="truncate min-w-0">{label}</span>
      <span className="ml-auto tabular-nums shrink-0">{count}</span>
    </button>
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

/** A source of signals: a finder the project's profile declares (LP3), or
 *  one that filed without being declared. One line: the source and its count,
 *  with the week's bars beside the count only when the week has a trend. The
 *  latest signal, the kinds it files and how it runs sit in the tooltip, so
 *  the station stays narrow and gives its width to the titles beside it. A
 *  quiet source (nothing in 24 hours) says its week instead of a zero, and a
 *  declared finder's silence says how long, in the warning ink. */
function SenseRow({ src, now, focused, index, href }: { src: SenseSource; now: number; focused: boolean; index: number; href: string }) {
  const f = src.finder;
  const kinds = src.kinds.length ? src.kinds.join(", ") : f?.kind === "any" ? "any kind" : null;
  const latest = src.newest ? `latest: ${src.newest.title}, ${ago(src.newest.created_at, now)} ago` : "no signal in 14 days";
  const tip = [src.source, src.silent ? "silent: a declared finder with no signal in 24 hours" : null, src.undeclared ? "files here, not declared in the line profile" : f ? `finder ${f.id}` : null, kinds, f?.runs ? `runs ${f.runs}` : null, latest, `${src.day} in the last 24 hours, ${src.week} this week`].filter(Boolean).join("\n");
  const quiet = src.day === 0;
  return (
    <RowLink href={href} focused={focused} index={index} className={cn("py-1.5", src.silent ? "line-row-silent" : quiet ? "line-row-quiet" : undefined)}>
      <div className="flex items-center gap-2 min-w-0" title={tip}>
        <span className={cn("text-[13px] truncate min-w-0", src.undeclared ? "text-sol-text-muted italic" : "text-sol-text")}>{src.source}</span>
        {!src.silent && sparkable(src.spark) && <Spark values={src.spark} bar={2} height={12} className="line-sense-spark ml-auto" label="signals per day, last 7 days" />}
        <span className={cn("line-sense-count shrink-0 text-[11px] tabular-nums whitespace-nowrap", (src.silent || !sparkable(src.spark)) && "ml-auto", "text-sol-text-dim")}>
          {src.silent
            ? <span className="line-silent-dot inline-block" role="img" aria-label={src.newest ? `silent ${ago(src.newest.created_at, now)}` : "silent, no signal in 14 days"} />
            : quiet
              ? (src.week > 0 ? `${src.week} wk` : null)
              : <span className="text-[13px] font-semibold text-sol-text">{src.day}</span>}
        </span>
      </div>
    </RowLink>
  );
}

/** A goal only where one exists, as a chip (GoalChip).
 *  Ungrounded causes carry none (the column header says so once), and
 *  parked ones sit under their own fold. */
const GOAL_SHOWN = new Set<CauseRow["goal"]["kind"]>(["initiative", "project", "unknown"]);

function CauseRowView({ row, rank, focused, index, muted }: { row: CauseRow; rank?: number; focused: boolean; index: number; muted?: boolean }) {
  const t = row.task;
  // The row is a scan line: rank, title, signal count and goal. The rest of
  // the triage sits on hover and on the task page.
  const tip = [t.short_id, t.category, t.risk && t.risk !== "low" ? `${t.risk} risk` : null, `priority ${row.score.toFixed(1)}`].filter(Boolean).join(" · ");
  const unready = t.readiness && t.readiness !== "ready";
  return (
    <RowLink href={taskHref(t)} focused={focused} index={index} className={cn(muted && "opacity-70")}>
      {/* Rank is a quiet tabular figure, the same on every row; the signal
          count that earns the rank sits in a right column in Sense's count
          ink, so the order explains itself. The score sits in the tooltip. */}
      <div className="flex items-start gap-2" title={tip}>
        {rank !== undefined && <span className="line-rank w-4 shrink-0" aria-label={`rank ${rank}, priority ${row.score.toFixed(1)}`}>{rank}</span>}
        <span className="text-[13px] text-sol-text leading-snug flex-1 min-w-0 line-title">{t.title}</span>
        <span className="line-cause-count shrink-0" title={`${row.signals} signal${row.signals === 1 ? "" : "s"} attached`} aria-label={`${row.signals} signal${row.signals === 1 ? "" : "s"}`} data-line-cause-count>{row.signals}</span>
      </div>
      {/* One line under the title, on the title's left edge: a cause that
          cannot start yet says so first (the one state here that asks for
          action), then the goal as the chip a change card wears for it. */}
      {(unready || GOAL_SHOWN.has(row.goal.kind)) && (
        <div className={cn("mt-1 flex items-center flex-wrap gap-x-1.5 gap-y-1 text-[11px] leading-[16px] min-w-0 text-sol-text-dim", rank !== undefined && "pl-6")}>
          {unready && <span className="line-chip-warn" title={t.readiness_note ?? undefined} data-line-unready>{t.readiness!.replace("_", " ")}</span>}
          {GOAL_SHOWN.has(row.goal.kind) && <span className="min-w-0 max-w-full"><GoalChip name={row.goal.label.split(" · ")[0]} title={`serves ${row.goal.label} (${row.goal.ref})`} /></span>}
        </div>
      )}
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
  // The title is what a founder scans; the ids and the workflow sit in its
  // tooltip, and what the step is doing shows on the row under the cursor.
  const tip = [row.name, ref, row.workflow ? `workflow ${row.workflow}` : null, row.node?.activity].filter(Boolean).join(" · ");
  return (
    <RowLink href={runHref(r._id)} focused={focused} index={index} className={row.stalled ? "opacity-60" : undefined}>
      <div className="flex items-start gap-2" title={tip}>
        <span className={cn("mt-1 w-1.5 h-1.5 rounded-full shrink-0", row.stalled ? "border border-sol-text-dim" : r.status === "paused" ? "bg-sol-yellow" : "line-live-dot")} />
        <span className="text-[13px] text-sol-text leading-snug flex-1 min-w-0 line-title">{row.name}</span>
      </div>
      <div className="mt-1 pl-3.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-sol-text-dim min-w-0">
        {row.stepIndex !== null
          ? <Stepper at={row.stepIndex} label={row.chip} tone={row.stalled ? "stalled" : r.status === "paused" ? "paused" : "live"} />
          : row.chip && <span className="min-w-0 truncate px-1.5 rounded border border-sol-border/60 text-sol-text-muted">{row.chip}</span>}
        {/* Over a day at one step says so in words, on the row itself. */}
        <span className={cn("ml-auto tabular-nums shrink-0", old ? "text-sol-orange" : "text-sol-text-dim")} title={old ? "at this step over a day" : "at this step"}>{old ? `stuck ${ago(row.since, now)}` : ago(row.since, now)}</span>
      </div>
      {focused && row.node?.activity && <div className="mt-1 pl-3.5 text-[11px] text-sol-text-muted leading-snug line-clamp-2" data-line-activity>{row.node.activity}</div>}
    </RowLink>
  );
}

/** Where a line run sits: five dots, the steps done filled, the current one
 *  in the belt color and named beside the dots (a grouped run's block header
 *  names it instead). The same ticked grammar as Watching's countdown. */
function Stepper({ at, label, tone }: { at: number; label: string | null; tone: "live" | "paused" | "stalled" }) {
  return (
    <span className="line-stepper flex items-center gap-1.5 min-w-0" data-tone={tone} title={`step ${at + 1} of ${LINE_STEPS.length}: ${LINE_STEPS.map((x, i) => (i === at ? `[${x}]` : x)).join(" ")}${label ? `, at ${label}` : ""}`} data-line-stepper={at}>
      <span className="flex items-center gap-[3px] shrink-0" aria-hidden>
        {LINE_STEPS.map((x, i) => <span key={x} className="line-step" data-done={i < at ? "true" : undefined} data-now={i === at ? "true" : undefined} />)}
      </span>
      {label && <span className="truncate min-w-0 text-sol-text-muted">{label}</span>}
    </span>
  );
}

function WatchRowView({ row, focused, index }: { row: WatchRow; focused: boolean; index: number }) {
  const span = Math.max(1, Math.ceil((row.until - (row.task.closed_at ?? row.until - 7 * DAY)) / DAY));
  return (
    <RowLink href={taskHref(row.task)} focused={focused} index={index}>
      <div className="flex items-start gap-2" title={[row.task.title, row.task.short_id].filter(Boolean).join(" · ")}>
        <span className="text-[13px] text-sol-text leading-snug flex-1 min-w-0 line-title">{row.task.title}</span>
      </div>
      {/* The countdown and the days it has left on one line, then what the
          watch is measured against, wrapping rather than clipping. */}
      <div className="mt-1.5 flex items-center gap-2 min-w-0">
        <div className="line-countdown flex-1 min-w-0" title={`${row.daysLeft} of ${span} watch days left`}>
          <span style={{ "--left": `${Math.max(4, Math.min(100, (row.daysLeft / span) * 100))}%` } as CSSProperties} />
        </div>
        <span className="text-[11px] text-sol-text tabular-nums shrink-0 whitespace-nowrap leading-none">{row.daysLeft}d left</span>
      </div>
      {/* A repeat reopens a watched cause, so a row here has had none since. */}
      <div className="mt-1 text-[11px] text-sol-text-dim" title="signals before the ship, and since it">{row.task.cause?.signal_count ?? 0} before ship, 0 since</div>
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
      <div className="flex items-start gap-2" title={[row.task.title, row.task.short_id].filter(Boolean).join(" · ")}>
        <span className={cn("text-[13px] w-3 shrink-0", o.tone)}>{o.glyph}</span>
        <span className={cn("text-[13px] leading-snug flex-1 min-w-0 line-title", row.outcome === "dissolved" ? "text-sol-text-muted" : "text-sol-text")}>{row.task.title}</span>
      </div>
      <div className="mt-1 pl-5 text-[11px] text-sol-text-dim"><span className={cn("whitespace-nowrap", o.tone)}>{row.outcome}</span> <span className="whitespace-nowrap">· {ago(row.at, now)}</span></div>
    </RowLink>
  );
}
