// The timeline tab's words, inks and sizes, and its list keys (j/k, Enter).
import { useRef } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { externalEventStyle } from "../../lib/externalEvents";
import { isEditableTarget } from "../../shortcuts";
import { KIND_LOOK } from "./parts";
import { STACK_INK, STREAM_BUCKET_REACH } from "./timelineModel";

export const HOUR = 3600_000;
/** A window's length as a person reads it: a preset by its own key (6h, 72h, 30d), a held window to the hour or minute (2d 13h, 5h 20m, 45m). */
export const spanText = (ms: number, preset?: string | null) => {
  if (preset) return preset;
  const m = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d >= 7) return `${Math.round(ms / (24 * HOUR))}d`;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m % 60 && h < 6 ? `${h}h ${m % 60}m` : `${Math.round(m / 60)}h`;
  return `${m}m`;
};
/** Raw occurrences are kept per hour for this long (GROUP_RULES.bucket_hours). */
export const BUCKET_REACH = STREAM_BUCKET_REACH;
/** The lane for rows whose source is gone or unnamed: the Source facet's own word for them. */
export const NO_SOURCE_LANE = "no source";

/** The lanes' name column: wide enough for the longest name and its count (icon, gaps and padding included), 140 to 190px. */
export function laneGutter(sources: readonly string[]): number {
  if (!sources.length) return 140;
  const counts = new Map<string, number>();
  for (const s of sources) counts.set(s, (counts.get(s) ?? 0) + 1);
  const widest = Math.max(...[...counts].map(([name, n]) => name.length * 7.2 + n.toLocaleString().length * 6.6));
  return Math.round(Math.min(190, Math.max(140, widest + 58)));
}

/** Rows painted before the next screenful is asked for. */
export const PAGE_ROWS = 100;
/** A mark's pill is this wide; marks nearer merge. */
export const PILL_PX = 22;

const STATUS_WORD: Record<string, string> = {
  new: "new",
  regressed: "regressed",
  spike: "spiked",
  resolved: "resolved",
  check_failed: "check failed",
  check_recovered: "recovered",
  job_failed: "job failed",
  metric_alert: "alerting",
  metric_recovered: "recovered",
  deploy: "deployed",
};
export const statusWord = (s: string | null) => (s ? STATUS_WORD[s] ?? externalEventStyle(s).verb ?? s : "");
export const statusInk = (s: string | null) => (s && STACK_INK[s]) || "var(--sol-text-muted)";
export const kindLabel = (k: string) => (k === "deploy" ? "deploy" : KIND_LOOK[k as keyof typeof KIND_LOOK]?.label ?? k);

/** An axis tick: a date past three days, else a clock time; on a dated window (windowDated) the first tick and each midnight carry the day. */
export const tickLabel = (at: number, span: number, dayAt = false) => {
  const day = new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  if (span > 3 * 86_400_000) return day;
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: span <= 6 * HOUR ? "2-digit" : undefined });
  if (!dayAt) return time;
  const d = new Date(at);
  return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${day} ${time}`;
};
/**
 * j/k (or the arrows) move a cursor through the rows, Enter opens the row
 * under it, and while a row is open the panel follows the cursor. Typing in a
 * field never moves it.
 */
export function useListKeys(ids: readonly string[], cursor: string | null, setCursor: (id: string | null) => void, open: string | null, setOpen: (id: string | null) => void) {
  const state = useRef({ ids, cursor, open });
  state.current = { ids, cursor, open };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      const { ids: list, cursor: at, open: opened } = state.current;
      if (!list.length) return;
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (down || up) {
        const i = list.indexOf(at ?? opened ?? "");
        const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
        e.preventDefault();
        setCursor(next);
        if (opened) setOpen(next);
        const el = document.querySelector<HTMLElement>(`[data-ops-row="${CSS.escape(next)}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && at && list.includes(at) && !(e.target as Element | null)?.closest?.("a, button, [data-ops-row]")) {
        e.preventDefault();
        setOpen(opened === at ? null : at);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
