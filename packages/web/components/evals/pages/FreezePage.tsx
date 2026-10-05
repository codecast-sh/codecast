// One freeze across time, connected (docs/architecture/evals-ui.md section
// 4.3): GET /freeze/:id for the freeze, its moment and every rep; the surface's
// ledger row from GET /surface/:id (cached and shared with the surface page)
// for where it flipped; and GET /run/:id for each of the two cards.

import { useMemo, useState } from "react";
import { resolveEvalsBatchRef } from "@codecast/shared/contracts/evalsApi";
import { EmptyState } from "../../EmptyState";
import { useEvalsResource } from "../../../lib/evals/hooks";
import { evalsHref, type EvalsView } from "../evalsPaths";
import { FreezeView } from "../FreezeView";
import { defaultFreezePair, type FreezePair } from "../freezeModel";

function ConnectedFreeze({ freezeId, batch, given }: { freezeId: string; batch: string | null; given: FreezePair | null }) {
  const freeze = useEvalsResource("GET /freeze/:id", { params: { id: freezeId } });
  const surfaceId = freeze.data?.freeze.surface ?? null;
  const surface = useEvalsResource("GET /surface/:id", surfaceId ? { params: { id: surfaceId } } : null);
  // The address names the freeze by its prefix and a labelled batch by its hash; the freeze's own record says which.
  const fullId = freeze.data?.freeze.id ?? freezeId;
  const pinned = useMemo(() => (batch && freeze.data ? resolveEvalsBatchRef(batch, freeze.data.runs.flatMap((r) => (r.batch ? [r.batch] : []))) : batch), [batch, freeze.data]);
  const cells = useMemo(() => surface.data?.ledger.find((r) => r.freezeId === fullId)?.cells ?? null, [surface.data, fullId]);
  // The default pair waits for the ledger (or its failure), so the cards do not jump once it lands.
  const ledgerSettled = !!surface.data || !!surface.error;
  const pick = useMemo(() => (freeze.data && ledgerSettled ? defaultFreezePair(freeze.data.runs, cells, pinned) : null), [freeze.data, ledgerSettled, cells, pinned]);
  // A link that names two runs (a flip's before and after) opens on them, not on the default pair.
  const [chosen, setChosen] = useState<FreezePair | null>(given);
  const pair: FreezePair = chosen ?? pick ?? { a: null, b: null };
  const runA = useEvalsResource("GET /run/:id", pair.a ? { params: { id: pair.a } } : null);
  const runB = useEvalsResource("GET /run/:id", pair.b ? { params: { id: pair.b } } : null);

  if (!freeze.data) {
    if (freeze.status === 404)
      return (
        <EmptyState
          title="No freeze with this id"
          description={`${freezeId} is not in this machine's index or registry. The wall lists every surface, and each surface's plate lists its freezes.`}
          action={{ label: "Open the wall", href: evalsHref.home() }}
        />
      );
    if (freeze.error) return <EmptyState title="This freeze could not be read" description={freeze.error} />;
    return (
      <div className="ev-page text-[12px] ev-quiet" data-evals-loading>
        Reading the freeze and every rep of it...
      </div>
    );
  }
  return (
    <FreezeView
      freeze={freeze.data}
      cells={cells}
      footing={surface.data?.footing ?? []}
      pinnedBatch={pinned}
      pair={pair}
      pick={pick ?? { a: null, b: null, flip: null, why: "Reading where it flipped..." }}
      runA={pair.a ? runA.data : null}
      runB={pair.b ? runB.data : null}
      loadingA={!!pair.a && runA.loading}
      loadingB={!!pair.b && runB.loading}
      onPair={setChosen}
    />
  );
}

export function FreezePage({ view }: { view: Extract<EvalsView, { view: "freeze" }> }) {
  // A new freeze, pinned batch or named pair starts over.
  const given = view.a && view.b ? { a: view.a, b: view.b } : null;
  return (
    <div data-evals-page="freeze">
      <ConnectedFreeze key={`${view.freezeId}|${view.batch ?? ""}|${view.a ?? ""}|${view.b ?? ""}`} freezeId={view.freezeId} batch={view.batch} given={given} />
    </div>
  );
}
