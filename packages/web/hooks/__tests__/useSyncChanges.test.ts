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
import { changesWindow, liveScope, selectStories, storySessionsScope, storySyncOpts, worksScope } from "../useSyncChanges";

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

  it("every Changes feed is a delta: windows by day, the live strip and In the works by repository", () => {
    expect(REGISTRY_SYNC_OPTS.changeStories?.isDelta).toBe(true);
    expect(REGISTRY_SYNC_OPTS.changeEditions?.isDelta).toBe(true);
    expect(REGISTRY_SYNC_OPTS.changeLive?.isDelta).toBe(true);
    expect(REGISTRY_SYNC_OPTS.changeWorks?.isDelta).toBe(true);
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
  it("a surface missing from its repository's answer leaves; another repository's surfaces stay cached", () => {
    useInboxStore.setState({ changeLive: {}, pending: {} } as any);
    const tile = (surface: string, repository = REPO) => ({ _id: `${TEAM}|${repository}|${surface}`, team_id: TEAM, repository, surface, sha: "abc", at: 1, kind: "release", waiting: 0, waiting_exact: true });
    const feed = (repository: string, rows: any[]) => applyCollectionFeed("changeLive", rows, undefined, undefined, liveScope({ teamId: TEAM, repository }));
    feed(REPO, [tile("cli"), tile("desktop")]);
    feed("acme/web", [tile("web", "acme/web")]);
    feed(REPO, [tile("cli")]);
    expect(Object.keys(useInboxStore.getState().changeLive as Record<string, any>).sort()).toEqual([`${TEAM}|acme/web|web`, `${TEAM}|${REPO}|cli`]);
    // The drop leaves no tombstone, so the surface comes back when it ships again.
    feed(REPO, [tile("cli"), tile("desktop")]);
    expect(Object.keys(useInboxStore.getState().changeLive as Record<string, any>)).toHaveLength(3);
  });
});

describe("in the works feed", () => {
  const stuck = (conv: string, repository?: string) => ({ _id: `stuck:${conv}`, team_id: TEAM, kind: "stuck", conversation_id: conv, headline: conv, outcome_type: "blocked", at: 1, ...(repository ? { repository } : {}) });
  const review = (n: number, repository: string) => ({ _id: `review:pr${n}`, team_id: TEAM, kind: "review", pr_id: `pr${n}`, repository, number: n, title: `PR ${n}`, url: "", draft: false, checks_state: null, review_decision: null, head_ref: null, author_github_username: "a", updated_at: 1 });
  const feed = (repository: string | undefined, rows: any[]) =>
    applyCollectionFeed("changeWorks", rows, undefined, undefined, worksScope({ teamId: TEAM, repository }));
  const ids = () => Object.keys(useInboxStore.getState().changeWorks as Record<string, any>).sort();

  it("a repository's answer replaces only its own rows, so returning to another repository paints from cache", () => {
    useInboxStore.setState({ changeWorks: {}, pending: {} } as any);
    feed(REPO, [stuck("a", REPO), review(1, REPO)]);
    feed("acme/web", [stuck("w", "acme/web"), review(2, "acme/web")]);
    expect(ids()).toEqual(["review:pr1", "review:pr2", "stuck:a", "stuck:w"]);
    // The first repository's stuck session moved on: only its row leaves.
    feed(REPO, [review(1, REPO)]);
    expect(ids()).toEqual(["review:pr1", "review:pr2", "stuck:w"]);
    // It is stuck again later: no tombstone keeps it out.
    feed(REPO, [stuck("a", REPO), review(1, REPO)]);
    expect(ids()).toContain("stuck:a");
  });
});

describe("story sessions feed", () => {
  const row = (storyId: string, conv: string, extra: Record<string, unknown> = {}) => ({
    _id: `${storyId}|${conv}`, team_id: TEAM, story_id: storyId, conversation_id: conv, headline: conv, summary: null, turns: [], ...extra,
  });
  const rows = () => useInboxStore.getState().changeStorySessions as Record<string, any>;

  it("is registered as a shared delta feed", () => {
    expect(COLLECTION_STORE_KEYS).toContain("changeStorySessions");
    expect(HYDRATION_DEFERRED_KEYS).toContain("changeStorySessions");
    expect(REPLICATION_CLASSIFICATION.changeStorySessions).toBe("shared");
    expect(REGISTRY_SYNC_OPTS.changeStorySessions?.isDelta).toBe(true);
    expect(REGISTERED_FEEDS["changesQueries.storySessions"]).toBe("changeStorySessions");
  });

  it("two open drawers keep each other's rows; a story's answer replaces its own rows without a tombstone", () => {
    useInboxStore.setState({ changeStorySessions: {}, pending: {} } as any);
    const feed = (storyId: string, data: any[]) =>
      applyCollectionFeed("changeStorySessions", data, undefined, undefined, storySessionsScope(storyId));
    const turns = [{ ask: "fix it", did: ["fixed it"] }];
    feed("s1", [row("s1", "c1", { turns }), row("s1", "c2")]);
    feed("s2", [row("s2", "c3")]);
    expect(Object.keys(rows()).sort()).toEqual(["s1|c1", "s1|c2", "s2|c3"]);

    // c2 went private and c1 narrowed to summary: c2's headline leaves the cache, c1 loses its turns.
    feed("s1", [row("s1", "c1", { turns: [] })]);
    expect(rows()["s1|c1"].turns).toEqual([]);
    expect(rows()["s1|c2"]).toBeUndefined();
    expect(rows()["s2|c3"]).toBeDefined();
    expect(Object.keys(pending())).toHaveLength(0);

    // Shared again, it comes back.
    feed("s1", [row("s1", "c1"), row("s1", "c2")]);
    expect(rows()["s1|c2"]).toBeDefined();
  });
});
