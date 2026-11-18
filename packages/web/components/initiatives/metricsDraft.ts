// The numbers editor's draft rows (MetricsEditor.tsx) and the metrics a save
// writes from them: pure, so the component module exports components only.
import { metricKeyOf, type InitiativeMetric } from "@codecast/shared/contracts/initiative";

/** `window` and `noise` ride along untouched: an edit here never drops how a number is read. */
export type Draft = { name: string; target: string; series: string; guardrail: boolean; window?: string; noise?: string };
export const EMPTY_DRAFT: Draft = { name: "", target: "", series: "", guardrail: false };
export const draftOf = (metrics: readonly InitiativeMetric[]): Draft[] =>
  metrics.length ? metrics.map((m) => ({ name: m.name, target: m.target, series: m.series ?? "", guardrail: !!m.guardrail, ...(m.window ? { window: m.window } : {}), ...(m.noise ? { noise: m.noise } : {}) })) : [EMPTY_DRAFT];

/** The drafts as the metrics a write takes: rows missing a name or a target are dropped. */
export function metricsOfDraft(draft: readonly Draft[]): InitiativeMetric[] {
  return draft
    .map((m) => ({ ...m, name: m.name.trim(), target: m.target.trim() }))
    .filter((m) => m.name && m.target)
    .map((m) => ({ key: metricKeyOf(m.name), name: m.name, target: m.target, ...(m.series ? { series: m.series } : {}), ...(m.guardrail ? { guardrail: true } : {}), ...(m.window ? { window: m.window } : {}), ...(m.noise ? { noise: m.noise } : {}) }));
}
