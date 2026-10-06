// Past and running bisects, connected: GET /bisects, refreshed through
// GET /changes while any of them is still running.

import { isBisectLive, type EvalsView } from "../../../client";
import { useEvalsChanges, useEvalsHost, useEvalsResource } from "../../hooks";
import { BisectListView } from "../BisectListView";

export function BisectListPage(_props: { view: Extract<EvalsView, { view: "bisect-list" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const res = useEvalsResource("GET /bisects", {});
  const now = host.useNow(30_000);
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
        <div className="ev-page ev-note" data-evals-loading>
          Reading the bisects...
        </div>
      )}
    </div>
  );
}
