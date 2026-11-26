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

// deployLines holds each shown Deploys card's commit lines (hooks/useDeployLines), keyed by the deploy's id, so a card
// seen before paints its +/− from the store; shippingRuns and shippingShippers hold a team's Ship runs
// (hooks/useSyncShipping), so a revisit paints Shipping from the store.
describe("a deploy card's lines and a team's Ship runs live in the store", () => {
  const { deployLinesRows } = require("../../hooks/useDeployLines");
  const { applyShipping } = require("../../hooks/useSyncShipping");
  const line = { sha: "abc1234", insertions: 3, deletions: 1, pr_number: 7, branch: "jb/x" };
  const lines = (answer: unknown) => applyCollectionFeed("deployLines", answer, (a: any) => deployLinesRows(id(1), a));

  it("a deployLines answer lands under the deploy's id, a null one changes nothing, and the cap holds", () => {
    useInboxStore.setState({ deployLines: {} } as any);
    lines({ rows: [line] });
    expect(state().deployLines[id(1)]).toMatchObject({ _id: id(1), rows: [line] });
    const before = state().deployLines;
    lines(null);
    expect(state().deployLines).toBe(before);
    const CAP = DETAIL_ROW_CAPS.deployLines;
    const release = pinDetailRows("deployLines", [id(1)]);
    for (let n = 2; n < CAP + 5; n++) state().syncTable("deployLines", [{ _id: id(n), rows: [], _cachedAt: n }]);
    expect(Object.keys(state().deployLines).length).toBeLessThanOrEqual(CAP);
    expect(state().deployLines[id(1)]).toBeDefined();
    release();
  });

  it("a shippingRuns answer fills both homes for its team, and the next one drops what that team no longer sends", () => {
    useInboxStore.setState({ shippingRuns: {}, shippingShippers: {} } as any);
    const run = (rid: string) => ({ _id: rid, status: "running", node_statuses: [], user_id: "u", created_at: 1, updated_at: 1 });
    const shipper = (rid: string) => ({ run_id: rid, task_short_id: null, merged_sha: null, spawner_conversation_id: null, user_id: "u", stand_in: false, created_at: 1 });
    applyShipping("t1", { runs: [run("r1"), run("r2")], shippers: [shipper("r1"), shipper("r9")] });
    applyShipping("t2", { runs: [run("r5")], shippers: [] });
    expect(state().shippingRuns.r1.workspace).toBe("team:t1");
    expect(state().shippingShippers.r9).toMatchObject({ _id: "r9", workspace: "team:t1" });
    applyShipping("t1", { runs: [run("r2")], shippers: [] });
    expect(Object.keys(state().shippingRuns).sort()).toEqual(["r2", "r5"]);
    expect(state().shippingShippers).toEqual({});
    applyShipping("t1", null);
    expect(Object.keys(state().shippingRuns).sort()).toEqual(["r2", "r5"]);
  });
});
