// What the Multiplayer sim pages decide (evals-ui.md 4.6, 4.7): one
// session's outcome for the wall and the catalog alike, the grid's rows and
// markers, and the order chips. Pure, beside the sim views.

import type { SimSessionSummary, SimCatalogResponse, SimGridCell, SimMarker, SimMode, SimScenario } from "@codecast/shared/contracts/evalsApi";
import type { VerdictState } from "@platform/evals/client";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { parseChannel } from "./simLanes";

/** A session that exited non-zero with no failed run broke before or around its runs (a filter that matched nothing, a load error). */
export const simExitedBad = (sim: SimSessionSummary) => !sim.unsessioned && sim.finishedAt != null && sim.exit != null && sim.exit !== 0;

/**
 * A session with no `finishedAt`: still running, or killed before it could
 * write one. Nothing on disk tells the two apart, so the words say both.
 */
export const simSessionOpen = (sim: SimSessionSummary) => !sim.unsessioned && sim.finishedAt == null;
export const SIM_OPEN_WORDS = "running or cut short";

/**
 * One session's outcome, read the same way by the wall's sim line and the
 * catalog's session table: its glyph, its words, and whether it reads bad.
 * An open session has no verdict yet, so it never shows a pass.
 */
export function simOutcome(sim: SimSessionSummary): { state: VerdictState; words: string; bad: boolean } {
  if (sim.failed) return { state: "fail", words: `${sim.failed} failed`, bad: true };
  if (simExitedBad(sim)) return { state: "crash", words: sim.runs ? `none failed, but it exited ${sim.exit}` : `exited ${sim.exit} before any run`, bad: true };
  if (simSessionOpen(sim)) return { state: "unscored", words: sim.runs ? `${SIM_OPEN_WORDS}, none failed so far` : SIM_OPEN_WORDS, bad: false };
  return { state: sim.runs ? "pass" : "unscored", words: "none failed", bad: false };
}

const MODE_ORDER: SimMode[] = ["scripted", "interleave", "order"];

export interface GridRow {
  name: string;
  scenario: SimScenario | null;
  cells: Map<string, SimGridCell>;
  gitHead: string | null;
  lastRunAt: string | null;
}

/** Rows are the catalog's scenarios (selftests last), plus any scenario the history still holds runs of. */
export function gridRows(catalog: SimCatalogResponse): { rows: GridRow[]; modes: SimMode[] } {
  const byScenario = new Map<string, SimGridCell[]>();
  for (const c of catalog.grid) byScenario.set(c.scenario, [...(byScenario.get(c.scenario) ?? []), c]);
  const modes = new Set<string>();
  for (const s of catalog.scenarios) for (const m of s.modes) modes.add(m);
  for (const c of catalog.grid) if (c.latest) modes.add(c.mode);
  const named = [...catalog.scenarios].sort((a, b) => Number(a.selftest) - Number(b.selftest));
  const rows: GridRow[] = named.map((s) => row(s.name, s, byScenario.get(s.name) ?? []));
  for (const [name, cells] of byScenario) if (!catalog.scenarios.some((s) => s.name === name) && cells.some((c) => c.history.length)) rows.push(row(name, null, cells));
  return { rows, modes: MODE_ORDER.filter((m) => modes.has(m)) };
}

function row(name: string, scenario: SimScenario | null, cells: SimGridCell[]): GridRow {
  const newest = [...cells].filter((c) => c.lastRunAt).sort((a, b) => (b.lastRunAt! < a.lastRunAt! ? -1 : 1))[0];
  return { name, scenario, cells: new Map(cells.map((c) => [c.mode, c])), gitHead: newest?.gitHead ?? null, lastRunAt: newest?.lastRunAt ?? null };
}

/** The red and known markers that apply to one cell: red names its modes (null is every mode); known applies to all. */
export function markersFor(scenario: SimScenario | null, mode: string): Array<{ task: string; invariant: string; kind: "red" | "known" }> {
  if (!scenario) return [];
  const red = scenario.red.filter((m: SimMarker) => !m.modes || m.modes.includes(mode)).map((m) => ({ task: m.task, invariant: m.invariant, kind: "red" as const }));
  const known = scenario.known.flatMap((k) => k.tasks.map((task) => ({ task, invariant: k.invariant, kind: "known" as const })));
  return [...red, ...known];
}

/**
 * The failing run a cell opens: its newest failure with artifacts, else its
 * latest run when that failed and left a folder (a child that predates
 * `newestFailure` still links). The invariant is null when only `latest` is known.
 */
export function cellFailure(cell: SimGridCell): { session: string; run: string; seed: number; invariant: string | null } | null {
  if (cell.newestFailure) return cell.newestFailure;
  const l = cell.latest;
  return l && !l.passed && l.run ? { session: l.session, run: l.run, seed: l.seed, invariant: null } : null;
}

/** Whether a row belongs under an invariant filter: a cell's newest failure broke it, or a marker names it. */
export function rowTouches(r: GridRow, invariant: string): boolean {
  for (const c of r.cells.values()) if (cellFailure(c)?.invariant === invariant) return true;
  return !!r.scenario && [...r.scenario.red.map((m) => m.invariant), ...r.scenario.known.map((k) => k.invariant)].includes(invariant);
}

/** "3h ago", or "just now" under a minute. */
export function ago(iso: string, now: number): string {
  const t = formatTimeAgo(Date.parse(iso), now);
  return t === "now" ? "just now" : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
}

/** "Play" steps the deliveries this far apart (section 6, motion). */
export const PLAY_STEP_MS = 60;

/** A channel in a few characters: `conn laptop-host`, `live laptop-host/inbox`, `repl a > b`. */
export function chipText(channel: string): string {
  const p = parseChannel(channel);
  switch (p.kind) {
    case "conn":
      return `conn ${p.window}`;
    case "live":
      return `live ${p.window}/${p.feed}`;
    case "repl":
      return `repl ${p.from} > ${p.to}`;
    case "bridge":
      return `bridge ${p.device}${p.from ? `/${p.from}` : ""}`;
    case "timer":
      return `timer ${p.owner}`;
    case "sched":
      return "sched";
    case "actor":
      return `actor ${p.name}`;
    default:
      return p.raw;
  }
}
