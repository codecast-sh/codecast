// The wall, connected: reads GET /overview for the chosen cadence and hands
// it to SurfaceWallView. While a batch is still landing or a bisect runs it
// follows GET /changes and reloads when something moves.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "../../EmptyState";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useTabActive } from "../../../hooks/usePagePresence";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { DEFAULT_WALL_CADENCE, SurfaceWallView } from "../SurfaceWallView";
import { isBisectLive } from "../bisectModel";

export function HomePage({ view }: { view: Extract<EvalsView, { view: "home" }> }) {
  const router = useRouter();
  const active = useTabActive();
  const now = useCoarseNow(60_000);
  const cadence = view.cadence ?? DEFAULT_WALL_CADENCE;
  const overview = useEvalsResource("GET /overview", { query: { cadence } });
  const data = overview.data;
  const live = !!data && (data.surfaces.some((s) => s.landing) || data.bisects.some((b) => isBisectLive(b.status)));
  const reload = overview.reload;
  useEvalsChanges(live, useCallback(() => reload(), [reload]));
  const open = useCallback((href: string) => router.push(href), [router]);
  const setCadence = useCallback((c: string) => router.push(evalsHref.home({ cadence: c === DEFAULT_WALL_CADENCE ? null : c })), [router]);

  if (!data) {
    if (overview.error) {
      return (
        <div data-evals-page="home" className="flex flex-col items-center">
          <EmptyState title="The wall could not be read" description={overview.error} />
          <button type="button" className="ev-chip" onClick={reload}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div data-evals-page="home" className="h-full flex items-center justify-center text-[12px] ev-quiet" data-evals-loading>
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
