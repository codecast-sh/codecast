"use client";
// One line per project (docs/architecture/line-profile.md LP1): the switcher
// in the line page's header, the URL that holds the choice, and the "all
// projects" roll-up, which only counts. Every number comes from lib/lineFlow
// (lineRollup builds each project's flow the way its own page does).
import { Fragment, useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { ALL_PROJECTS, NO_PROJECT, type LineProject, type RollupRow } from "../../lib/lineFlow";
import { cn } from "../../lib/utils";
import { lineProjectParam } from "../../lib/line/lineStations";
import { centerInRow, edgeAttrs, useScrollEdges, type ScrollEdges } from "./useScrollEdges";
import { EdgeArrows } from "./EdgeArrows";
import { useWatchEffect } from "../../hooks/useWatchEffect";

/** The URL names a line by its project's short id (or id), "none" or "all". */
const paramOf = (key: string, projects: LineProject[]) => {
  const p = key === ALL_PROJECTS || key === NO_PROJECT ? null : projects.find((x) => x._id === key);
  return p ? lineProjectParam(p) : key;
};

/**
 * The selected line: the `?project=` the URL names, else the project of the
 * repo the viewer is in, else the line with the most open causes. A ref the
 * viewer cannot see falls back to the default rather than an empty page.
 */
/** `fixed` pins the line to one project (its Line tab): the URL is not read
 *  and nothing switches it. */
export function useLineProject(rollup: RollupRow[], projects: LineProject[], fixed?: string | null) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const asked = search?.get("project") ?? null;
  const key = useMemo(() => {
    if (fixed) return fixed;
    if (asked === ALL_PROJECTS || asked === NO_PROJECT) return asked;
    const named = asked ? projects.find((p) => p.short_id === asked || p._id === asked) : undefined;
    if (named) return named._id;
    // With nothing asked, /line opens on every project's line at once.
    return ALL_PROJECTS;
  }, [fixed, asked, projects]);
  const select = useCallback((next: string) => {
    if (fixed) return;
    const params = new URLSearchParams(search?.toString() ?? "");
    params.set("project", paramOf(next, projects));
    router.replace(`${pathname ?? "/line"}?${params.toString()}`, { scroll: false });
  }, [fixed, router, pathname, search, projects]);
  const param = paramOf(key, projects);
  return { key, select, param, href: `${fixed ? "/line" : pathname ?? "/line"}?project=${encodeURIComponent(param)}` };
}

/** The order the switcher and its keys walk: the roll-up, then each line. */
export const lineKeys = (rollup: RollupRow[]) => [ALL_PROJECTS, ...rollup.map((r) => r.key)];

/** Pills, one per line, each with its open causes; a card waiting on the
 *  viewer or a silent finder marks the pill so another line's trouble shows. */
export function LineProjectSwitcher({ rollup, selected, onSelect }: { rollup: RollupRow[]; selected: string; onSelect: (key: string) => void }) {
  // The pills scroll sideways on a narrow floor, and the hidden edge fades
  // the way the flow's does.
  const row = useRef<HTMLElement>(null);
  const edges = useScrollEdges(row, rollup.length > 0);
  // The selected pill sits at the row's center on mount and on every pick,
  // whole and clear of both faded edges.
  useWatchEffect(() => {
    const nav = row.current;
    const pill = nav?.querySelector<HTMLElement>("[data-active=true]");
    if (nav && pill) centerInRow(nav, pill);
  }, [selected, rollup.length]);
  const waiting = useClippedWaiting(row, edges, rollup);
  if (rollup.length === 0) return null;
  const total = rollup.reduce((n, r) => n + r.causes, 0);
  return (
    <div className="relative -mx-4 sm:-mx-6 min-w-0">
    <nav ref={row} className="line-edge-fade line-scroll-quiet flex items-center gap-1 overflow-x-auto px-4 sm:px-6 pb-0.5" aria-label="Projects" data-line-projects {...edgeAttrs(edges)}>
      <Pill active={selected === ALL_PROJECTS} onClick={() => onSelect(ALL_PROJECTS)} label="All projects" count={total} />
      {rollup.map((r) => (
        <Pill
          key={r.key}
          active={selected === r.key}
          onClick={() => onSelect(r.key)}
          label={r.title}
          muted={r.key === NO_PROJECT}
          count={r.causes}
          awaiting={r.awaiting}
          silent={r.silent}
          tip={[`${r.causes} ${r.causes === 1 ? "cause waits" : "causes wait"} to start`, r.awaiting ? `${r.awaiting} finished ${r.awaiting === 1 ? "fix waits" : "fixes wait"} for your decision` : null, r.silent ? `${r.silent} ${r.silent === 1 ? "source has" : "sources have"} gone quiet` : null].filter(Boolean).join(" · ")}
        />
      ))}
    </nav>
    <EdgeArrows scroller={row} edges={edges} label="projects" waiting={waiting} />
    </div>
  );
}

/** The cards waiting on the viewer in pills clipped past each edge of the
 *  row (under the fade counts as clipped), so the arrow can carry them. */
function useClippedWaiting(row: RefObject<HTMLElement | null>, edges: ScrollEdges, rows: unknown) {
  const [waiting, setWaiting] = useState({ left: 0, right: 0 });
  useWatchEffect(() => {
    const nav = row.current;
    if (!nav) return;
    const measure = () => {
      const box = nav.getBoundingClientRect();
      let left = 0, right = 0;
      for (const pill of nav.querySelectorAll<HTMLElement>("[data-pill-awaiting]")) {
        const n = Number(pill.dataset.pillAwaiting) || 0;
        const r = pill.getBoundingClientRect();
        if (r.right > box.right - 28) right += n;
        else if (r.left < box.left + 28) left += n;
      }
      setWaiting((w) => (w.left === left && w.right === right ? w : { left, right }));
    };
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(nav);
    return () => { nav.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, [row, edges.left, edges.right, rows]);
  return waiting;
}

/** A pill is the line's name and one number: the cards waiting on the viewer
 *  in the ask color, else its open causes, quiet. A silent finder adds a dot
 *  in the warning ink. The tooltip spells out every figure. */
function Pill({ active, onClick, label, count, awaiting = 0, silent, muted, tip }: { active: boolean; onClick: () => void; label: string; count: number; awaiting?: number; silent?: number; muted?: boolean; tip?: string }) {
  // Its words never name a node of the map (Causes, Signals, a station), so a
  // reader or a tool looking for the node never lands on a pill (LX1).
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      data-active={active ? "true" : undefined}
      data-line-project-pill
      data-pill-awaiting={awaiting > 0 ? awaiting : undefined}
      className={cn("line-tab shrink-0 rounded-full pl-2.5 pr-2 py-1 text-[11px] whitespace-nowrap flex items-center gap-1.5", muted && !active && "italic")}
    >
      <span>{label}</span>
      {awaiting > 0
        ? <span className="text-sol-yellow tabular-nums font-semibold" aria-label={`${awaiting} waiting for your decision, ${count} waiting to start`} data-line-pill-awaiting>{awaiting}</span>
        : <span className="tabular-nums" data-zero={count === 0 ? "true" : undefined} aria-label={`${count} waiting to start`}>{count}</span>}
      {!!silent && <span className="line-silent-dot" role="img" aria-label={`${silent} quiet source${silent === 1 ? "" : "s"}`} data-line-pill-silent />}
    </button>
  );
}

/** One project's line in words, for the overview (LineOverview): what it is
 *  doing, what waits on the reader, and what is stuck, each a short sentence. */
export function overviewWords(r: RollupRow, sharedHold: string | null = null): { needsYou: string | null; stuck: string | null; doing: string } {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const needsYou = r.awaiting > 0 ? `${n(r.awaiting, "finished fix waits", "finished fixes wait")} for your decision` : null;
  // A reason every line shares is said once, above the cards (LineOverview).
  const stuck = r.hold ? `${n(r.causes, "cause waits", "causes wait")} to start${r.hold === sharedHold ? "" : `: ${r.hold}`}`
    : r.stalled > 0 ? `${n(r.stalled, "run has", "runs have")} said nothing for a day`
    : r.failing ? "The latest run failed"
    : null;
  const doing = [
    r.build > 0 ? `${n(r.build, "cause", "causes")} being worked on` : "nothing being worked on",
    r.causes > 0 && !r.hold ? `${r.causes} waiting to start` : null,
    r.watching > 0 ? `${n(r.watching, "shipped fix", "shipped fixes")} being watched` : null,
    r.closed > 0 ? `${r.closed} closed this week` : null,
  ].filter(Boolean).join(", ");
  return { needsYou, stuck, doing: doing.charAt(0).toUpperCase() + doing.slice(1) };
}

/** Why a project is stuck, as the reason its card gives, so projects stuck
 *  for one reason are counted together; null when it is not stuck. */
function stuckReason(r: RollupRow): string | null {
  if (r.hold) return r.hold;
  if (r.stalled > 0) return "a run has said nothing for a day";
  if (r.failing) return "the latest run failed";
  return null;
}

/** Projects that need the reader first, then the stuck, then the busiest. */
const overviewRank = (r: RollupRow) => (r.awaiting > 0 ? 0 : overviewWords(r).stuck ? 1 : r.build > 0 ? 2 : 3);

/** Every project's line, one card each, saying what it is doing, what waits
 *  on you and what is stuck, and which lines its work runs through. A card
 *  opens that project's line. */
export function LineOverview({ rollup, onSelect }: { rollup: RollupRow[]; onSelect: (key: string) => void }) {
  const rows = [...rollup].sort((a, b) => Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT) || overviewRank(a) - overviewRank(b) || b.causes - a.causes);
  const asks = rollup.reduce((n, r) => n + r.awaiting, 0);
  // One reason held by most lines (starting switched off everywhere) is said once.
  const holds = rollup.filter((r) => r.key !== NO_PROJECT && r.hold).map((r) => r.hold!);
  const top = [...new Set(holds)].map((h) => [h, holds.filter((x) => x === h).length] as const).sort((a, b) => b[1] - a[1])[0];
  const sharedHold = top && top[1] >= 2 ? top[0] : null;
  const stuckRows = rollup.filter((r) => r.key !== NO_PROJECT && overviewWords(r).stuck);
  const stuck = stuckRows.length;
  // Every stuck project's reason, grouped, so the count under the summary
  // adds up; a small group names its projects, each opening its line.
  const reasons = [...stuckRows.reduce((m, r) => m.set(stuckReason(r) ?? "", [...(m.get(stuckReason(r) ?? "") ?? []), r]), new Map<string, RollupRow[]>())].sort((a, b) => b[1].length - a[1].length);
  const summary = [
    asks > 0 ? `${asks} finished ${asks === 1 ? "fix waits" : "fixes wait"} for your decision` : "nothing waits for your decision",
    stuck > 0 ? `${stuck} ${stuck === 1 ? "project is" : "projects are"} stuck` : null,
  ].filter(Boolean).join(", ");
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-8" data-line-overview data-line-rollup>
      <p className="line-overview-summary" data-line-overview-summary>
        <span className={asks > 0 ? "text-sol-yellow" : "text-sol-text"}>{summary.charAt(0).toUpperCase() + summary.slice(1)}.</span>
        {reasons.length > 0 && (
          <span className="block text-[12.5px] text-sol-orange mt-0.5" data-line-overview-shared-hold>
            {reasons.map(([why, rs]) => (
              <span key={why} className="block" data-line-overview-reason={rs.length}>
                {rs.length > 3 ? `${rs.length} of them` : rs.map((r, j) => (
                  <Fragment key={r.key}>{j > 0 && (j === rs.length - 1 ? " and " : ", ")}<button type="button" onClick={() => onSelect(r.key)} className="underline decoration-dotted underline-offset-2 hover:text-sol-text">{r.title}</button></Fragment>
                ))}
                {`: ${why}.`}
              </span>
            ))}
          </span>
        )}
      </p>
      <ul className="line-overview-grid">
        {rows.map((r, i) => {
          const w = overviewWords(r, sharedHold);
          return (
            <li key={r.key} style={{ "--i": i } as React.CSSProperties}>
              <button type="button" onClick={() => onSelect(r.key)} className="line-overview-card" data-line-overview-card={r.key} data-line-rollup-row={r.key} data-tone={w.needsYou ? "ask" : w.stuck ? "warn" : undefined}>
                <span className="line-overview-head">
                  <b className={r.key === NO_PROJECT ? "italic" : undefined}>{r.key === NO_PROJECT ? "Causes under no project" : r.title}</b>
                  <span className="line-overview-open">Open<ArrowRight className="w-3 h-3" aria-hidden /></span>
                </span>
                {w.needsYou && <span className="line-overview-ask" data-line-overview-ask>{w.needsYou}</span>}
                {w.stuck && <span className="line-overview-stuck" data-line-overview-stuck>{w.stuck}</span>}
                <span className="line-overview-doing">{w.doing}.</span>
                {r.graphs.length > 0 && (
                  <span className="line-overview-graphs" data-line-overview-graphs>
                    <span className="text-sol-text-dim">Runs through </span>
                    {r.graphs.map((g, j) => (
                      <span key={g.key}>{j > 0 && <span className="text-sol-text-dim">{j === r.graphs.length - 1 ? " and " : ", "}</span>}<span className="text-sol-text-muted">{g.title}</span><span className="text-sol-text-dim"> ({g.work})</span></span>
                    ))}
                    {r.neverRun > 0 && <span className="text-sol-text-dim" data-line-overview-never-run>. {r.neverRun} waiting {r.neverRun === 1 ? "cause has" : "causes have"} not run on any line yet</span>}
                  </span>
                )}
                <span className="line-overview-sources">
                  {r.signalsDay > 0 ? `${r.signalsDay} new ${r.signalsDay === 1 ? "signal" : "signals"} in the last day` : "No new signals in the last day"}
                  {r.silent > 0 && <span className="text-sol-orange">, {r.silent} {r.silent === 1 ? "source has" : "sources have"} gone quiet</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
