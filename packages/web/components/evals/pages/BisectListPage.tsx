// Past and running bisects, connected: GET /bisects, refreshed through
// GET /changes while any of them is still running.

import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { EmptyState } from "../../EmptyState";
import { BisectListView } from "../BisectListView";
import { isBisectLive } from "../bisectModel";
import type { EvalsView } from "../evalsPaths";

export function BisectListPage(_props: { view: Extract<EvalsView, { view: "bisect-list" }> }) {
  const res = useEvalsResource("GET /bisects", {});
  const now = useCoarseNow(30_000);
  const live = !!res.data?.bisects.some((b) => isBisectLive(b.status));
  useEvalsChanges(live, (c) => {
    if (c.bisects.length) res.reload();
  });
  return (
    <div data-evals-page="bisect-list">
      {res.data ? (
        <BisectListView bisects={res.data.bisects} now={now} />
      ) : res.error ? (
        <EmptyState title="The bisects could not be read" description={res.error} />
      ) : (
        <div className="ev-page text-[12px] ev-quiet" data-evals-loading>
          Reading the bisects...
        </div>
      )}
    </div>
  );
}
