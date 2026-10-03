// /evals/s/:surface, connected: reads GET /surface/:id for the filters, GET
// /batches for a pinned pair and GET /epoch for the open epoch, keeps the pins
// in the URL, and follows GET /changes while a batch is still landing. The
// view (SurfaceView) is props only.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SurfaceResponse } from "@codecast/shared/contracts/evalsApi";
import { EmptyState } from "../../EmptyState";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useTabActive } from "../../../hooks/usePagePresence";
import { DEFAULT_SURFACE_FILTERS, SurfaceView, orderedPair, type SurfaceFilters } from "../SurfaceView";
import { surfaceColumns } from "../Seismograph";
import { evalsHref, type EvalsView } from "../evalsPaths";

/** A batch whose newest rep landed this recently is still landing: follow /changes for it. */
const LANDING_MS = 15 * 60_000;

export function SurfacePage({ view }: { view: Extract<EvalsView, { view: "surface" }> }) {
  const router = useRouter();
  const keysActive = useTabActive();
  const [filters, setFilters] = useState<SurfaceFilters>(DEFAULT_SURFACE_FILTERS);
  const [epochN, setEpochN] = useState<number | null>(null);

  const query = { cadence: filters.cadence, model: filters.model ?? undefined, dry: filters.dry || undefined, bisect: filters.bisect || undefined };
  const surface = useEvalsResource("GET /surface/:id", { params: { id: view.surface }, query });
  // A new filter is a new request: the last answer stays on screen until it lands.
  const last = useRef<{ id: string; data: SurfaceResponse } | null>(null);
  if (surface.data) last.current = { id: view.surface, data: surface.data };
  const data = surface.data ?? (last.current?.id === view.surface ? last.current.data : null);

  // Every model seen on this surface, so filtering to one keeps the others on the toggle.
  const seenModels = useRef<{ id: string; models: string[] }>({ id: view.surface, models: [] });
  if (seenModels.current.id !== view.surface) seenModels.current = { id: view.surface, models: [] };
  for (const r of data?.runs ?? []) if (r.model && !seenModels.current.models.includes(r.model)) seenModels.current.models.push(r.model);
  const models = seenModels.current.models;

  const byBatch = useMemo(() => (data ? surfaceColumns(data.batches, "ordinal", 1000).byBatch : null), [data]);
  const pair = byBatch && view.batch && view.compare && byBatch.has(view.batch) && byBatch.has(view.compare) ? orderedPair(byBatch, view.batch, view.compare) : null;
  const batches = useEvalsResource("GET /batches", pair ? { query: { surface: view.surface, a: pair[0], b: pair[1] } } : null);
  const epoch = useEvalsResource("GET /epoch", epochN !== null ? { query: { surface: view.surface, n: epochN } } : null);

  const newest = data?.runs.reduce((m, r) => Math.max(m, Date.parse(r.stamp)), 0) ?? 0;
  const reload = surface.reload;
  useEvalsChanges(
    newest > 0 && Date.now() - newest < LANDING_MS,
    useCallback((c) => void (c.runs.some((r) => r.surface === view.surface) && reload()), [reload, view.surface]),
  );

  const onPins = useCallback(
    (pinned: string | null, compare: string | null) => router.replace(evalsHref.surface(view.surface, { batch: pinned, compare })),
    [router, view.surface],
  );

  if (!data) {
    if (surface.status === 404) {
      return <EmptyState title={`No surface named ${view.surface}`} description="The wall lists every surface this checkout's registry knows." action={{ label: "Open the wall", href: evalsHref.home() }} />;
    }
    if (surface.error) return <EmptyState title="This surface did not load" description={surface.error} />;
    return (
      <div className="h-full flex items-center justify-center text-[12px] ev-quiet" data-evals-loading>
        Reading {view.surface}'s runs...
      </div>
    );
  }

  return (
    <SurfaceView
      data={data}
      models={models}
      filters={filters}
      onFilters={setFilters}
      pinned={view.batch}
      compare={view.compare}
      onPins={onPins}
      batches={{ res: batches.data, loading: !!pair && batches.loading, error: batches.error }}
      epoch={{ n: epochN, res: epoch.data, loading: epochN !== null && epoch.loading, error: epoch.error }}
      onEpoch={setEpochN}
      onNavigate={(href) => router.push(href)}
      keysActive={keysActive}
      refreshing={!surface.data}
    />
  );
}
