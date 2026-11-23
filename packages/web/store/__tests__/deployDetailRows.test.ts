import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { COLLECTION_RETENTION } from "../cacheRetention";
import { applyCollectionFeed } from "../../hooks/useSyncCollection";
import { deployDetailRows } from "../../hooks/useDeployDetail";
import { DETAIL_ROW_CAPS, pinDetailRows, resetDetailPins } from "../../lib/detailRows";

// deployDetails holds the names an opened deploy's push added and dropped
// (hooks/useDeployDetail), keyed by the deploy's id; the teamDeploys row keeps
// only their counts.

const state = () => useInboxStore.getState() as any;
const id = (n: number) => `dep${n}`;
const view = (n: number, extra: Record<string, unknown> = {}) => ({ _id: id(n), short_id: `dp-${n}`, adds: [`fn:a${n}`], drops: [`fn:d${n}`], ...extra });
const feed = (answer: unknown) => applyCollectionFeed("deployDetails", answer, deployDetailRows as any);

beforeEach(() => {
  useInboxStore.setState({ deployDetails: {}, teamDeploys: {}, pending: {}, syncRole: "host" } as any);
  resetDetailPins();
});

describe("a deploys.get answer lands only its names", () => {
  it("keys the row by the deploy's id, the list row's key, stamped with when it was fed", () => {
    feed({ ...view(1), sha: "abc", commits: [], carries: [] });
    expect(Object.keys(state().deployDetails[id(1)]).sort()).toEqual(["_cachedAt", "_id", "adds", "drops"]);
    expect(state().deployDetails[id(1)].adds).toEqual(["fn:a1"]);
    expect(state().deployDetails[id(1)].drops).toEqual(["fn:d1"]);
  });

  it("an answer without names holds empty lists", () => {
    feed({ _id: id(1), short_id: "dp-1" });
    expect(state().deployDetails[id(1)]).toMatchObject({ adds: [], drops: [] });
  });

  it("a null answer (no access, not loaded) changes nothing", () => {
    feed(view(1));
    const before = state().deployDetails;
    feed(null);
    feed(undefined);
    expect(state().deployDetails).toBe(before);
  });

  it("an unchanged answer keeps the row's stamp, so a push does not rewrite it", () => {
    feed(view(1));
    const first = state().deployDetails[id(1)];
    feed(view(1));
    expect(state().deployDetails[id(1)]._cachedAt).toBe(first._cachedAt);
  });

  it("never writes the names onto the list row", () => {
    state().syncTable("teamDeploys", [{ _id: id(1), short_id: "dp-1", adds_count: 1, drops_count: 1 }]);
    feed(view(1));
    expect(state().teamDeploys[id(1)].adds).toBeUndefined();
  });
});

describe("the collection is capped like the detail collections", () => {
  const CAP = DETAIL_ROW_CAPS.deployDetails;
  const fed = (from: number, count: number) => {
    for (let n = from; n < from + count; n++) state().syncTable("deployDetails", [{ _id: id(n), adds: [], drops: [], _cachedAt: n }]);
  };

  it("keeps the most recently opened rows, never more than the cap", () => {
    fed(1, CAP + 3);
    expect(Object.keys(state().deployDetails)).toHaveLength(CAP);
    for (let n = 1; n <= 3; n++) expect(state().deployDetails[id(n)]).toBeUndefined();
    expect(state().deployDetails[id(CAP + 3)]).toBeDefined();
  });

  it("never evicts the row an open detail reads", () => {
    fed(1, CAP);
    const release = pinDetailRows("deployDetails", [id(1)]);
    fed(CAP + 1, 2);
    expect(state().deployDetails[id(1)]).toBeDefined();
    release();
    fed(CAP + 3, 1);
    expect(state().deployDetails[id(1)]).toBeUndefined();
  });

  it("holds the same cap at boot, oldest first", () => {
    const rows = Array.from({ length: CAP + 2 }, (_, i) => ({ _id: id(i + 1), adds: [], drops: [], _cachedAt: Date.now() - (CAP + 2 - i) * 1000 }));
    const { keep, drop } = COLLECTION_RETENTION.deployDetails(rows, Date.now());
    expect(keep).toHaveLength(CAP);
    expect([...drop].sort()).toEqual([id(1), id(2)]);
  });
});
