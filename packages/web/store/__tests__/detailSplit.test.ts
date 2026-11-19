import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { CLIENT_SYNC_REGISTRY, REPLICATION_CLASSIFICATION, collectionRowHydrator } from "../clientSyncRegistry";
import { COLLECTION_RETENTION, MAX_CACHED_PULL_REQUEST_DETAILS, MAX_CACHED_TASK_THREADS } from "../cacheRetention";
import { applyPullRequestAnswer } from "../../hooks/useSyncTimeline";
import { holdTaskThreads } from "../../hooks/useSyncTasks";
import {
  CACHED_AT_GRAIN_MS, DETAIL_ROW_CAPS, joinPullRequestDetail, pinDetailRows, pullRequestDetailRow, resetDetailPins, taskThreadStale, thinPullRequestRow, thinTaskRow, withTaskComments,
} from "../../lib/detailRows";
import { _resetSnapshotLedger, deleteAllowed } from "../idbCollectionDiff";

// The list rows every window holds carry none of the fields only an opened
// object draws (lib/detailRows): a task's comments, a pull request's files,
// commits and checks. They live in taskComments and pullRequestDetails, which
// hold a row only for what a surface opened.

const id = (c: string) => c.repeat(32);
const state = () => useInboxStore.getState() as any;

const comment = (n: number) => ({ _id: `c${n}`, author: "Ada", text: `note ${n}`, created_at: n });
const task = (c: string, comments: any[] | undefined, extra: Record<string, unknown> = {}) => ({
  _id: id(c), short_id: `ct-${c}`, title: `task ${c}`, status: "open", updated_at: 1, ...(comments ? { comments } : {}), ...extra,
});

const files = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" }];
const commits = [{ sha: "abc", message: "Fix", author_name: "Ada", committed_at: 1, url: "u" }];
const checks = [{ name: "ci", status: "completed", conclusion: "failure", external_id: "1", updated_at: 1, url: "u" }];
const pr = (c: string, extra: Record<string, unknown> = {}) => ({
  _id: id(c), repository: "acme/app", number: 7, title: "Seven", body: "why", state: "open", checks_state: "failure",
  updated_at: 1, changed_files: 1, commits_count: 1, files, commits, checks, ...extra,
});

beforeEach(() => {
  useInboxStore.setState({ tasks: {}, taskComments: {}, pullRequests: {}, pullRequestDetails: {}, pending: {}, syncRole: "host" } as any);
  resetDetailPins();
  _resetSnapshotLedger();
});

describe("tasks: comments stay off the list rows", () => {
  it("every way a row enters the collection lands it thin, with the count", () => {
    state().syncTable("tasks", [task("a", [comment(1), comment(2)]), task("b", [])], { isDelta: true });
    state().syncRecord("tasks", id("c"), task("c", [comment(3)]));
    for (const c of ["a", "b", "c"]) expect(state().tasks[id(c)].comments).toBeUndefined();
    expect(state().tasks[id("a")].comment_count).toBe(2);
    expect(state().tasks[id("b")].comment_count).toBe(0);
    expect(state().tasks[id("c")].comment_count).toBe(1);
    // Nothing opened these tasks: no thread is held for them.
    expect(state().taskComments).toEqual({});
  });

  it("a push that carries the thread refreshes the threads the store holds, and only those", () => {
    holdTaskThreads([task("a", [comment(1)], { last_comment_at: 1 })]);
    expect(state().taskComments[id("a")].comments).toEqual([comment(1)]);
    state().syncTable("tasks", [
      task("a", [comment(1), comment(2)], { last_comment_at: 2, updated_at: 2 }),
      task("b", [comment(9)], { last_comment_at: 9 }),
    ], { isDelta: true });
    expect(state().taskComments[id("a")].comments).toEqual([comment(1), comment(2)]);
    expect(state().taskComments[id("a")].as_of).toBe(2);
    expect(state().taskComments[id("b")]).toBeUndefined();
  });

  it("a row whose only change is its comments keeps its identity, and an unchanged thread keeps its own", () => {
    holdTaskThreads([task("a", [comment(1)], { last_comment_at: 1 })]);
    const row = state().tasks[id("a")];
    const thread = state().taskComments[id("a")];
    // The same answer again, as fresh objects (every push is a new decode).
    state().syncTable("tasks", [task("a", [comment(1)], { last_comment_at: 1 })], { isDelta: true });
    expect(state().tasks[id("a")]).toBe(row);
    expect(state().taskComments[id("a")]).toBe(thread);
  });

  it("a row that arrives without the thread keeps the count it had", () => {
    state().syncTable("tasks", [task("a", [comment(1), comment(2)])], { isDelta: true });
    state().syncTable("tasks", [task("a", undefined, { title: "renamed", updated_at: 5 })], { isDelta: true });
    expect(state().tasks[id("a")].title).toBe("renamed");
    expect(state().tasks[id("a")].comment_count).toBe(2);
  });

  it("a thread is behind when the task row's newest comment is newer than its stamp", () => {
    holdTaskThreads([task("a", [comment(1)], { last_comment_at: 10 })]);
    const thread = state().taskComments[id("a")];
    expect(taskThreadStale({ last_comment_at: 10 }, thread)).toBe(false);
    expect(taskThreadStale({ last_comment_at: 11 }, thread)).toBe(true);
    expect(taskThreadStale({ last_comment_at: 10 }, undefined)).toBe(true);
    // A task from before last_comment_at existed is read once and then held.
    expect(taskThreadStale({}, undefined)).toBe(true);
    expect(taskThreadStale({}, { ...thread, as_of: 0 })).toBe(false);
  });

  it("a list that reads threads gets them laid on its rows, each joined row stable while its inputs are", () => {
    holdTaskThreads([task("a", [comment(1)], { cause: {} }), task("b", [comment(2)])]);
    const rows = [state().tasks[id("a")], state().tasks[id("b")], task("c", undefined, { cause: {} })];
    const wants = (t: any) => !!t.cause;
    const joined = withTaskComments(rows, state().taskComments, wants);
    expect(joined[0].comments).toEqual([comment(1)]);
    expect(joined[1]).toBe(rows[1]); // not asked for
    expect(joined[2]).toBe(rows[2]); // no thread held yet
    expect(withTaskComments(rows, state().taskComments, wants)[0]).toBe(joined[0]);
  });

  it("rows cached by a build that kept the thread on the row shed it at hydration", () => {
    const hydrate = collectionRowHydrator("tasks")!;
    const cached = task("a", [comment(1), comment(2)]);
    const kept = hydrate(cached, { pending: {} });
    expect(kept.comments).toBeUndefined();
    expect(kept.comment_count).toBe(2);
    const thin = task("b", undefined);
    expect(hydrate(thin, { pending: {} })).toBe(thin);
    expect(thinTaskRow(thin)).toBe(thin);
  });
});

describe("pull requests: files, commits and checks stay off the list rows", () => {
  it("a full row from any feed lands thin and writes no detail", () => {
    state().syncTable("pullRequests", [pr("p")], { isDelta: true });
    const row = state().pullRequests[id("p")];
    expect(row.files).toBeUndefined();
    expect(row.commits).toBeUndefined();
    expect(row.checks).toBeUndefined();
    expect(row).toMatchObject({ title: "Seven", body: "why", changed_files: 1, commits_count: 1, checks_state: "failure" });
    expect(state().pullRequestDetails).toEqual({});
  });

  it("the surface that opens a pull request writes its detail, and later pushes keep it current", () => {
    applyPullRequestAnswer(pr("p"));
    expect(state().pullRequests[id("p")].files).toBeUndefined();
    expect(state().pullRequestDetails[id("p")]).toMatchObject({ files, commits, checks, checks_state: "failure" });
    const detail = state().pullRequestDetails[id("p")];

    // The same answer again keeps both rows' identities (nothing to repaint).
    applyPullRequestAnswer(pr("p"));
    expect(state().pullRequestDetails[id("p")]).toBe(detail);

    // Another feed's full row (the repository timeline) refreshes the held detail.
    const passed = [{ ...checks[0], conclusion: "success" }];
    state().syncTable("pullRequests", [pr("p", { checks: passed, checks_state: "success", updated_at: 2 })], { isDelta: true });
    expect(state().pullRequestDetails[id("p")].checks).toEqual(passed);
    expect(state().pullRequestDetails[id("p")].checks_state).toBe("success");
  });

  it("the page's read lays the detail on the row, and hides checks read under another state", () => {
    applyPullRequestAnswer(pr("p"));
    const row = state().pullRequests[id("p")];
    const detail = state().pullRequestDetails[id("p")];
    expect(joinPullRequestDetail(row, detail)).toMatchObject({ files, commits, checks });
    expect(joinPullRequestDetail(row, undefined)).toBe(row);
    // The inbox chip feed moved the state on the list row; the checks are older.
    const moved = { ...row, checks_state: "success" };
    expect(joinPullRequestDetail(moved, detail).checks).toBeUndefined();
    expect(joinPullRequestDetail(moved, detail).files).toEqual(files);
  });

  it("a chip row carries no detail and is stored as it came", () => {
    const chip = { _id: id("p"), repository: "acme/app", number: 7, title: "Seven", state: "open", checks_state: "pending" };
    expect(thinPullRequestRow(chip)).toBe(chip);
    expect(pullRequestDetailRow(chip, undefined, 1)).toBeNull();
  });

  it("rows cached by a build that kept the detail on the row shed it at hydration", () => {
    const hydrate = collectionRowHydrator("pullRequests")!;
    const kept = hydrate(pr("p"), { pending: {} });
    expect(kept.files).toBeUndefined();
    expect(kept.commits).toBeUndefined();
    expect(kept.checks).toBeUndefined();
    expect(kept.body).toBe("why");
  });

  it("a detail keeps its last-opened stamp inside the grain, so a push does not rewrite it to disk", () => {
    const first = pullRequestDetailRow(pr("p"), undefined, 1_000)!;
    expect(first._cachedAt).toBe(1_000);
    expect(pullRequestDetailRow(pr("p"), first, 1_000 + CACHED_AT_GRAIN_MS - 1)!._cachedAt).toBe(1_000);
    expect(pullRequestDetailRow(pr("p"), first, 1_000 + CACHED_AT_GRAIN_MS)!._cachedAt).toBe(1_000 + CACHED_AT_GRAIN_MS);
  });
});

describe("the detail collections' registration", () => {
  it("threads replicate between windows; a pull request's detail is each window's own", () => {
    expect(REPLICATION_CLASSIFICATION.taskComments).toBe("shared");
    expect(REPLICATION_CLASSIFICATION.pullRequestDetails).toBe("local");
    // A local key a follower window may write to disk itself.
    expect((CLIENT_SYNC_REGISTRY.pullRequestDetails.persistence as any).perWindow).toBe(true);
  });

  it("both are bounded at hydration by last-open recency", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: `r${i}`, _cachedAt: now - i }));
    const threads = COLLECTION_RETENTION.taskComments(rows(MAX_CACHED_TASK_THREADS + 5), now);
    expect(threads.keep).toHaveLength(MAX_CACHED_TASK_THREADS);
    expect(threads.drop).toHaveLength(5);
    expect(threads.drop).toContain(`r${MAX_CACHED_TASK_THREADS + 4}`); // the oldest go
    const details = COLLECTION_RETENTION.pullRequestDetails(rows(MAX_CACHED_PULL_REQUEST_DETAILS + 3), now);
    expect(details.keep).toHaveLength(MAX_CACHED_PULL_REQUEST_DETAILS);
    // Past the TTL a row goes whatever the count.
    const old = COLLECTION_RETENTION.pullRequestDetails([{ _id: "old", _cachedAt: now - 31 * 24 * 60 * 60 * 1000 }], now);
    expect(old.drop).toEqual(["old"]);
  });
});

// The caps once held only at boot: a window left open kept the detail of
// every pull request and every line project it ever showed (13 pull request
// details and 1,501 threads in a review's run), and held threads went on to
// every other window.
describe("the caps hold while the window lives", () => {
  const cid = (n: number) => `k57${String(n).padStart(29, "0")}`;
  const detail = (n: number, at: number) => ({ _id: cid(n), files, checks_state: null, _cachedAt: at });
  const thread = (n: number, at: number, comments: any[] = []) => ({ _id: cid(n), comments, as_of: 0, _cachedAt: at });
  const PR_CAP = DETAIL_ROW_CAPS.pullRequestDetails;
  const openPrs = (from: number, count: number) => {
    for (let n = from; n < from + count; n++) state().syncTable("pullRequestDetails", [detail(n, n)]);
  };

  it("opening one pull request after another keeps the newest, never more than the cap", () => {
    openPrs(1, PR_CAP + 5);
    const held = Object.keys(state().pullRequestDetails);
    expect(held).toHaveLength(PR_CAP);
    // The least recently opened went first.
    for (let n = 1; n <= 5; n++) expect(state().pullRequestDetails[cid(n)]).toBeUndefined();
    expect(state().pullRequestDetails[cid(PR_CAP + 5)]).toBeDefined();
  });

  it("never drops what a surface has on screen, and drops it once that surface closes", () => {
    openPrs(1, PR_CAP);
    const release = pinDetailRows("pullRequestDetails", [cid(1)]); // the oldest, still open
    openPrs(PR_CAP + 1, 3);
    expect(state().pullRequestDetails[cid(1)]).toBeDefined();
    expect(Object.keys(state().pullRequestDetails)).toHaveLength(PR_CAP);
    release();
    openPrs(PR_CAP + 4, 1);
    expect(state().pullRequestDetails[cid(1)]).toBeUndefined();
  });

  it("holds more than the cap only while every row over it is in use or just arrived", () => {
    openPrs(1, PR_CAP);
    const release = pinDetailRows("pullRequestDetails", Array.from({ length: PR_CAP }, (_, i) => cid(i + 1)));
    // The row this write brought is kept: its reader has not mounted yet,
    // and its query will not send the row again.
    openPrs(PR_CAP + 1, 1);
    expect(Object.keys(state().pullRequestDetails)).toHaveLength(PR_CAP + 1);
    release();
    openPrs(PR_CAP + 2, 1);
    expect(Object.keys(state().pullRequestDetails)).toHaveLength(PR_CAP);
    expect(state().pullRequestDetails[cid(PR_CAP + 2)]).toBeDefined();
    expect(state().pullRequestDetails[cid(1)]).toBeUndefined();
  });

  it("one write of more rows than the cap is cut to the cap", () => {
    // A follower taking the host's snapshot: every row is new to it.
    state().syncTable("pullRequestDetails", Array.from({ length: PR_CAP + 4 }, (_, i) => detail(i + 1, i + 1)));
    expect(Object.keys(state().pullRequestDetails)).toHaveLength(PR_CAP);
    expect(state().pullRequestDetails[cid(1)]).toBeUndefined();
    expect(state().pullRequestDetails[cid(PR_CAP + 4)]).toBeDefined();
  });

  it("a line's worth of threads past the cap evicts the oldest threads, never one with an unsent comment", () => {
    const cap = DETAIL_ROW_CAPS.taskComments;
    // The oldest thread holds an optimistic comment the server has not echoed.
    state().syncTable("taskComments", [thread(0, 0, [{ _id: "temp_1", text: "hello", created_at: 1 }])]);
    state().syncTable("taskComments", Array.from({ length: cap - 1 }, (_, i) => thread(i + 1, i + 1)));
    expect(Object.keys(state().taskComments)).toHaveLength(cap);
    state().syncTable("taskComments", Array.from({ length: 40 }, (_, i) => thread(cap + i, cap + i)));
    expect(Object.keys(state().taskComments)).toHaveLength(cap);
    expect(state().taskComments[cid(0)]).toBeDefined(); // the unsent comment
    expect(state().taskComments[cid(1)]).toBeUndefined(); // the oldest without one
    expect(state().taskComments[cid(40)]).toBeUndefined();
    expect(state().taskComments[cid(41)]).toBeDefined();
  });

  it("an evicted row may leave disk in the window that writes it, and only there", () => {
    openPrs(1, PR_CAP + 1);
    expect(deleteAllowed("pullRequestDetails", cid(1), {})).toBe(true);
    expect(deleteAllowed("pullRequestDetails", cid(2), {})).toBe(false);

    // A follower holds shared threads in memory and never writes them: it
    // evicts from its store and leaves the disk to the host.
    _resetSnapshotLedger();
    useInboxStore.setState({ syncRole: "follower" } as any);
    const cap = DETAIL_ROW_CAPS.taskComments;
    state().syncTable("taskComments", Array.from({ length: cap + 1 }, (_, i) => thread(i, i)));
    expect(Object.keys(state().taskComments)).toHaveLength(cap);
    expect(deleteAllowed("taskComments", cid(0), {})).toBe(false);
  });

  it("the host evicting a thread does not take it from a follower that has it on screen", () => {
    state().syncTable("taskComments", [thread(1, 1), thread(2, 2)]);
    const release = pinDetailRows("taskComments", [cid(1)]);
    state()._applyReplicatedRemovals("taskComments", [cid(1), cid(2)]);
    expect(state().taskComments[cid(1)]).toBeDefined();
    expect(state().taskComments[cid(2)]).toBeUndefined();
    release();
  });

  it("the host evicting a thread does not take a follower's unsent comment with it", () => {
    // The follower wrote a comment and closed the thread: nothing pins it, and
    // the optimistic comment (a temp_ id) has no pending entry of its own.
    const sent = thread(1, 1);
    const unsent = { ...thread(2, 2), comments: [...thread(2, 2).comments, { _id: "temp_c_1", content: "typed here, not echoed yet" }] };
    state().syncTable("taskComments", [sent, unsent]);
    state()._applyReplicatedRemovals("taskComments", [cid(1), cid(2)]);
    expect(state().taskComments[cid(1)]).toBeUndefined();
    expect(state().taskComments[cid(2)]?.comments.some((c: any) => c._id === "temp_c_1")).toBe(true);
  });
});
