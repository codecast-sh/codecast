// The numbers editor's draft rows (MetricsEditor.tsx) and the metrics a save
// writes from them: pure, so the component module exports components only.
import { metricKeyOf, type InitiativeMetric } from "@codecast/shared/contracts/initiative";

export type Draft = { name: string; target: string; series: string; guardrail: boolean };
export const draftOf = (metrics: readonly InitiativeMetric[]): Draft[] =>
  metrics.length ? metrics.map((m) => ({ name: m.name, target: m.target, series: m.series ?? "", guardrail: !!m.guardrail })) : [{ name: "", target: "", series: "", guardrail: false }];

/** The drafts as the metrics a write takes: rows missing a name or a target are dropped. */
export function metricsOfDraft(draft: readonly Draft[]): InitiativeMetric[] {
  return draft
    .map((m) => ({ name: m.name.trim(), target: m.target.trim(), series: m.series, guardrail: m.guardrail }))
    .filter((m) => m.name && m.target)
    .map((m) => ({ key: metricKeyOf(m.name), name: m.name, target: m.target, ...(m.series ? { series: m.series } : {}), ...(m.guardrail ? { guardrail: true } : {}) }));
}
