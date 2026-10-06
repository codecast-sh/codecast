// /evals/s/:surface, connected: reads GET /surface/:id for the filters, GET
// /batches for a pinned pair and GET /epoch for the open epoch, keeps the pins
// in the URL, and follows GET /changes while a batch is still landing. The
// view (SurfaceView) is props only.

import { useCallback, useMemo, useRef, useState } from "react";
import { DEFAULT_SURFACE_FILTERS, orderedPair, surfaceColumns, type EvalsView, type SurfaceFilters } from "../../client";
import { resolveEvalsBatchRef, type SurfaceResponse } from "../../contract";
import { useEvalsHost, useEvalsLive, useEvalsPaths, useEvalsResource } from "../hooks";
import { SurfaceView } from "./SurfaceView";

/** A batch whose newest rep landed this recently is still landing: follow /changes for it. */
const LANDING_MS = 15 * 60_000;

export function SurfacePage({ view }: { view: Extract<EvalsView, { view: "surface" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const navigate = host.useNavigate();
  const { href: evalsHref } = useEvalsPaths();
  const keysActive = host.useActive();
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
  // The address names a labelled batch by its hash (evalsBatchRef); the surface's own batches say which one.
  const named = (ref: string | null) => (ref && byBatch ? resolveEvalsBatchRef(ref, byBatch.keys()) : ref);
  const pinned = named(view.batch);
  const compare = named(view.compare);
  const pair = byBatch && pinned && compare && byBatch.has(pinned) && byBatch.has(compare) ? orderedPair(byBatch, pinned, compare) : null;
  const batches = useEvalsResource("GET /batches", pair ? { query: { surface: view.surface, a: pair[0], b: pair[1] } } : null);
  const epoch = useEvalsResource("GET /epoch", epochN !== null ? { query: { surface: view.surface, n: epochN } } : null);

  const newest = data?.runs.reduce((m, r) => Math.max(m, Date.parse(r.stamp)), 0) ?? 0;
  const reload = surface.reload;
  useEvalsLive(newest > 0 && Date.now() - newest < LANDING_MS, reload, (c) => c.runs.some((r) => r.surface === view.surface));

  const onPins = useCallback(
    (pinned: string | null, compare: string | null) => navigate(evalsHref.surface(view.surface, { batch: pinned, compare }), { replace: true }),
    [navigate, evalsHref, view.surface],
  );

  if (!data) {
    if (surface.status === 404) {
      return <EmptyState title={`No surface named ${view.surface}`} description={host.words.unknownSurface} action={{ label: "Open the wall", href: evalsHref.home() }} />;
    }
    if (surface.error) return <EmptyState title="This surface did not load" description={surface.error} />;
    return (
      <div className="ev-note ev-note--center" data-evals-loading>
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
      pinned={pinned}
      compare={compare}
      onPins={onPins}
      batches={{ res: batches.data, loading: !!pair && batches.loading, error: batches.error }}
      epoch={{ n: epochN, res: epoch.data, loading: epochN !== null && epoch.loading, error: epoch.error }}
      onEpoch={setEpochN}
      onNavigate={navigate}
      keysActive={keysActive}
      refreshing={!surface.data}
    />
  );
}
