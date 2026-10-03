// The frame every Evals view renders in: the local nav, the index's first
// build when it is still running, and the honest screen for each way the
// evals can be out of reach (no daemon, no checkout, a crashed child).

import { useEffect, type ReactNode } from "react";
import { useEvalsStore } from "../../store/evalsStore";
import { useEvalsConnection } from "../../lib/evals/hooks";
import { LocalDaemonUnreachable } from "../LocalDaemonUnreachable";
import { EvalsNav } from "./EvalsNav";
import type { EvalsView } from "./evalsPaths";
import "./evals.css";

/** While the api child builds its index for the first time: how far it is, read from GET /health every 2 s. */
function IndexProgress() {
  const health = useEvalsStore((s) => s.health);
  const building = !!health && health.index.state !== "warm";
  useEffect(() => {
    if (!building) return;
    const id = setInterval(() => void useEvalsStore.getState().refreshHealth(), 2_000);
    return () => clearInterval(id);
  }, [building]);
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
        <span className="ev-index-fill block" style={{ width: `${pct ?? 8}%` }} />
      </span>
      <span className="ev-quiet">Views fill in as it goes.</span>
    </div>
  );
}

export function EvalsShell({ view, children }: { view: EvalsView; children: ReactNode }) {
  const { connection, retry } = useEvalsConnection();
  const reason = useEvalsStore((s) => s.unreachableReason);
  const detail = useEvalsStore((s) => s.unreachableDetail);
  const stderr = useEvalsStore((s) => s.stderr);

  let body: ReactNode;
  if (connection === "connected") body = children;
  else if (connection === "no-daemon") body = <LocalDaemonUnreachable what="Evals" reason={reason} detail={detail} onRetry={retry} />;
  else if (connection === "no-checkout") body = <LocalDaemonUnreachable what="Evals" reason="no-checkout" detail={detail} onRetry={retry} />;
  else if (connection === "child-crashed") body = <LocalDaemonUnreachable what="Evals" reason="child-crashed" detail={detail} stderr={stderr} onRetry={retry} />;
  else
    body = (
      <div className="h-full flex items-center justify-center text-[12px] ev-quiet" data-evals-connecting>
        Finding the daemon on this machine...
      </div>
    );

  return (
    <div className="ev-area" data-evals-shell data-evals-connection={connection} data-evals-view={view.view}>
      <EvalsNav view={view} />
      <IndexProgress />
      <div className="ev-body">{body}</div>
    </div>
  );
}
