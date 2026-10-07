"use client";
// One line per project (docs/architecture/line-profile.md LP1): the switcher
// in the line page's header, the URL that holds the choice, and the "all
// projects" roll-up, which only counts. Every number comes from lib/lineFlow
// (lineRollup builds each project's flow the way its own page does).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { ALL_PROJECTS, NO_PROJECT, defaultLineKey, type LineProject, type RollupRow } from "../../lib/lineFlow";
import { cn } from "../../lib/utils";
import { lineProjectParam } from "../../lib/line/lineStations";
import { centerInRow, edgeAttrs, useScrollEdges, type ScrollEdges } from "./useScrollEdges";
import { EdgeArrows } from "./EdgeArrows";

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
  const repoPath = useInboxStore((s) => s.activeProjectPath || s.currentConversation?.gitRoot || s.currentConversation?.projectPath || null);
  const asked = search?.get("project") ?? null;
  const key = useMemo(() => {
    if (fixed) return fixed;
    if (asked === ALL_PROJECTS || asked === NO_PROJECT) return asked;
    const named = asked ? projects.find((p) => p.short_id === asked || p._id === asked) : undefined;
    if (named) return named._id;
    return defaultLineKey(rollup, projects, repoPath);
  }, [fixed, asked, projects, rollup, repoPath]);
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
  useEffect(() => {
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
          tip={[r.short_id, `${r.causes} open cause${r.causes === 1 ? "" : "s"}`, r.awaiting ? `${r.awaiting} card${r.awaiting === 1 ? "" : "s"} waiting on you` : null, r.finders ? `${r.finders} finder${r.finders === 1 ? "" : "s"}${r.silent ? `, ${r.silent} silent 24h` : ""}` : null].filter(Boolean).join(" · ")}
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
  useEffect(() => {
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
        ? <span className="text-sol-yellow tabular-nums font-semibold" aria-label={`${awaiting} cards waiting on you, ${count} open causes`} data-line-pill-awaiting>{awaiting}</span>
        : <span className="tabular-nums" data-zero={count === 0 ? "true" : undefined} aria-label={`${count} open causes`}>{count}</span>}
      {!!silent && <span className="line-silent-dot" role="img" aria-label={`${silent} silent finder${silent === 1 ? "" : "s"}`} data-line-pill-silent />}
    </button>
  );
}

const COLS: Array<{ key: keyof RollupRow; label: string; tip: string }> = [
  { key: "signalsDay", label: "Sense 24h", tip: "Signals filed in the last 24 hours" },
  { key: "causes", label: "Causes", tip: "Open causes waiting to be admitted" },
  { key: "build", label: "In build", tip: "Live runs on a cause" },
  { key: "awaiting", label: "Awaiting you", tip: "Change cards waiting on your answer" },
  { key: "watching", label: "Watching", tip: "Shipped causes inside their watch" },
  { key: "closed", label: "Closed 7d", tip: "Causes shipped, dissolved or resolved this week" },
];

/** "All projects": every line counted, nothing listed. A row opens that line. */
export function LineRollup({ rollup, onSelect }: { rollup: RollupRow[]; onSelect: (key: string) => void }) {
  const sum = (k: keyof RollupRow) => rollup.reduce((n, r) => n + (r[k] as number), 0);
  const findersTotal = sum("finders");
  const silentTotal = sum("silent");
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-5" data-line-rollup>
      {/* A narrow screen scrolls the table sideways; the scroller's edge shadow
          says more columns sit past the edge (line.css). */}
      <div className="line-rollup-scroll overflow-x-auto max-w-[1100px]">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr className="text-[11px] text-sol-text-dim">
            <th className="text-left font-normal py-2 pr-4 border-b border-sol-border/40">Project</th>
            {COLS.map((c) => <th key={c.key} title={c.tip} className="text-right font-normal py-2 px-3 border-b border-sol-border/40 whitespace-nowrap">{c.label}</th>)}
            <th className="text-right font-normal py-2 pl-3 border-b border-sol-border/40 whitespace-nowrap" title="Finders the project's line profile declares, and how many filed nothing in 24 hours">Finders</th>
          </tr>
        </thead>
        <tbody>
          {rollup.map((r) => (
            <tr key={r.key} onClick={() => onSelect(r.key)} className="line-row cursor-pointer" data-line-rollup-row={r.key}>
              <td className="py-2.5 pr-4 border-b border-sol-border/20">
                <div className={cn("text-sol-text", r.key === NO_PROJECT && "italic text-sol-text-muted")}>{r.title}</div>
                {r.short_id && <div className="mt-0.5 font-mono text-[11px] text-sol-text-dim whitespace-nowrap">{r.short_id}</div>}
              </td>
              {COLS.map((c) => <Cell key={c.key} value={r[c.key] as number} ask={c.key === "awaiting"} />)}
              <td className="py-2.5 pl-3 border-b border-sol-border/20 text-right tabular-nums whitespace-nowrap text-[11px]">
                {/* What files here without a declaration reads as itself, so a busy source never shows as "none" (LX7). */}
                {r.finders > 0 && <><span className="text-sol-text-muted">{r.finders}</span>{r.silent > 0 && <span className="text-sol-orange">, {r.silent} silent</span>}</>}
                {r.undeclared.length > 0 && (
                  <span className="text-sol-text-dim" title={`${r.undeclared.join(", ")} filed signals this week without a finder in the project's line profile. Declare one from the source's node on the map.`} data-line-rollup-undeclared>
                    {r.finders > 0 && <span> · </span>}{r.undeclared.slice(0, 2).join(", ")}{r.undeclared.length > 2 && ` +${r.undeclared.length - 2}`}
                    <span className="opacity-60">, not declared</span>
                  </span>
                )}
                {r.finders === 0 && r.undeclared.length === 0 && <span className="text-sol-text-dim opacity-60" title="No finders declared: cast line profile --publish in the project's repo">none</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-sol-text-muted">
            <td className="pt-2.5 pr-4 text-[11px] text-sol-text-dim">{rollup.length} line{rollup.length === 1 ? "" : "s"}</td>
            {COLS.map((c) => <Cell key={c.key} value={sum(c.key)} ask={c.key === "awaiting"} foot />)}
            <td className="pt-2.5 pl-3 text-right tabular-nums text-[11px] text-sol-text-dim">{findersTotal}{silentTotal > 0 && <span className="text-sol-orange">, {silentTotal} silent</span>}</td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}

function Cell({ value, ask, foot }: { value: number; ask?: boolean; foot?: boolean }) {
  return (
    <td className={cn("px-3 text-right tabular-nums line-num", foot ? "pt-2.5" : "py-2.5 border-b border-sol-border/20")}>
      <span className={cn(value === 0 ? "text-sol-text-dim opacity-50" : ask ? "text-sol-yellow" : foot ? "text-sol-text-muted" : "text-sol-text")}>{value}</span>
    </td>
  );
}
