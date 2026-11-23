import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { COLLECTION_RETENTION } from "../cacheRetention";
import { DETAIL_ROW_CAPS, pinDetailRows, resetDetailPins } from "../../lib/detailRows";
import { _resetSnapshotLedger } from "../idbCollectionDiff";

// runGraphs holds the graph each pinned run executes (hooks/useSyncWorkflows useRunWorkflow), one row per version a
// run card opened, each up to ~30 KB: capped like the detail collections, and the card on screen pins its row.

const state = () => useInboxStore.getState() as any;
const ver = (n: number) => `ver${n}`;
const graph = (n: number) => ({ _id: ver(n), workflow_id: "wf", name: "change", nodes: [], edges: [], _cachedAt: n });
const fed = (from: number, count: number) => {
  for (let n = from; n < from + count; n++) state().syncTable("runGraphs", [graph(n)]);
};

beforeEach(() => {
  useInboxStore.setState({ runGraphs: {}, pending: {}, syncRole: "host" } as any);
  resetDetailPins();
  _resetSnapshotLedger();
});

describe("runGraphs is capped like the detail collections", () => {
  const CAP = DETAIL_ROW_CAPS.runGraphs;

  it("keeps the most recently fed graphs, never more than the cap", () => {
    fed(1, CAP + 3);
    expect(Object.keys(state().runGraphs)).toHaveLength(CAP);
    for (let n = 1; n <= 3; n++) expect(state().runGraphs[ver(n)]).toBeUndefined();
  });

  it("never evicts the graph a mounted run card draws", () => {
    fed(1, CAP);
    const release = pinDetailRows("runGraphs", [ver(1)]);
    fed(CAP + 1, 2);
    expect(state().runGraphs[ver(1)]).toBeDefined();
    release();
  });

  it("holds the same cap at boot, oldest first", () => {
    const rows = Array.from({ length: CAP + 2 }, (_, i) => ({ ...graph(i + 1), _cachedAt: Date.now() - (CAP + 2 - i) * 1000 }));
    const { keep, drop } = COLLECTION_RETENTION.runGraphs(rows, Date.now());
    expect(keep).toHaveLength(CAP);
    expect([...drop].sort()).toEqual([ver(1), ver(2)]);
  });
});
