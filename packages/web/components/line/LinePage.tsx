"use client";
// The line page (docs/architecture/line-workspace.md LW1): every project's
// line at once, each card opening that project's workspace, `/line/<project>`.
// Above the cards, the week across every line: what shipped, how fast, what
// came back. Problems filed under no project have no workspace, so the page
// lists them itself. A workspace with no line yet teaches the first step.
// Paints from the store (useLineFloor); lib/lineFlow derives every number.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, SlidersHorizontal } from "lucide-react";
import { formatTokens } from "@codecast/shared/render/changeCardHtml";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";
import { LINE_STATION_SETTINGS, lineSettingsHref } from "../../lib/lineSettings";
import { formatElapsed } from "../../lib/taskLine";
import { cn } from "../../lib/utils";
import { buildLineFlow, isCause, scopeLine, ALL_PROJECTS, NO_PROJECT, type LineProject } from "../../lib/lineFlow";
import { lineWorkspaceHref } from "../../lib/line/lineWorkspaceUrl";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { LineOverview, LineProjectSwitcher, lineKeys } from "./LineProjects";
import { useLineFloor } from "./useLineFloor";
import { LineSetup } from "./LineSetup";
import "./line.css";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";

/** formatElapsed without its zero units: "2d", "2d 5h", "40m", never "2d 0h". */
const ago = (from: number | null | undefined, now: number) => (from == null ? null : (formatElapsed(from, now) ?? "").replace(/ 0[hm]$/, ""));
const compactElapsed = (ms: number) => ago(0, ms) ?? "";

type StationKey = "sense" | "causes" | "build" | "awaiting" | "watching" | "closed";
/** `what` teaches an empty station: what it is for, in plain words. */
type Station = { key: StationKey; name: string; what: string };

const STATIONS: Station[] = [
  { key: "sense", name: "Sources report", what: "Sentry, PostHog, evals, an agent watching your agents, or a person: each report is a finding." },
  { key: "causes", name: "Problems", what: "Findings about the same thing join one problem. Problems wait their turn, the most important first." },
  { key: "build", name: "Worked on", what: "Agents and scripts take the top problem through the line's steps: find why it happens, prove it, build a fix, check it." },
  { key: "awaiting", name: "You decide", what: "Each finished fix comes to you with its proof. You ship it, send it back, or drop it." },
  { key: "watching", name: "Watched", what: "A shipped fix is watched. If the problem comes back, it opens again; a quiet watch closes it." },
  { key: "closed", name: "Closed", what: "Problems fixed and shipped, closed without a change, or resolved in the last seven days." },
];

export function LinePage() {
  const { now, projects, lineRows, rollup, line } = useLineFloor();
  // A project's card or pill opens its workspace; the roll-up and the problems under no project stay here.
  const router = useRouter();
  const openLine = (key: string) => {
    if (key === NO_PROJECT || key === ALL_PROJECTS) { line.select(key); return; }
    router.push(lineWorkspaceHref(rollup.find((r) => r.key === key)?.short_id ?? key));
  };
  const flow = useMemo(() => buildLineFlow({ ...lineRows, initiatives: [], projects, now }), [lineRows, projects, now]);
  const unfiled = useMemo(() => scopeLine(lineRows, NO_PROJECT).tasks.filter(isCause), [lineRows]);
  const showUnfiled = line.key === NO_PROJECT;
  const rollupView = !showUnfiled && rollup.length > 0;

  // Brackets walk the pills: the roll-up, then each line.
  useWatchEffect(() => {
    if (rollup.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const keys = lineKeys(rollup);
      const idx = Math.max(0, keys.indexOf(line.key));
      openLine(keys[(idx + (e.key === "]" ? 1 : -1) + keys.length) % keys.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rollup, line]);

  return (
    <div className="line-floor h-full flex flex-col min-h-0" data-line-page>
      <header className="shrink-0 px-4 sm:px-6 pt-4 pb-2.5 flex flex-col gap-2.5">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[13px] font-semibold text-sol-text leading-none">The line</h1>
          <span className="line-subtitle text-[11px] text-sol-text-dim leading-none truncate">every problem your sources find, worked through to a shipped, watched fix</span>
        </div>
        <LineProjectSwitcher rollup={rollup} selected={line.key} onSelect={openLine} />
        {rollupView && <Throughput t={flow.throughput} />}
      </header>

      {showUnfiled ? <Unfiled causes={unfiled} />
        : rollupView ? <LineOverview rollup={rollup} projects={projects} onSelect={openLine} />
        : <Onboarding projects={projects} />}

      <footer className="shrink-0 flex items-center gap-4 px-4 sm:px-6 py-2 border-t border-sol-border/30 text-[11px] text-sol-text-dim">
        <FooterLinks projectsKeys={rollup.length > 0} />
      </footer>
    </div>
  );
}

/** Problems filed under no project: they have no line of their own, so each opens its task. */
function Unfiled({ causes }: { causes: ReadonlyArray<{ _id: string; short_id?: string; title?: string; status?: string }> }) {
  if (!causes.length) return <p className="flex-1 px-4 sm:px-6 py-6 text-[12.5px] text-sol-text-dim" data-line-unfiled="">Every problem is filed under a project.</p>;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-5" data-line-unfiled={causes.length}>
      <p className="py-2 text-[12px] text-sol-text-dim max-w-[64ch]">These problems are filed under no project, so no project's line works them. File one under a project to put it on that line.</p>
      <ul className="divide-y divide-sol-border/20 border-t border-sol-border/20">
        {causes.map((c) => (
          <li key={c._id} className="flex items-baseline gap-3 py-1.5 text-[12.5px]">
            <span className="shrink-0 font-mono text-[11px] text-sol-text-dim w-[6.5em]">{c.short_id ?? ""}</span>
            <Link href={`/tasks/${c.short_id ?? c._id}`} className="min-w-0 flex-1 truncate text-sol-text hover:text-sol-blue">{c.title ?? c.short_id}</Link>
            <span className="shrink-0 text-sol-text-dim">{c.status?.replace(/_/g, " ")}</span>
          </li>
        ))}
      </ul>
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

/** A footer key hint. Its words drop on a narrow floor (line.css), and the
 *  tooltip keeps saying them. */
function Hint({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <span className={cn("hidden sm:flex items-center gap-1 whitespace-nowrap shrink-0", className)} title={label}>
      {children}<span className="line-hint-text">{label}</span>
    </span>
  );
}

/** A week's bars earn their place with three days that moved; fewer is a
 *  few pixels of nothing, and the number alone says it better. */
const sparkable = (days: number[]) => days.filter((d) => d > 0).length >= 3;

/** The week across every line as one dim clause; a click opens the week's figures under it. */
function Throughput({ t }: { t: ReturnType<typeof buildLineFlow>["throughput"] }) {
  const [open, setOpen] = useState(false);
  const moved = t.signalsIn + t.opened + t.dissolved + t.shipped + t.reopened > 0;
  if (!moved) {
    return <div className="line-head-row"><span className="text-[12px] text-sol-text-dim" data-line-throughput="quiet">nothing reported this week</span></div>;
  }
  const inWatch = t.shippedInWatch > 0 ? (t.shippedInWatch === t.shipped ? "now in watch" : `${t.shippedInWatch} in watch`) : null;
  const median = t.medianToShip === null ? null : compactElapsed(t.medianToShip);
  // A metric with nothing measured yet stays out, so it never reads as a value.
  const lead: Array<{ label: string; value: string | number; tip: string; spark?: number[]; note?: string | null }> = [
    { label: "fixes shipped this week", value: t.shipped, spark: t.daily.shipped, note: inWatch, tip: `Fixes shipped in the last 7 days, per day.${t.shippedInWatch ? ` ${t.shippedInWatch} still being watched; a fix counts as closed once its watch ends quiet.` : ""}` },
    ...(median ? [{ label: "usual time from first report to ship", value: median, tip: "From a problem's first report to its fix shipping, the median over this week's ships" }] : []),
  ];
  const flowCells: Array<{ label: string; value: string | number; tone?: string; spark?: number[]; tip: string; unit?: string }> = [
    { label: "findings reported", value: t.signalsIn, spark: t.daily.signalsIn, tip: "Findings the sources reported this week, per day" },
    { label: "new problems", value: t.opened, spark: t.daily.opened, tip: "Problems opened this week, per day" },
    { label: "closed without a change", value: t.dissolved, spark: t.daily.dissolved, tip: "Problems that did not reproduce and closed without a change this week, per day" },
    { label: "came back after a fix", value: t.reopened, tone: t.reopened ? "text-sol-red" : undefined, spark: t.daily.reopened, tip: "Problems that came back after their fix shipped, this week, per day" },
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
          A source reports something it saw: a finding. Findings about the same thing make one problem to fix. The line's steps find why it happens, prove it and build a fix, then you decide whether it ships.
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
              ? <Link href={lineWorkspaceHref(p.short_id ?? p._id)} className="shrink-0 text-sol-text-muted hover:text-sol-blue hover:underline">Open its line</Link>
              : <Link href={lineSettingsHref({ project: p })} className="shrink-0 inline-flex items-center gap-1 text-sol-cyan hover:underline" data-line-setup-action>Set up the line<ArrowRight className="w-3 h-3" /></Link>}
          </li>
        ))}
      </ul>
    </LineSetup>
  );
}
