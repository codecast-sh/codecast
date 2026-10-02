// The Changes page's store wiring (docs/proposals/changes-page.md 8.3): the
// four collections are registered with the sync mode their feeds need, a story
// a rebuild deleted leaves the cache for exactly the days an answer covered
// whole, never for days or teams it did not read, and editions only ever add.
import { beforeEach, describe, expect, it } from "bun:test";
import {
  COLLECTION_STORE_KEYS,
  HYDRATION_DEFERRED_KEYS,
  REGISTERED_FEEDS,
  REGISTRY_SYNC_OPTS,
  REPLICATION_CLASSIFICATION,
  WORKSPACE_SCOPED_KEYS,
} from "../../store/clientSyncRegistry";
import { useInboxStore } from "../../store/inboxStore";
import { applyCollectionFeed } from "../useSyncCollection";
import { changesWindow, selectStories, storySyncOpts } from "../useSyncChanges";

const TEAM = "team_a";
const OTHER = "team_b";
const REPO = "codecast-sh/codecast";

const story = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  team_id: TEAM,
  repository: REPO,
  date,
  story_key: `k_${id}`,
  headline: id,
  ...extra,
});

const stories = () => useInboxStore.getState().changeStories as Record<string, any>;
const pending = () => useInboxStore.getState().pending as Record<string, any>;

describe("registration", () => {
  it("registers the four collections with their feeds, deferred and shared", () => {
    for (const key of ["changeStories", "changeEditions", "changeLive", "changeWorks"] as const) {
      expect(COLLECTION_STORE_KEYS).toContain(key);
      expect(HYDRATION_DEFERRED_KEYS).toContain(key);
      expect(REPLICATION_CLASSIFICATION[key]).toBe("shared");
      expect(WORKSPACE_SCOPED_KEYS).not.toContain(key);
    }
    expect(REGISTERED_FEEDS["changesQueries.listStories"]).toBe("changeStories");
    expect(REGISTERED_FEEDS["changesQueries.listEditions"]).toBe("changeEditions");
    expect(REGISTERED_FEEDS["changesQueries.liveStatus"]).toBe("changeLive");
    expect(REGISTERED_FEEDS["changesQueries.inTheWorks"]).toBe("changeWorks");
    expect(REGISTERED_FEEDS["changesQueries.storyEvidence"]).toBe("commits");
  });

  it("windows are deltas, the now-shaped feeds are snapshots", () => {
    expect(REGISTRY_SYNC_OPTS.changeStories?.isDelta).toBe(true);
    expect(REGISTRY_SYNC_OPTS.changeEditions?.isDelta).toBe(true);
    expect(REGISTRY_SYNC_OPTS.changeLive?.isDelta).toBeFalsy();
    expect(REGISTRY_SYNC_OPTS.changeWorks?.isDelta).toBeFalsy();
  });
});

describe("changesWindow", () => {
  it("spans three days each side, across a month end", () => {
    expect(changesWindow("2026-10-02")).toEqual({ from_date: "2026-09-29", to_date: "2026-10-05" });
  });
});

describe("story feed", () => {
  const scope = { teamId: TEAM, repository: REPO };
  const window = changesWindow("2026-10-02");
  const feed = (data: any) => applyCollectionFeed("changeStories", data, selectStories, storySyncOpts(scope, window));

  beforeEach(() => {
    useInboxStore.setState({ changeStories: {}, pending: {} } as any);
    useInboxStore.getState().syncTable("changeStories", [
      story("kept", "2026-10-02"),
      story("merged_away", "2026-10-02"),
      story("old_day", "2026-09-29"),
      story("outside", "2026-09-20"),
      story("other_repo", "2026-10-02", { repository: "acme/web" }),
      story("other_team", "2026-10-02", { team_id: OTHER }),
    ]);
  });

  it("prunes a story a rebuild deleted from a day the answer covered whole", () => {
    feed({ stories: [story("kept", "2026-10-02"), story("old_day", "2026-09-29"), story("new", "2026-10-02")], covered_from: "2026-09-29", complete: true });
    expect(Object.keys(stories()).sort()).toEqual(["kept", "new", "old_day", "other_repo", "other_team", "outside"]);
    expect(pending()["changeStories:merged_away"]?.type).toBe("exclude");
  });

  it("keeps days before covered_from when the read stopped short", () => {
    feed({ stories: [story("kept", "2026-10-02")], covered_from: "2026-10-02", complete: false });
    expect(stories().old_day).toBeDefined();
    expect(stories().merged_away).toBeUndefined();
  });

  it("prunes nothing when no whole day was read", () => {
    feed({ stories: [story("kept", "2026-10-02")], covered_from: null, complete: false });
    expect(stories().merged_away).toBeDefined();
    expect(stories().old_day).toBeDefined();
  });

  it("syncs nothing when the server refused the caller", () => {
    feed(null);
    expect(Object.keys(stories())).toHaveLength(6);
    expect(Object.keys(pending())).toHaveLength(0);
  });

  it("a story pruned once stays out when a slower window still names it", () => {
    feed({ stories: [story("kept", "2026-10-02")], covered_from: "2026-10-02", complete: true });
    useInboxStore.getState().syncTable("changeStories", [story("merged_away", "2026-10-02")]);
    expect(stories().merged_away).toBeUndefined();
  });

  it("the window feed leaves the viewed day to the day feed", () => {
    const viewed = "2026-10-02";
    applyCollectionFeed("changeStories", { stories: [], covered_from: window.from_date, complete: true }, selectStories, storySyncOpts(scope, window, viewed));
    expect(stories().kept).toBeDefined();
    expect(stories().merged_away).toBeDefined();
    expect(stories().old_day).toBeUndefined();
  });

  it("an all-repositories answer prunes across the team's repositories only", () => {
    applyCollectionFeed("changeStories", { stories: [story("kept", "2026-10-02")], covered_from: "2026-10-02", complete: true }, selectStories, storySyncOpts({ teamId: TEAM }, window));
    expect(stories().other_repo).toBeUndefined();
    expect(stories().other_team).toBeDefined();
  });
});

describe("edition feed", () => {
  const edition = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
    _id: id, team_id: TEAM, repository: REPO, scope: "day", date, narrative: "", generated_at: 1, ...extra,
  });

  beforeEach(() => {
    useInboxStore.setState({ changeEditions: {}, pending: {} } as any);
    useInboxStore.getState().syncTable("changeEditions", [
      edition("d1", "2026-10-01"),
      edition("gone", "2026-10-02"),
      edition("week", "2026-09-28", { scope: "week" }),
      edition("before", "2026-09-01"),
    ]);
  });

  it("an answer that lacks an edition removes nothing", () => {
    applyCollectionFeed("changeEditions", [edition("d1", "2026-10-01", { narrative: "new" })], undefined);
    const rows = useInboxStore.getState().changeEditions as Record<string, any>;
    expect(Object.keys(rows).sort()).toEqual(["before", "d1", "gone", "week"]);
    expect(rows.d1.narrative).toBe("new");
    expect(Object.keys(useInboxStore.getState().pending as Record<string, any>)).toHaveLength(0);
  });
});

describe("live strip feed", () => {
  it("is a snapshot: a surface missing from the answer leaves", () => {
    useInboxStore.setState({ changeLive: {}, pending: {} } as any);
    const tile = (surface: string) => ({ _id: `${TEAM}|${REPO}|${surface}`, team_id: TEAM, repository: REPO, surface, sha: "abc", at: 1, kind: "release", waiting: 0, waiting_exact: true });
    useInboxStore.getState().syncTable("changeLive", [tile("cli"), tile("desktop")]);
    useInboxStore.getState().syncTable("changeLive", [tile("cli")]);
    expect(Object.keys(useInboxStore.getState().changeLive as Record<string, any>)).toEqual([`${TEAM}|${REPO}|cli`]);
    // A snapshot leaves no tombstone, so the surface comes back when it ships again.
    useInboxStore.getState().syncTable("changeLive", [tile("cli"), tile("desktop")]);
    expect(Object.keys(useInboxStore.getState().changeLive as Record<string, any>)).toHaveLength(2);
  });
});
