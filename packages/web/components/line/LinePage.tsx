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
import { ArrowRight, ChevronDown, SlidersHorizontal } from "lucide-react";
import { formatTokens } from "@codecast/shared/render/changeCardHtml";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal, useShortcutAction, useShortcutContext } from "../../shortcuts";
import { LINE_STATION_SETTINGS, lineSettingsHref, lineTabHref } from "../../lib/lineSettings";
import { formatElapsed } from "../../lib/taskLine";
import { cn } from "../../lib/utils";
import {
  buildLineFlow, lineHeadline, scopeLine, ALL_PROJECTS, NO_PROJECT,
  type HeadlinePart, type LineProject, type GoalRow,
} from "../../lib/lineFlow";
import { LINE_SETTINGS_NODE } from "../../lib/line/lineMapUrl";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { LineOverview, LineProjectSwitcher, lineKeys } from "./LineProjects";
import { useLineFloor } from "./useLineFloor";
import { LineSetup } from "./LineSetup";
import { LineMapView, useLineMapUrl } from "./map/LineMapView";
import { useLineAdmission } from "./map/useLineAdmission";
import "./line.css";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";

/** formatElapsed without its zero units: "2d", "2d 5h", "40m", never "2d 0h". */
const ago = (from: number | null | undefined, now: number) => (from == null ? null : (formatElapsed(from, now) ?? "").replace(/ 0[hm]$/, ""));
const compactElapsed = (ms: number) => ago(0, ms) ?? "";

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
/** `what` teaches an empty station: what it is for, in plain words. */
type Station = { key: StationKey; name: string; what: string };

const STATIONS: Station[] = [
  { key: "sense", name: "Sources report", what: "Sentry, PostHog, evals, an agent watching your agents, or a person: each report is a signal." },
  { key: "causes", name: "Causes", what: "Signals about the same thing join one cause. Causes wait their turn, the most important first." },
  { key: "build", name: "Worked on", what: "Agents and scripts take the top cause through the line's steps: find the cause, prove it, build a fix, check it." },
  { key: "awaiting", name: "You decide", what: "Each finished fix comes to you with its proof. You ship it, send it back, or drop it." },
  { key: "watching", name: "Watched", what: "A shipped fix is watched. If the problem comes back, it opens again; a quiet watch closes it." },
  { key: "closed", name: "Closed", what: "Causes shipped, closed without a change, or resolved in the last seven days." },
];

/** `project` pins the page to one project's line: the project's Line tab
 *  embeds it with no switcher, and links out to the whole /line. One
 *  project's line is its map (line-map.md LX1, LX2): the stations of its
 *  actual graph with the window's data over them, and a panel per node. The
 *  roll-up across projects only counts. */
export function LinePage({ project: pinned, workspace }: { project?: string; workspace?: string | null } = {}) {
  const initiatives = useInitiatives();
  const { now, projects, lineRows, rollup, line } = useLineFloor(pinned, workspace);
  const mapUrl = useLineMapUrl(pinned ? null : line.param);
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
  // Whether the line may start its next cause: why nothing starts, and the switch and slots that decide it.
  const admit = useLineAdmission(line.key === ALL_PROJECTS ? null : line.key);
  const flow = useMemo(() => buildLineFlow({
    ...scoped,
    initiatives: initiatives.map((i: InitiativeRow) => ({ short_id: i.short_id, title: i.title, priority: i.priority as GoalRow["priority"] })),
    projects,
    now,
    finders,
    findersSince,
    admission: admit.admission,
  }), [scoped, initiatives, projects, now, finders, findersSince, admit.admission]);

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

  // The headline speaks for the selected line only, so it names it, and a
  // card waiting in another project is one click away (LX1).
  const scopeName = useMemo(() => rollup.find((r) => r.key === line.key)?.title ?? null, [rollup, line.key]);
  const elsewhere = useMemo(() => {
    const others = rollup.filter((r) => r.key !== line.key && r.awaiting > 0).sort((a, b) => b.awaiting - a.awaiting);
    return others.length ? { key: others[0].key, title: others[0].title, count: others.reduce((n, r) => n + r.awaiting, 0), projects: others.length } : null;
  }, [rollup, line.key]);

  // With a card elsewhere the all-clear says "here", against the link to there;
  // the project switcher right above already names this line.
  const headline = useMemo(() => {
    const parts = headlineLead(lineHeadline(flow, now, elsewhere ? null : scopeName));
    return elsewhere ? parts.map((p) => (p.tone === "clear" ? { ...p, text: "nothing needs you here" } : p)) : parts;
  }, [flow, now, scopeName, elsewhere]);
  const panelOpen = !!(mapUrl.state.node || mapUrl.state.edge);
  // The one thing to do about the headline, done here rather than told. When
  // the line's own switch holds the queue, the button turns it on; when the
  // hold is elsewhere (starting is off in codecast itself, the day's limit,
  // the slots), it opens Causes, where the top cause starts by hand.
  const action = useMemo<HeadAction | null>(() => {
    if (flow.causes.state.kind !== "paused" || !flow.causes.count) return null;
    const a = admit.admission;
    if (a?.role && !a.on && !a.sweepOff && !a.role.paused) return { label: "Turn on automatic starting", run: () => admit.setOn(true), tip: `@${a.role.handle} starts the top cause on its own while there is room` };
    return { label: flow.causes.hold?.top ? "Start the top cause" : "See the waiting causes", run: () => mapUrl.set({ node: "causes" }), tip: "Opens Causes, where you can start one by hand" };
  }, [flow.causes, admit, mapUrl]);

  // A headline part that names a station opens that node's panel on the map.
  const onStation = (key: NonNullable<HeadlinePart["station"]>) => {
    const node = key === "causes" ? "causes" : key === "awaiting" ? CARD_GATE_NODE_ID : key === "watching" ? "watch" : flow.build.items[0]?.run.current_node_id ?? "implement";
    mapUrl.set({ node });
  };

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      {/* The project's Line tab sits under the project's own header: the map
          leads, its window and counts in the map's own bar. /line names itself
          and switches lines; settings live once, in the map's bar. */}
      {!pinned && (
        <header className="shrink-0 px-4 sm:px-6 pt-4 pb-2.5 flex flex-col gap-2.5">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-[13px] font-semibold text-sol-text leading-none">The line</h1>
            <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">every cause your sources find, worked through to a shipped, watched fix</span>
            {tabHref && (
              <Link href={tabHref} className="ml-auto self-center shrink-0 text-[11px] text-sol-text-dim hover:text-sol-text" title="This line on its project's page, with what each version of it delivered" data-line-tab-link>
                On the project's page
              </Link>
            )}
          </div>
          <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={(k) => line.select(k)} />
          {onMap && !allEmpty && <Throughput t={flow.throughput} brief={panelOpen} lead={<Headline parts={headline} onStation={onStation} action={action} elsewhere={elsewhere} onElsewhere={() => elsewhere && line.select(elsewhere.key)} />} />}
        </header>
      )}

      {rollupView ? <LineOverview rollup={rollup} onSelect={(k) => line.select(k)} />
        : !onMap ? <Onboarding projects={projects} />
        : (
          <div className={cn("flex-1 min-h-0", !pinned && "border-t border-sol-border/30")} data-line-flow>
            <LineMapView
              projectId={line.key === NO_PROJECT ? null : line.key}
              rows={scoped}
              flow={flow}
              now={now}
              note={allEmpty ? <FirstSignal /> : undefined}
              lineParam={pinned ? null : line.param}
              admit={admit}
              footEnd={<FooterLinks projectsKeys={rollup.length > 0 && !pinned} />}
              barEnd={pinned ? (
                <Link href={line.href} className="shrink-0 text-[11px] text-sol-text-dim hover:text-sol-text" title="Every project on one page" data-line-all-link>All projects</Link>
              ) : undefined}
            />
          </div>
        )}

      {/* On the map its key row carries these, one line, and the map keeps the height. */}
      {(rollupView || !onMap) && (
        <footer className="shrink-0 flex items-center gap-4 px-4 sm:px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
          <FooterLinks projectsKeys={rollup.length > 0 && !pinned} />
        </footer>
      )}
    </div>
  );
}

/** The page's own keys and links, at the end of whichever footer row shows. */
function FooterLinks({ projectsKeys }: { projectsKeys: boolean }) {
  return (
    <>
      {projectsKeys && <Hint label="projects"><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap></Hint>}
      <span className="ml-auto shrink-0 whitespace-nowrap flex items-center gap-3" data-line-footer-links>
        <Link href="/questions" className="hover:text-sol-text">all questions</Link>
        <Link href="/routines" className="hover:text-sol-text">workflows</Link>
      </span>
    </>
  );
}

/** A line nothing has reached yet: where its work will come from. */
function FirstSignal() {
  return (
    <p className="lmap-note" data-line-first-signal>
      Nothing has reached this line yet. Causes arrive when one of its sources reports something; you can also ask for a change from any step on the map, and it runs through the line like any other cause.
    </p>
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

/** The five-second read: what needs you or is wrong, each reason as its own
 *  quieter sentence, then the one thing to do about it as a button. A part
 *  that names a station opens it on the map. A finished fix waiting in
 *  another project is its own quiet line under it. */
type Elsewhere = { key: string; title: string; count: number; projects: number };
type HeadAction = { label: string; run: () => void; tip: string };
function Headline({ parts, onStation, action, elsewhere, onElsewhere }: { parts: HeadlinePart[]; onStation: (key: NonNullable<HeadlinePart["station"]>) => void; action?: HeadAction | null; elsewhere?: Elsewhere | null; onElsewhere?: () => void }) {
  return (
    <div className="line-headline-block min-w-0" data-line-headline-block>
      <p className="line-headline text-sol-text" data-line-headline>
        {parts.map((p, i) => {
          // A part with a reason ends its sentence there; the next part opens a new one.
          const opens = i === 0 || !!parts[i - 1].why;
          const text = (opens ? p.text.charAt(0).toUpperCase() + p.text.slice(1) : p.text).replace(/(\d+) /g, "$1\u00a0").replace(/ (\d+\w*)$/, "\u00a0$1");
          const station = p.station;
          // The comma rides the part before it, so a wrap never opens a line with one.
          const sep = p.why ? ". " : i < parts.length - 1 ? ", " : ".";
          return (
            <Fragment key={i}>
              {p.href
                ? <Link href={p.href} className={cn("line-headline-link", TONE[p.tone])} data-line-headline-run title="Open the run's report">{boldNumbers(text)}</Link>
                : station
                ? <a href={`#line-${station}`} onClick={(e) => { e.preventDefault(); onStation(station); }} className={cn("line-headline-link", TONE[p.tone])} data-line-headline-link={station}>{boldNumbers(text)}</a>
                : <span className={TONE[p.tone] || undefined}>{boldNumbers(text)}</span>}
              {sep}
              {p.why && <span className="line-headline-why text-sol-text-muted" data-line-headline-why>{p.why.charAt(0).toUpperCase() + p.why.slice(1)}.{i < parts.length - 1 ? " " : ""}</span>}
            </Fragment>
          );
        })}
      </p>
      {action && (
        <button type="button" onClick={action.run} title={action.tip} className="line-headline-action" data-line-headline-action>
          {action.label}<ArrowRight className="w-3 h-3" aria-hidden />
        </button>
      )}
      {elsewhere && (
        <button type="button" onClick={onElsewhere} className="line-headline-elsewhere" data-line-headline-elsewhere={elsewhere.key}>
          {`${elsewhere.count} finished ${elsewhere.count === 1 ? "fix waits" : "fixes wait"} for you in ${elsewhere.title}${elsewhere.projects > 1 ? ` and ${elsewhere.projects - 1} more` : ""}`}
          <ArrowRight className="inline-block w-3 h-3 ml-1 align-[-1px]" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A week's bars earn their place with three days that moved; fewer is a
 *  few pixels of nothing, and the number alone says it better. */
const sparkable = (days: number[]) => days.filter((d) => d > 0).length >= 3;

/** The headline, then the week as one dim trailing clause on its row; a
 *  click on the clause opens the week's figures under it. */
function Throughput({ t, lead: headline, brief }: { t: ReturnType<typeof buildLineFlow>["throughput"]; lead: ReactNode; brief?: boolean }) {
  const [open, setOpen] = useState(false);
  // A panel open on the map: the status alone, on one line, and the map takes the height.
  if (brief) return <div className="line-head-row" data-brief="true">{headline}</div>;
  const moved = t.signalsIn + t.opened + t.dissolved + t.shipped + t.reopened > 0;
  if (!moved) {
    return <div className="line-head-row">{headline}<span className="text-[12px] text-sol-text-dim" data-line-throughput="quiet">no signals reported this week</span></div>;
  }
  const inWatch = t.shippedInWatch > 0 ? (t.shippedInWatch === t.shipped ? "now in watch" : `${t.shippedInWatch} in watch`) : null;
  const median = t.medianToShip === null ? null : compactElapsed(t.medianToShip);
  // A metric with nothing measured yet stays out, so it never reads as a value.
  const lead: Array<{ label: string; value: string | number; tip: string; spark?: number[]; note?: string | null }> = [
    { label: "fixes shipped this week", value: t.shipped, spark: t.daily.shipped, note: inWatch, tip: `Fixes shipped in the last 7 days, per day.${t.shippedInWatch ? ` ${t.shippedInWatch} still being watched; a fix counts as closed once its watch ends quiet.` : ""}` },
    ...(median ? [{ label: "usual time from first report to ship", value: median, tip: "From a cause's first signal to its fix shipping, the median over this week's ships" }] : []),
  ];
  const flowCells: Array<{ label: string; value: string | number; tone?: string; spark?: number[]; tip: string; unit?: string }> = [
    { label: "signals reported", value: t.signalsIn, spark: t.daily.signalsIn, tip: "Signals the sources reported this week, per day" },
    { label: "new causes", value: t.opened, spark: t.daily.opened, tip: "Causes opened this week, per day" },
    { label: "closed without a change", value: t.dissolved, spark: t.daily.dissolved, tip: "Causes that did not reproduce and closed without a change this week, per day" },
    { label: "came back after a fix", value: t.reopened, tone: t.reopened ? "text-sol-red" : undefined, spark: t.daily.reopened, tip: "Causes that came back after their fix shipped, this week, per day" },
    ...(t.tokensPerShip === null ? [] : [{ label: "cost per shipped fix", value: formatTokens(Math.round(t.tokensPerShip)), unit: "tokens", tip: "What each shipped fix cost, in tokens. Runs record tokens, not dollars." }]),
  ];
  // The station headers already count signals in and what sits in watch, so
  // the clause says only the week's outcome: what shipped, how fast, and a
  // reopen when there is one.
  const summary: Array<{ n: string | number; words: string; tone?: string }> = [
    { n: t.shipped, words: t.shipped === 1 ? " fix shipped this week" : " fixes shipped this week" },
    ...(median ? [{ n: median, words: " usually, from first report to ship" }] : []),
    ...(t.reopened ? [{ n: t.reopened, words: " came back", tone: "text-sol-red" }] : []),
  ];
  return (
    <div className="flex flex-col gap-2 min-w-0">
    <div className="line-head-row">
    {headline}
    {/* Each figure stays whole and the clause wraps between them; the
        chevron rides the last figure, so a wrap never strands it. */}
    <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="line-meter-summary whitespace-nowrap text-[12px] text-sol-text-dim text-right hover:text-sol-text" data-line-throughput-summary title={open ? "Hide the week's figures" : "The week's figures"}>
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

/** The line before anything has reached it: the projects that can start
 *  one, then how work moves through a line, one step per column. */
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
        <div className="line-start-title text-sol-text">How a line works</div>
        <p className="mt-2 text-[13px] text-sol-text-muted leading-relaxed max-w-[60ch]">
          A source reports something it saw: a signal. Signals about the same thing make one cause: one root problem to fix. The line's steps find its cause, prove it and build a fix, then you decide whether it ships.
        </p>
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
            <div className="line-ghost-cmd mt-auto pt-3 flex flex-col gap-2"><SettingsLink href={settingsOf(s.key)} station={s.key} /></div>
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
