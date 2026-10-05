// One run in full: GET /run/:id, plus the freeze's GET /freeze/:id for the
// moment, the production reply and the runs the prompt diffs reach back to.
// The address carries the tab and any gate or check (`#guard`,
// `#gate-no-leak`), so a link lands exactly there.

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "../../EmptyState";
import { useRepoLocation } from "../../repo/useRepoFamily";
import { landOn } from "../../../hooks/useDiffAddress";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { useShortcutAction, useShortcutContext } from "../../../shortcuts";
import { useEvalsChanges, useEvalsResource } from "../../../lib/evals/hooks";
import { useEvalsStore } from "../../../store/evalsStore";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { RunView } from "../RunView";
import { runTabs, seedNeighbours, tabOfHash, type RunTab } from "../runModel";

/** Sticky chrome above a gate or check when the page lands on it: the tab bar. */
const LAND_MARGIN = 52;

export function RunPage({ view }: { view: Extract<EvalsView, { view: "run" }> }) {
  const router = useRouter();
  const loc = useRepoLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const run = useEvalsResource("GET /run/:id", { params: { id: view.runId } });
  const data = run.data?.row.id === view.runId ? run.data : null;
  const freezeId = data?.row.freezeId ?? null;
  const freeze = useEvalsResource("GET /freeze/:id", freezeId ? { params: { id: freezeId } } : null);
  const evalsHome = useEvalsStore((s) => s.health?.evalsHome ?? null);

  // UI state that belongs to one run: a different run starts clean.
  const [ui, setUi] = useState<{ run: string; file: string | null; picking: boolean; overlay: boolean }>({ run: view.runId, file: null, picking: false, overlay: false });
  const local = ui.run === view.runId ? ui : { run: view.runId, file: null, picking: false, overlay: false };
  const patch = (p: Partial<typeof local>) => setUi({ ...local, ...p });
  const file = useEvalsResource("GET /run/:id/file", local.file ? { params: { id: view.runId }, query: { path: local.file } } : null);

  const tabs = data ? runTabs(data) : [];
  const { tab, target } = tabOfHash(loc.hash, tabs);
  const base = evalsHref.run(view.runId);
  const setHash = useCallback((h: string | null) => router.replace(h ? `${base}#${h}` : base, { scroll: false }), [router, base]);

  // Land on the gate or check the address names, once its row is drawn.
  useWatchEffect(() => {
    if (!target || !data) return;
    return landOn(
      () => rootRef.current?.closest<HTMLElement>(".ev-body") ?? rootRef.current,
      (root) => root.querySelector<HTMLElement>(`[id="${CSS.escape(target)}"]`),
      () => LAND_MARGIN,
    );
  }, [target, !!data]);

  // A rep still being written fills in as it lands.
  const landing = !!data && data.row.status === "unscored" && !data.logTail;
  useEvalsChanges(landing, (changes) => {
    if (changes.runs.some((r) => r.id === view.runId)) run.reload();
  });

  const active = useTabActive() && !!data;
  useShortcutContext("evalsRun", active);
  const go = (id: string | null | undefined) => {
    if (!active || !id) return false;
    router.push(evalsHref.run(id));
    return true;
  };
  const seeds = data ? seedNeighbours(data.row, data.siblings) : null;
  useShortcutAction("evalsRun.nextSeed", () => go(seeds?.next));
  useShortcutAction("evalsRun.prevSeed", () => go(seeds?.prev));
  useShortcutAction("evalsRun.prevBatch", () => go(data?.adjacent.previous));
  useShortcutAction("evalsRun.nextBatch", () => go(data?.adjacent.next));
  useShortcutAction("evalsRun.compare", () => {
    if (!active) return false;
    patch({ picking: !local.picking });
    return true;
  });

  if (!data) {
    if (run.status === 404) {
      return <EmptyState title="No run by that id" description={`${view.runId} is not in the index. It may have been pruned, or the address was cut short.`} action={{ label: "Open the wall", href: evalsHref.home() }} />;
    }
    if (run.error) return <EmptyState title="This run could not be read" description={run.error} />;
    return (
      <div className="ev-page text-[12px] ev-quiet" data-evals-page="run" data-evals-loading>
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
