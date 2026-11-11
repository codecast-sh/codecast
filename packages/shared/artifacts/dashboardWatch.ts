// A dashboard that keeps working while nobody has it open: a refresh
// schedule on its layout element, and alerts on its KPIs. Both live on the
// dashboard's own elements (one home); the server mirrors them onto the rows
// it schedules (dataQueries.wantCore) and checks each alert after every read.
import type { ArtifactElement, Json } from "./core";
import { evaluateKpi, formatValue, type DataResult, type KpiBlock, type NumberFormat } from "./dashboardData";

export const SCHEDULES = { hourly: 3_600_000, daily: 86_400_000 } as const;
export type Schedule = keyof typeof SCHEDULES;

/** The layout's refresh schedule, or null when the dashboard reads only while open. */
export function readSchedule(layout: object | undefined): Schedule | null {
  const r = (layout as { refresh?: unknown } | undefined)?.refresh;
  return r === "hourly" || r === "daily" ? r : null;
}

/** A KPI's alert: notify when its value goes above or below a line. `by` is who set it, and who hears it. */
export type KpiAlert = { above?: number; below?: number; by?: string };

export function readAlert(block: object): KpiAlert | null {
  const a = (block as { alert?: unknown }).alert as Record<string, Json> | undefined;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const above = typeof a.above === "number" && Number.isFinite(a.above) ? a.above : undefined;
  const below = typeof a.below === "number" && Number.isFinite(a.below) ? a.below : undefined;
  if (above === undefined && below === undefined) return null;
  return { ...(above !== undefined ? { above } : {}), ...(below !== undefined ? { below } : {}), ...(typeof a.by === "string" ? { by: a.by } : {}) };
}

export type AlertState = "above" | "below" | "ok";

/** Where a KPI's current value sits against its alert lines; null when it has no alert or no number to judge. */
export function alertState(block: ArtifactElement, result: DataResult | undefined): { state: AlertState; value: number; display: string } | null {
  const alert = readAlert(block);
  if (!alert) return null;
  const ev = evaluateKpi(block as KpiBlock, result);
  if (ev.state !== "ok" || typeof ev.value !== "number") return null;
  const state: AlertState = alert.above !== undefined && ev.value > alert.above ? "above" : alert.below !== undefined && ev.value < alert.below ? "below" : "ok";
  return { state, value: ev.value, display: ev.display };
}

/** The line a crossing or recovery reads as: "Agent spend is $25.1K, above $20K". */
export function alertLine(block: ArtifactElement, s: { state: AlertState; display: string }, docTitle: string): string {
  const alert = readAlert(block)!;
  const fmt = (block.format as NumberFormat | undefined) ?? "number";
  const name = String(block.title || "A KPI");
  if (s.state === "ok") return `${name} is back at ${s.display} on ${docTitle}`;
  const line = s.state === "above" ? alert.above! : alert.below!;
  return `${name} is ${s.display}, ${s.state} ${formatValue(line, fmt)} on ${docTitle}`;
}
