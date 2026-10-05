// One run in full: GET /run/:id, plus the freeze's GET /freeze/:id for the
// moment, the production reply and the runs the prompt diffs reach back to.
// The address carries the tab and any gate or check (`#guard`,
// `#gate-no-leak`), so a link lands exactly there.

import { useCallback, useEffect, useRef, useState } from "react";
import { useEvalsChanges, useEvalsHealth, useEvalsResource } from "../../../lib/evals/hooks";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { useEvalsHost } from "../host";
import { RunView } from "../RunView";
import { runTabs, seedNeighbours, tabOfHash, type RunTab } from "../runModel";

/** Sticky chrome above a gate or check when the page lands on it: the tab bar. */
const LAND_MARGIN = 52;

export function RunPage({ view }: { view: Extract<EvalsView, { view: "run" }> }) {
  const host = useEvalsHost();
  const { EmptyState } = host.ui;
  const navigate = host.useNavigate();
  const hash = host.useHash();
  const rootRef = useRef<HTMLDivElement>(null);
  const run = useEvalsResource("GET /run/:id", { params: { id: view.runId } });
  const data = run.data?.row.id === view.runId ? run.data : null;
  const freezeId = data?.row.freezeId ?? null;
  const freeze = useEvalsResource("GET /freeze/:id", freezeId ? { params: { id: freezeId } } : null);
  const evalsHome = useEvalsHealth().health?.evalsHome ?? null;

  // UI state that belongs to one run: a different run starts clean.
  const [ui, setUi] = useState<{ run: string; file: string | null; picking: boolean; overlay: boolean }>({ run: view.runId, file: null, picking: false, overlay: false });
  const local = ui.run === view.runId ? ui : { run: view.runId, file: null, picking: false, overlay: false };
  const patch = (p: Partial<typeof local>) => setUi({ ...local, ...p });
  const file = useEvalsResource("GET /run/:id/file", local.file ? { params: { id: view.runId }, query: { path: local.file } } : null);

  const tabs = data ? runTabs(data) : [];
  const { tab, target } = tabOfHash(hash, tabs);
  const base = evalsHref.run(view.runId);
  const setHash = useCallback((h: string | null) => navigate(h ? `${base}#${h}` : base, { replace: true }), [navigate, base]);

  // Land on the gate or check the address names, once its row is drawn.
  const landed = !!data;
  useEffect(() => {
    if (!target || !landed) return;
    return host.landOn(
      () => rootRef.current?.closest<HTMLElement>(".ev-body") ?? rootRef.current,
      (root) => root.querySelector<HTMLElement>(`[id="${CSS.escape(target)}"]`),
      () => LAND_MARGIN,
    );
  }, [host, target, landed]);

  // A rep still being written fills in as it lands.
  const landing = !!data && data.row.status === "unscored" && !data.logTail;
  useEvalsChanges(landing, (changes) => {
    if (changes.runs.some((r) => r.id === view.runId)) run.reload();
  });

  const active = host.useActive() && !!data;
  const go = (id: string | null | undefined) => {
    if (!id) return false;
    navigate(evalsHref.run(id));
    return true;
  };
  const seeds = data ? seedNeighbours(data.row, data.siblings) : null;
  host.useShortcuts(
    {
      "evalsRun.nextSeed": { keys: "j", label: "Next seed of this freeze in the batch", run: () => go(seeds?.next) },
      "evalsRun.prevSeed": { keys: "k", label: "Previous seed of this freeze in the batch", run: () => go(seeds?.prev) },
      "evalsRun.prevBatch": { keys: "[", label: "The same freeze in the previous batch", run: () => go(data?.adjacent.previous) },
      "evalsRun.nextBatch": { keys: "]", label: "The same freeze in the next batch", run: () => go(data?.adjacent.next) },
      "evalsRun.compare": { keys: "c", label: "Pick a second rep to compare with", run: () => (patch({ picking: !local.picking }), true) },
    },
    active,
  );

  if (!data) {
    if (run.status === 404) {
      return <EmptyState title="No run by that id" description={`${view.runId} is not in the index. It may have been pruned, or the address was cut short.`} action={{ label: "Open the wall", href: evalsHref.home() }} />;
    }
    if (run.error) return <EmptyState title="This run could not be read" description={run.error} />;
    return (
      <div className="ev-page ev-note" data-evals-page="run" data-evals-loading>
        Reading the run folder...
      </div>
    );
  }

  return (
    <div ref={rootRef} data-evals-page="run">
      <RunView
        run={data}
        freeze={freeze.data?.freeze.id === freezeId ? freeze.data : null}
        evalsHome={evalsHome}
        tab={tab}
        onTab={(t: RunTab) => setHash(t === "verdict" ? null : t)}
        target={target}
        anchorHref={(a) => `${base}#${a}`}
        onAnchor={(a) => setHash(a)}
        file={local.file ? { path: local.file, data: file.data?.path === local.file ? file.data : null, loading: file.loading, error: file.error } : null}
        onOpenFile={(path) => patch({ file: path })}
        picking={local.picking}
        onPicking={(picking) => patch({ picking })}
        overlayProduction={local.overlay}
        onOverlayProduction={(overlay) => patch({ overlay })}
        landing={landing}
      />
    </div>
  );
}
