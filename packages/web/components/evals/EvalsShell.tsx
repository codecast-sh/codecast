// The frame every Evals view renders in: the local nav, the index's first
// build when it is still running, and, while the data is out of reach, the
// screen the host gives for it (codecast: no daemon, no checkout, a crashed child).

import { useEffect, type ReactNode } from "react";
import { useEvalsHealth } from "../../lib/evals/hooks";
import { EvalsNav } from "./EvalsNav";
import type { EvalsView } from "./evalsPaths";
import { useEvalsHost } from "./host";

/** While the api child builds its index for the first time: how far it is, read from GET /health every 2 s. */
function IndexProgress() {
  const { health, refresh } = useEvalsHealth();
  const building = !!health && health.index.state !== "warm";
  useEffect(() => {
    if (!building) return;
    const id = setInterval(refresh, 2_000);
    return () => clearInterval(id);
  }, [building, refresh]);
  if (!health || !building) return null;
  const { done, total } = health.index;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <div className="ev-index" role="status" data-evals-index={health.index.state}>
      <span>
        Indexing the run folders for the first time: <span className="ev-tabular">{done.toLocaleString()}</span>
        {total ? <> of <span className="ev-tabular">{total.toLocaleString()}</span></> : null}
      </span>
      <span className="ev-index-track">
        <span className="ev-index-fill" style={{ width: `${pct ?? 8}%` }} />
      </span>
      <span className="ev-quiet">Views fill in as it goes.</span>
    </div>
  );
}

export function EvalsShell({ view, children }: { view: EvalsView; children: ReactNode }) {
  const { state, screen } = useEvalsHost().useConnection();
  return (
    <div className="ev-area" data-evals-shell data-evals-connection={state} data-evals-view={view.view}>
      <EvalsNav view={view} />
      <IndexProgress />
      <div className="ev-body">{screen ?? children}</div>
    </div>
  );
}
