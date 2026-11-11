// Checking a dashboard's words against its data: resolving the KPIs a text
// names, and finding story words (headline, summary, story lines) that
// contradict the numbers or trace to nothing.
import { evaluateKpi, type CheckContext, type DataResult, type KpiBlock, type Where } from "./dashboardData";
import { textProblems, type TextProblem } from "./dashboardWords";

/** A KPI lookup for text checks: evaluate the referenced block over its own result, under the dashboard's filter. */
export function kpiResolver(get: (key: string) => Record<string, unknown> | undefined, resultOf: (block: Record<string, unknown>) => DataResult | undefined, scope?: Where): NonNullable<CheckContext["kpi"]> {
  return (key) => {
    const b = get(key);
    if (!b || b.kind !== "kpi") return undefined;
    return { title: typeof b.title === "string" ? b.title : undefined, ev: evaluateKpi(b as KpiBlock, resultOf(b), scope) };
  };
}

/** Story words that disagree with the data or trace to nothing: the headline, the summary, and each block's story title and line. */
export function storyProblems(layout: Record<string, unknown> | undefined, blocks: readonly Record<string, unknown>[], kpi: NonNullable<CheckContext["kpi"]>): Array<{ key: string; field: string } & TextProblem> {
  const out: Array<{ key: string; field: string } & TextProblem> = [];
  const look = (key: string, field: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) for (const p of textProblems(v, kpi)) out.push({ key, field, ...p });
  };
  look("layout", "headline", layout?.headline);
  look("layout", "summary", layout?.summary);
  for (const b of blocks) {
    look(String(b.key), "say_title", b.say_title);
    look(String(b.key), "say", b.say);
  }
  return out;
}
