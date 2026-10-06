// One bisect, connected: GET /bisect/:id, refreshed through GET /changes
// while it runs (paused when the tab is hidden), and the host's stop action
// (codecast: POST /bisect/:id/stop, which writes the stop file the runner
// checks between reps); a host without one draws the bisect read-only. An id stamped a
// moment ago that the api does not know yet is a start still on its way, so
// the page keeps asking for it rather than saying there is no such bisect.

import { useEffect, useState } from "react";
import { EVALS_POLL, isBisectLive, isJustStarted, type EvalsView } from "../../../client";
import { useEvalsChanges, useEvalsHost, useEvalsPaths, useEvalsResource } from "../../hooks";
import type { BisectActions } from "../../host";
import { BisectView } from "../BisectView";

const noActions = (): BisectActions | null => null;

export function BisectPage({ view }: { view: Extract<EvalsView, { view: "bisect" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const href = useEvalsPaths().href;
  const actions = (host.useBisectActions ?? noActions)();
  const res = useEvalsResource("GET /bisect/:id", { params: { id: view.id } });
  const now = host.useNow(15_000);
  const [stopping, setStopping] = useState(false);
  const visible = host.useVisible();
  const live = !!res.data && isBisectLive(res.data.state.status);
  const waiting = !res.data && res.status === 404 && isJustStarted(view.id, Date.now());
  useEvalsChanges(live, (c) => {
    if (c.bisects.some((b) => b.id === view.id)) res.reload();
  });
  const { reload } = res;
  useEffect(() => {
    if (!waiting || !visible) return;
    const t = setInterval(reload, EVALS_POLL.intervalMs);
    return () => clearInterval(t);
  }, [waiting, visible, reload]);
  const stop = async (act: BisectActions) => {
    setStopping(true);
    try {
      await act.stop(view.id);
    } finally {
      res.reload();
    }
  };
  return (
    <div data-evals-page="bisect">
      {res.data ? (
        <BisectView data={res.data} steps={res.data.steps} now={now} onStop={actions ? () => void stop(actions) : undefined} stopping={stopping && live} />
      ) : waiting ? (
        <div className="ev-page ev-note" data-evals-loading="starting">
          Starting the bisect: its runner is loading the records...
        </div>
      ) : res.status === 404 ? (
        <EmptyState title="No bisect with this id" description={`${view.id} is not in EVALS_HOME/bisects on this machine.`} action={{ label: "All bisects", href: href.bisectList() }} />
      ) : res.error ? (
        <EmptyState title="This bisect could not be read" description={res.error} />
      ) : (
        <div className="ev-page ev-note" data-evals-loading>
          Reading the bisect...
        </div>
      )}
    </div>
  );
}
