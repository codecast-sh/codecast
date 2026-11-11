import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { resultFor } from "../../hooks/useDashboardData";
import type { BlockEnv } from "./blocks";

/** The KPIs a text or story line names, evaluated as the page shows them (under the dashboard's filter). */
export function envKpis(env: BlockEnv): NonNullable<dashboard.CheckContext["kpi"]> {
  return dashboard.kpiResolver((k) => env.blocks.get(k), (b) => resultFor(env.results, b), env.scope);
}

/** The check behind a block: whether its number is fresh, verified, broken or pending, and whether its words agree with the data. */
export function blockCheck(b: ArtifactElement, env: BlockEnv): dashboard.Check | null {
  return dashboard.checkBlock(b.kind, b, resultFor(env.results, b), env.now, { scope: env.scope, kpi: envKpis(env) });
}
