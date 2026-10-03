// One bisect, connected: GET /bisect/:id, refreshed through GET /changes
// while it runs (paused when the tab is hidden), and POST /bisect/:id/stop,
// which writes the stop file the runner checks between reps.

import { useState } from "react";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useEvalsStore } from "../../../store/evalsStore";
import { EmptyState } from "../../EmptyState";
import { BisectView } from "../BisectView";
import { isBisectLive } from "../bisectModel";
import { evalsHref, type EvalsView } from "../evalsPaths";

export function BisectPage({ view }: { view: Extract<EvalsView, { view: "bisect" }> }) {
  const res = useEvalsResource("GET /bisect/:id", { params: { id: view.id } });
  const now = useCoarseNow(15_000);
  const [stopping, setStopping] = useState(false);
  const live = !!res.data && isBisectLive(res.data.state.status);
  useEvalsChanges(live, (c) => {
    if (c.bisects.some((b) => b.id === view.id)) res.reload();
  });
  const stop = async () => {
    setStopping(true);
    try {
      await useEvalsStore.getState().call("POST /bisect/:id/stop", { params: { id: view.id } });
    } finally {
      res.reload();
    }
  };
  return (
    <div data-evals-page="bisect">
      {res.data ? (
        <BisectView data={res.data} steps={res.data.steps} now={now} onStop={() => void stop()} stopping={stopping && live} />
      ) : res.status === 404 ? (
        <EmptyState title="No bisect with this id" description={`${view.id} is not in EVALS_HOME/bisects on this machine.`} action={{ label: "All bisects", href: evalsHref.bisectList() }} />
      ) : res.error ? (
        <EmptyState title="This bisect could not be read" description={res.error} />
      ) : (
        <div className="ev-page text-[12px] ev-quiet" data-evals-loading>
          Reading the bisect...
        </div>
      )}
    </div>
  );
}
