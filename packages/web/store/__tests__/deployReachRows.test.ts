import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { COLLECTION_RETENTION } from "../cacheRetention";
import { applyCollectionFeed } from "../../hooks/useSyncCollection";
import { deployReachFeed } from "../../hooks/useDeployReach";
import { DETAIL_ROW_CAPS, pinDetailRows, resetDetailPins } from "../../lib/detailRows";
import { _resetSnapshotLedger, deleteAllowed } from "../idbCollectionDiff";

// deployReach rows say how far a merged change has gone (hooks/useDeployReach).
// A row the server stopped answering for kept saying "not live yet" forever,
// and nothing bounded how many a window held.

const state = () => useInboxStore.getState() as any;
const ref = (n: number) => `acme/app#${n}`;
const reach = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: ref(n), ref: ref(n), state: "waiting", sha: null,
  targets: [{ target: "web", state: "waiting", deploy: null, now: null }], ...extra,
});
const feed = (n: number, answer: unknown) => {
  const { select, dropAbsent } = deployReachFeed(ref(n));
  applyCollectionFeed("deployReach", answer, select as any, undefined, dropAbsent);
};

beforeEach(() => {
  useInboxStore.setState({ deployReach: {}, pending: {}, syncRole: "host" } as any);
  resetDetailPins();
  _resetSnapshotLedger();
});

describe("a ref's answer is the whole truth about it", () => {
  it("lands the row, stamped with when it was fed", () => {
    feed(1, reach(1));
    expect(state().deployReach[ref(1)].state).toBe("waiting");
    expect(typeof state().deployReach[ref(1)]._cachedAt).toBe("number");
  });

  it("a null answer removes the row the store held, and the removal may reach disk", () => {
    feed(1, reach(1));
    feed(2, reach(2));
    // The target was retired, the change no longer touches one, or the viewer lost access.
    feed(1, null);
    expect(state().deployReach[ref(1)]).toBeUndefined();
    // A ref is not a Convex id, so the drop leaves disk with the next write.
    expect(deleteAllowed("deployReach", ref(1), {})).toBe(true);
    // Another ref's row is not this answer's to judge.
    expect(state().deployReach[ref(2)]).toBeDefined();
  });

  it("a null answer for a ref the store never held changes nothing", () => {
    feed(2, reach(2));
    const before = state().deployReach;
    feed(1, null);
    expect(state().deployReach).toBe(before);
  });

  it("an unchanged answer keeps the row's stamp, so a push does not rewrite it", () => {
    feed(1, reach(1));
    const first = state().deployReach[ref(1)];
    feed(1, reach(1));
    expect(state().deployReach[ref(1)]._cachedAt).toBe(first._cachedAt);
  });
});

describe("the collection is capped like the detail collections", () => {
  const CAP = DETAIL_ROW_CAPS.deployReach;
  const fed = (from: number, count: number) => {
    for (let n = from; n < from + count; n++) state().syncTable("deployReach", [reach(n, { _cachedAt: n })]);
  };

  it("keeps the most recently fed rows, never more than the cap", () => {
    fed(1, CAP + 5);
    expect(Object.keys(state().deployReach)).toHaveLength(CAP);
    for (let n = 1; n <= 5; n++) expect(state().deployReach[ref(n)]).toBeUndefined();
    expect(state().deployReach[ref(CAP + 5)]).toBeDefined();
  });

  it("never evicts the row a mounted pill reads", () => {
    fed(1, CAP);
    const release = pinDetailRows("deployReach", [ref(1)]);
    fed(CAP + 1, 3);
    expect(state().deployReach[ref(1)]).toBeDefined();
    expect(Object.keys(state().deployReach)).toHaveLength(CAP);
    release();
    fed(CAP + 4, 1);
    expect(state().deployReach[ref(1)]).toBeUndefined();
  });

  it("holds the same cap at boot, oldest first", () => {
    const rows = Array.from({ length: CAP + 2 }, (_, i) => reach(i + 1, { _cachedAt: Date.now() - (CAP + 2 - i) * 1000 }));
    const { keep, drop } = COLLECTION_RETENTION.deployReach(rows, Date.now());
    expect(keep).toHaveLength(CAP);
    expect([...drop].sort()).toEqual([ref(1), ref(2)]);
  });
});
