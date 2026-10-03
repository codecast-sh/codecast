import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { applyCollectionFeed } from "../useSyncCollection";
import { detailGone, groupSamplesPrune, OPS_LIST_LIMIT, workspaceWindowPrune } from "../useSyncOps";

// opsGroups and opsReplays are delta collections: an opened row's detail must
// survive a list that does not carry it, and the list must still drop a row
// the server deleted inside the window it vouches for (useSyncOps).
const id = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const WS = "team:t1";
const OTHER = "team:t2";
const group = (seed: string, last_seen: number, workspace = WS) => ({ _id: id(seed), workspace, source_id: id("src"), short_id: `eg-${seed}`, kind: "error", status: "open", title: seed, last_seen, first_seen: 1, count: 1, buckets: [], updated_at: 1 });
const replay = (seed: string, started_at: number) => ({ _id: id(seed), workspace: WS, short_id: `rp-${seed}`, started_at, updated_at: 1, chunks: 1, group_ids: [], counts: { clicks: 0, errors: 0, failed_requests: 0 } });
const groupsPrune = workspaceWindowPrune<any>(OPS_LIST_LIMIT.groups, (g) => g.last_seen);
const replaysPrune = workspaceWindowPrune<any>(2, (r) => r.started_at);
const ids = (key: string) => Object.keys((useInboxStore.getState() as any)[key]).sort();

describe("ops list windows", () => {
  beforeEach(() => useInboxStore.setState({ opsGroups: {}, opsReplays: {}, opsSamples: {}, pending: {} } as any));

  it("a group the list stops carrying leaves, other workspaces stay", () => {
    applyCollectionFeed("opsGroups", [group("a", 10), group("b", 20)], undefined, groupsPrune);
    useInboxStore.getState().syncTable("opsGroups", [group("x", 5, OTHER)]);
    applyCollectionFeed("opsGroups", [group("b", 20)], undefined, groupsPrune);
    expect(ids("opsGroups")).toEqual([id("b"), id("x")].sort());
  });

  it("an empty answer prunes nothing", () => {
    applyCollectionFeed("opsGroups", [group("a", 10)], undefined, groupsPrune);
    applyCollectionFeed("opsGroups", [], undefined, groupsPrune);
    expect(ids("opsGroups")).toEqual([id("a")]);
  });

  it("an opened replay older than the full window survives every list push", () => {
    // The detail lands first, then a full page of newer recordings.
    useInboxStore.getState().syncTable("opsReplays", [replay("old", 1)]);
    applyCollectionFeed("opsReplays", [replay("n1", 30), replay("n2", 20)], undefined, replaysPrune);
    applyCollectionFeed("opsReplays", [replay("n3", 40), replay("n1", 30)], undefined, replaysPrune);
    // n2 (20) is older than this page's floor (30), so the page says nothing about it.
    expect(ids("opsReplays")).toEqual([id("n1"), id("n2"), id("n3"), id("old")].sort());
    // A recording inside the window the server no longer lists leaves.
    applyCollectionFeed("opsReplays", [replay("n3", 40), replay("n2", 20)], undefined, replaysPrune);
    expect(ids("opsReplays")).toEqual([id("n2"), id("n3"), id("old")].sort());
  });

  it("a group's answer vouches for its own samples only", () => {
    const sample = (seed: string, group_id: string, at: number) => ({ _id: id(seed), group_id, source_id: id("src"), at });
    useInboxStore.getState().syncTable("opsSamples", [sample("s1", id("g1"), 1), sample("s2", id("g1"), 2), sample("s3", id("g2"), 3)]);
    const answer = { group: group("g1", 2), samples: [sample("s2", id("g1"), 2)] };
    applyCollectionFeed("opsSamples", answer, (d: any) => d.samples, groupSamplesPrune);
    expect(ids("opsSamples")).toEqual([id("s2"), id("s3")].sort());
  });
});

describe("detailGone", () => {
  it("is a refusal or a NOT_FOUND, never a failed read", () => {
    expect(detailGone({ refused: true })).toBe(true);
    expect(detailGone({ refused: false, error: Object.assign(new Error("x"), { data: { code: "NOT_FOUND", message: "Group eg-1 not found" } }) })).toBe(true);
    expect(detailGone({ refused: false, error: new Error("Could not find public function") })).toBe(false);
    expect(detailGone({ refused: false })).toBe(false);
  });
});
