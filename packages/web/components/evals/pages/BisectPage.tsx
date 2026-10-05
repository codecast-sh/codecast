// One bisect, connected: GET /bisect/:id, refreshed through GET /changes
// while it runs (paused when the tab is hidden), and POST /bisect/:id/stop,
// which writes the stop file the runner checks between reps. An id stamped a
// moment ago that the api does not know yet is a start still on its way, so
// the page keeps asking for it rather than saying there is no such bisect.

import { useEffect, useState } from "react";
import { useTabVisible } from "../../../hooks/usePagePresence";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { EVALS_POLL_MS, useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useEvalsStore } from "../../../store/evalsStore";
import { EmptyState } from "../../EmptyState";
import { BisectView } from "../BisectView";
import { isBisectLive, isJustStarted } from "../bisectModel";
import { evalsHref, type EvalsView } from "../evalsPaths";

export function BisectPage({ view }: { view: Extract<EvalsView, { view: "bisect" }> }) {
  const res = useEvalsResource("GET /bisect/:id", { params: { id: view.id } });
  const now = useCoarseNow(15_000);
  const [stopping, setStopping] = useState(false);
  const visible = useTabVisible();
  const live = !!res.data && isBisectLive(res.data.state.status);
  const waiting = !res.data && res.status === 404 && isJustStarted(view.id, Date.now());
  useEvalsChanges(live, (c) => {
    if (c.bisects.some((b) => b.id === view.id)) res.reload();
  });
  const { reload } = res;
  useEffect(() => {
    if (!waiting || !visible) return;
    const t = setInterval(reload, EVALS_POLL_MS);
    return () => clearInterval(t);
  }, [waiting, visible, reload]);
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
      ) : waiting ? (
        <div className="ev-page text-[12px] ev-quiet" data-evals-loading="starting">
          Starting the bisect: its runner is loading the records...
        </div>
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
