"use client";
// The line page (docs/architecture/line-map.md LX1): one project's line as
// its map (LineMapView), from what the world reported to a held fix, with the
// headline and the week's figures above it. Paints from the store
// (useLineFloor): signals, tasks with a `cause`, runs and the decision queue;
// lib/lineFlow derives the headline and the throughput strip, lib/line/lineMap
// the map. One project's line at a time (line-profile.md LP1): LineProjects
// holds the switcher and the "all projects" roll-up, and scopeLine narrows the
// rows. A workspace with no line yet teaches the first step.
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Copy, SlidersHorizontal } from "lucide-react";
import { formatTokens } from "@codecast/shared/render/changeCardHtml";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal, useShortcutAction, useShortcutContext } from "../../shortcuts";
import { KeyHint } from "../changes/useChangesKeys";
import { LINE_STATION_SETTINGS, lineSettingsHref, lineTabHref } from "../../lib/lineSettings";
import { formatElapsed } from "../../lib/taskLine";
import { cn } from "../../lib/utils";
import { copyText } from "../../lib/copyText";
import {
  buildLineFlow, lineHeadline, scopeLine, ALL_PROJECTS, NO_PROJECT,
  type HeadlinePart, type LineProject, type GoalRow,
} from "../../lib/lineFlow";
import { LINE_SETTINGS_NODE } from "../../lib/line/lineMapUrl";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { LineProjectSwitcher, LineRollup, lineKeys } from "./LineProjects";
import { useLineFloor } from "./useLineFloor";
import { LineSetup } from "./LineSetup";
import { LineMapView, useLineMapUrl } from "./map/LineMapView";
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

/** `project` pins the page to one project's line: the project's Line tab
 *  embeds it with no switcher, and links out to the whole /line. One
 *  project's line is its map (line-map.md LX1, LX2): the stations of its
 *  actual graph with the window's data over them, and a panel per node. The
 *  roll-up across projects only counts. */
export function LinePage({ project: pinned, workspace }: { project?: string; workspace?: string | null } = {}) {
  const initiatives = useInitiatives();
  const { now, projects, lineRows, rollup, line } = useLineFloor(pinned, workspace);
  const mapUrl = useLineMapUrl();
  // Settings belong to one project's line; on the map they are a panel.
  const settingsProject = line.key === ALL_PROJECTS || line.key === NO_PROJECT ? null : line.param;
  const openSettings = () => mapUrl.set({ node: LINE_SETTINGS_NODE });
  useShortcutContext("line");
  useShortcutAction("line.settings", () => { if (!settingsProject) return false; openSettings(); return true; });
  // With no line anywhere the roll-up has nothing to count: the page teaches instead.
  const rollupView = !pinned && line.key === ALL_PROJECTS && rollup.length > 0;
  // One project's line lives on its project's Line tab too (LM7).
  const tabHref = settingsProject && !pinned ? lineTabHref(line.key) : null;
  const lineProfile = useMemo(() => projects.find((p) => p._id === line.key)?.line_profile, [projects, line.key]);
  const finders = lineProfile?.finders;
  const findersSince = lineProfile?.changed_at;

  const scoped = useMemo(() => scopeLine(lineRows, line.key), [lineRows, line.key]);
  const flow = useMemo(() => buildLineFlow({
    ...scoped,
    initiatives: initiatives.map((i: InitiativeRow) => ({ short_id: i.short_id, title: i.title, priority: i.priority as GoalRow["priority"] })),
    projects,
    now,
    finders,
    findersSince,
  }), [scoped, initiatives, projects, now, finders, findersSince]);

  // Nothing anywhere on this line: the map still draws its stations, with the first step above them.
  const allEmpty = flow.sense.items.length === 0 && flow.causes.count === 0 && flow.build.count === 0 && flow.awaiting.count === 0 && flow.watching.count === 0 && flow.closed.count === 0;
  const onMap = line.key !== ALL_PROJECTS;

  // Brackets walk the lines: the roll-up, then each project.
  useWatchEffect(() => {
    if (pinned || rollup.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const keys = lineKeys(rollup);
      const idx = Math.max(0, keys.indexOf(line.key));
      line.select(keys[(idx + (e.key === "]" ? 1 : -1) + keys.length) % keys.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned, rollup, line]);

  // A headline part that names a station opens that node's panel on the map.
  const onStation = (key: NonNullable<HeadlinePart["station"]>) => {
    const node = key === "causes" ? "causes" : key === "awaiting" ? CARD_GATE_NODE_ID : key === "watching" ? "watch" : flow.build.items[0]?.run.current_node_id ?? "implement";
    mapUrl.set({ node });
  };

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-5 pb-3 flex flex-col gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[13px] font-semibold text-sol-text leading-none">{pinned ? "The map" : "The line"}</h1>
          <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">a signal in the world to a shipped, watched change</span>
          {tabHref && (
            <Link href={tabHref} className="ml-auto self-center shrink-0 text-[11px] text-sol-text-dim hover:text-sol-text" title="This project's line: its map, sources, stations and versions" data-line-tab-link>
              Line tab
            </Link>
          )}
          {pinned && (
            <Link href={line.href} className="ml-auto self-center shrink-0 text-[11px] text-sol-text-dim hover:text-sol-text" title="Every project's line on one floor" data-line-all-link>
              All lines
            </Link>
          )}
          {settingsProject && (
            <button type="button" onClick={openSettings} className={cn(tabHref || pinned ? "" : "ml-auto", "self-center shrink-0 inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text")} title="What this line listens to, checks, limits and runs" data-line-settings-link>
              <SlidersHorizontal className="w-3 h-3" />
              <span>settings</span>
              <KeyHint action="line.settings" />
            </button>
          )}
        </div>
        {!pinned && <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={(k) => line.select(k)} />}
        {onMap && !allEmpty && <Throughput t={flow.throughput} lead={<Headline parts={headlineLead(lineHeadline(flow, now))} onStation={onStation} />} />}
      </header>

      {rollupView ? <LineRollup rollup={rollup} onSelect={(k) => line.select(k)} />
        : !onMap ? <Onboarding projects={projects} />
        : (
          <div className="flex-1 min-h-0 border-t border-sol-border/30" data-line-flow>
            <LineMapView
              projectId={line.key === NO_PROJECT ? null : line.key}
              rows={scoped}
              flow={flow}
              now={now}
              note={allEmpty ? <FirstSignal /> : undefined}
            />
          </div>
        )}

      <footer className="shrink-0 flex items-center gap-4 px-4 sm:px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
        {rollup.length > 0 && !pinned && <Hint label="projects"><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap></Hint>}
        <span className="ml-auto shrink-0 whitespace-nowrap flex items-center gap-3" data-line-footer-links>
          <Link href="/questions" className="hover:text-sol-text">all questions</Link>
          <Link href="/routines" className="hover:text-sol-text">workflows</Link>
        </span>
      </footer>
    </div>
  );
}

/** A line nothing has reached yet: the one command that starts it. */
function FirstSignal() {
  return (
    <div className="lmap-note flex flex-wrap items-center gap-x-3 gap-y-2" data-line-first-signal>
      <span>Nothing has reached this line yet. File the first signal, and watch it move through the map:</span>
      <div className="w-fit max-w-full"><Cmd cmd={FIRST_SIGNAL} /></div>
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
function Headline({ parts, onStation }: { parts: HeadlinePart[]; onStation: (key: NonNullable<HeadlinePart["station"]>) => void }) {
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



/** The setting that would fill an empty station, as a quiet link into line settings. */
function SettingsLink({ href, station }: { href: string; station: StationKey }) {
  const say = LINE_STATION_SETTINGS[station]?.say;
  if (!say) return null;
  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} className="line-settings-link self-start inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text" data-line-station-settings={station}>
      <SlidersHorizontal className="w-3 h-3 shrink-0" />
      {say}
    </Link>
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
function Onboarding({ projects }: { projects: LineProject[] }) {
  const [focusedCol, onFocus] = useState(0);
  const settingsOf = (station: StationKey) => lineSettingsHref({ section: LINE_STATION_SETTINGS[station]?.section });
  return (
    <div className="line-onboard flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-5 flex flex-col" data-line-onboarding>
      {/* The workspace's projects, each with the step that starts its line,
          then the first signal, then the stations, top aligned at the
          header's rhythm: where to start, what to do, where it will flow. */}
      <div className="flex flex-col gap-5 pt-1 pb-4">
      {projects.length > 0 && <ProjectStarts projects={projects} />}
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
            <div className="line-ghost-cmd mt-auto pt-3 flex flex-col gap-2"><Cmd cmd={s.cmd} shown={focusedCol === i} /><SettingsLink href={settingsOf(s.key)} station={s.key} /></div>
          </li>
        ))}
      </ol>
      </div>
      </div>
    </div>
  );
}

/** Every project in the workspace, each with its line's next step: set it up,
 *  or open its Line tab when its profile is published. */
function ProjectStarts({ projects }: { projects: LineProject[] }) {
  const rows = [...projects].sort((a, b) => Number(!!b.line_profile) - Number(!!a.line_profile) || (a.title ?? "").localeCompare(b.title ?? ""));
  return (
    <LineSetup heading="Start a line on one of this workspace's projects">
      <ul className="mt-3 divide-y divide-sol-border/20 border-t border-sol-border/20" data-line-project-starts>
        {rows.map((p) => (
          <li key={p._id} className="flex items-baseline gap-3 py-1.5 text-[12.5px]" data-line-project-start={p.short_id ?? p._id}>
            <span className="min-w-0 flex-1 truncate text-sol-text">{p.title ?? p.short_id}</span>
            {p.line_profile
              ? <Link href={lineTabHref(p.short_id ?? p._id)} className="shrink-0 text-sol-text-muted hover:text-sol-blue hover:underline">Line tab</Link>
              : <Link href={lineSettingsHref({ project: p })} className="shrink-0 inline-flex items-center gap-1 text-sol-cyan hover:underline" data-line-setup-action>Set up the line<ArrowRight className="w-3 h-3" /></Link>}
          </li>
        ))}
      </ul>
    </LineSetup>
  );
}
