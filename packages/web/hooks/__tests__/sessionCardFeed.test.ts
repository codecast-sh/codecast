// The inbox's pull request feed, applied the way its feeders apply it
// (applyCollectionFeed with the hook's own options): a slim answer keeps what
// a fuller feed cached, an answer prunes only the sessions it says it is
// complete for, and a pruned link comes back when a later answer carries it.
import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { applyCollectionFeed } from "../useSyncCollection";
import { CARD_PR_OPTS, LINK_OPTS } from "../useSyncTimeline";
import { isFullPullRequest, sessionPullRequests } from "../../lib/sessionPullRequests";
import { applyUpdatesToStore } from "../../store/syncReplication";

const pr = (id: string, number: number, extra: Record<string, unknown> = {}) => ({ _id: id, team_id: "t1", repository: "acme/app", number, title: `PR ${number}`, state: "open", ...extra });
const link = (id: string, prId: string, conv: string, tier = "committed") => ({ _id: id, pull_request_id: prId, conversation_id: conv, tier });
const answer = (links: any[], prs: any[], answered: string[]) => ({ links, pull_requests: prs, answered });
const apply = (d: any) => {
  applyCollectionFeed("pullRequests", d, CARD_PR_OPTS.select);
  applyCollectionFeed("pullRequestSessions", d, LINK_OPTS.select, LINK_OPTS.syncOpts);
};
const numbers = (conv: string) => sessionPullRequests(useInboxStore.getState() as any, conv).map((p) => p.number);

describe("session card pull request feed", () => {
  beforeEach(() => {
    useInboxStore.setState({ pullRequests: {}, pullRequestSessions: {}, pending: {} } as any);
  });

  it("lays the chip fields over a cached full row, and a row nothing fuller wrote has no body", () => {
    useInboxStore.getState().syncTable("pullRequests", [pr("p1", 1, { body: "full", files: [{ filename: "a" }], linked_session_ids: ["c1"], checks_state: "pending" })], { isDelta: true });
    apply(answer([link("l1", "p1", "c1"), link("l2", "p2", "c1")], [pr("p1", 1, { checks_state: "success" }), pr("p2", 2)], ["c1"]));
    const rows = useInboxStore.getState().pullRequests as Record<string, any>;
    expect(rows.p1).toMatchObject({ body: "full", files: [{ filename: "a" }], checks_state: "success" });
    expect(rows.p1.body).toBe("full");
    expect(rows.p2.body).toBeUndefined();
    expect(numbers("c1")).toEqual([2, 1]);
  });

  it("prunes a removed link of an answered session, and brings it back when an answer carries it again", () => {
    apply(answer([link("l1", "p1", "c1"), link("l2", "p2", "c1")], [pr("p1", 1), pr("p2", 2)], ["c1"]));
    apply(answer([link("l1", "p1", "c1")], [pr("p1", 1)], ["c1"]));
    expect(numbers("c1")).toEqual([1]);
    apply(answer([link("l1", "p1", "c1"), link("l2", "p2", "c1")], [pr("p1", 1), pr("p2", 2)], ["c1"]));
    expect(numbers("c1")).toEqual([2, 1]);
  });

  it("never prunes a session the answer was cut short for", () => {
    apply(answer([link("l1", "p1", "c1"), link("l2", "p2", "c2")], [pr("p1", 1), pr("p2", 2)], ["c1", "c2"]));
    apply(answer([link("l1", "p1", "c1")], [pr("p1", 1)], ["c1"]));
    expect(numbers("c2")).toEqual([2]);
  });

  it("a follower keeps its full row when the host replicates a chip-only one", () => {
    const full = pr("p1", 1, { body: "full", files: [{ filename: "a" }], commits: [{ sha: "x" }], checks_state: "pending", linked_session_ids: ["c1"], author_github_username: "ada", head_ref: "feat", additions: 3 });
    useInboxStore.getState().syncTable("pullRequests", [full], { isDelta: true });
    applyUpdatesToStore([{ key: "pullRequests", upserts: [pr("p1", 1, { checks_state: "success" })] } as any]);
    const row = (useInboxStore.getState().pullRequests as Record<string, any>).p1;
    expect(row).toMatchObject({ ...full, checks_state: "success" });
    expect(isFullPullRequest(row)).toBe(true);
    // The host's whole row, its detail days old and its checks cleared: only
    // its chip fields land over this window's own full row.
    applyUpdatesToStore([{ key: "pullRequests", upserts: [{ ...full, body: "stale", files: [], checks: undefined, checks_state: "failure" }] } as any]);
    const after = (useInboxStore.getState().pullRequests as Record<string, any>).p1;
    expect(after).toMatchObject({ body: "full", files: [{ filename: "a" }], checks_state: "failure" });
    // A row this window does not hold lands as sent.
    applyUpdatesToStore([{ key: "pullRequests", upserts: [pr("p7", 7, { body: "new" })] } as any]);
    expect((useInboxStore.getState().pullRequests as Record<string, any>).p7.body).toBe("new");
  });

  it("a chip push never releases a field this window wrote and the server has not echoed", () => {
    useInboxStore.getState().syncTable("pullRequests", [pr("p1", 1, { body: "full", shepherd_enabled: false })], { isDelta: true });
    useInboxStore.setState((st: any) => ({
      pullRequests: { ...st.pullRequests, p1: { ...st.pullRequests.p1, shepherd_enabled: true } },
      pending: { ...st.pending, "pullRequests:p1:shepherd_enabled": { type: "field", value: true } },
    }) as any);
    apply(answer([link("l1", "p1", "c1")], [pr("p1", 1, { checks_state: "success" })], ["c1"]));
    const st = useInboxStore.getState() as any;
    expect(st.pending["pullRequests:p1:shepherd_enabled"]).toBeDefined();
    expect(st.pullRequests.p1.shepherd_enabled).toBe(true);
    expect(st.pullRequests.p1.checks_state).toBe("success");
  });
});
