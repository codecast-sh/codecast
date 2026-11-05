// Shared fixtures for the metric model tests.
import type { OpsWatch } from "./opsTypes";

export const H = 3600_000;
export const D = 24 * H;
export const NOW = 1_800_000_000_000;

export function watch(over: Partial<OpsWatch> = {}): OpsWatch {
  const points = over.points ?? [{ at: NOW - H, value: 5 }];
  const last = points[points.length - 1];
  return {
    _id: over.short_id ?? "w", workspace: "team:t", source_id: "s", short_id: "mw-1", name: "W", query_kind: "hogql", query: "select 1",
    direction: "above", interval_ms: H, status: "active", state: "ok", last_value: last?.value ?? null, last_at: last?.at ?? null,
    source_name: "union-posthog", source_short_id: "src-1", updated_at: NOW, points, ...over,
  } as OpsWatch;
}
