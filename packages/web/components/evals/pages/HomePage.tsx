// The wall, connected: reads GET /overview for the chosen cadence and hands
// it to SurfaceWallView. While a batch is still landing or a bisect runs it
// follows GET /changes and reloads when something moves.

import { useCallback } from "react";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { useEvalsHost } from "../host";
import { SurfaceWallView } from "../SurfaceWallView";
import { isBisectLive } from "../bisectModel";
import { DEFAULT_WALL_CADENCE } from "../wallModel";

export function HomePage({ view }: { view: Extract<EvalsView, { view: "home" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const navigate = host.useNavigate();
  const active = host.useActive();
  const now = host.useNow(60_000);
  const cadence = view.cadence ?? DEFAULT_WALL_CADENCE;
  const overview = useEvalsResource("GET /overview", { query: { cadence } });
  const data = overview.data;
  const live = !!data && (data.surfaces.some((s) => s.landing) || data.bisects.some((b) => isBisectLive(b.status)));
  const reload = overview.reload;
  useEvalsChanges(live, useCallback(() => reload(), [reload]));
  const open = useCallback((href: string) => navigate(href), [navigate]);
  const setCadence = useCallback((c: string) => navigate(evalsHref.home({ cadence: c === DEFAULT_WALL_CADENCE ? null : c })), [navigate]);

  if (!data) {
    if (overview.error) {
      return (
        <div data-evals-page="home" className="ev-stack">
          <EmptyState title="The wall could not be read" description={overview.error} />
          <button type="button" className="ev-chip" onClick={reload}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div data-evals-page="home" className="ev-note ev-note--center" data-evals-loading>
        Reading every surface's last 30 days...
      </div>
    );
  }
  return (
    <div data-evals-page="home">
      <SurfaceWallView data={data} now={now} cadence={cadence} onCadence={setCadence} onOpen={open} active={active} />
    </div>
  );
}
