import { describe, expect, it } from "bun:test";
import { isOldSession, partitionOldSessions, categorizeSessions, flatViewSessions, type InboxSession } from "../inboxStore";

// The "show old sessions" toggle is a pure CLIENT-SIDE filter. "Old" = a
// top-level session the live (recent) inbox subscription no longer returns but
// the never-prune cache still holds (the completeness crawl backfilled it).
// Before this, the toggle only changed a server query arg, which the
// never-prune cache + crawl undid — so hiding did nothing and toggling spun the
// sync chip. These tests pin the local classification that replaced it.

// A real Convex id is 32 lowercase base32 chars; isConvexId checks that shape.
const cid = (n: number) => `j${String(n).padStart(31, "0")}`;

function sess(overrides: Partial<InboxSession> & { _id: string }): InboxSession {
  return {
    _id: overrides._id,
    title: "s",
    updated_at: 1,
    message_count: 1,
    ...overrides,
  } as InboxSession;
}

const RECENT = cid(1);
const OLD = cid(2);

describe("isOldSession", () => {
  const live = new Set([RECENT]);

  it("a cached top-level session absent from the live set is old", () => {
    expect(isOldSession(sess({ _id: OLD }), live)).toBe(true);
  });

  it("a session still in the live set is not old", () => {
    expect(isOldSession(sess({ _id: RECENT }), live)).toBe(false);
  });

  it("optimistic stubs (non-Convex id) are never old", () => {
    expect(isOldSession(sess({ _id: "local-stub-123" }), live)).toBe(false);
  });

  it("subagents ride their parent, never counted old", () => {
    expect(isOldSession(sess({ _id: OLD, parent_conversation_id: RECENT }), live)).toBe(false);
  });

  it("pinned, focused, and dismissed/stashed rows are never old", () => {
    expect(isOldSession(sess({ _id: OLD, is_pinned: true }), live)).toBe(false);
    expect(isOldSession(sess({ _id: OLD }), live, OLD)).toBe(false);
    expect(isOldSession(sess({ _id: OLD, inbox_dismissed_at: 5 }), live)).toBe(false);
    expect(isOldSession(sess({ _id: OLD, inbox_stashed_at: 5 }), live)).toBe(false);
  });
});

describe("partitionOldSessions", () => {
  const sessions = { [RECENT]: sess({ _id: RECENT }), [OLD]: sess({ _id: OLD }) };
  const live = new Set([RECENT]);

  it("an empty live set means nothing is old yet — never blank a cold open", () => {
    const r = partitionOldSessions(sessions, new Set(), false);
    expect(r.oldCount).toBe(0);
    expect(Object.keys(r.visibleSessions)).toHaveLength(2);
  });

  it("show-all keeps every row but still reports the old count for the badge", () => {
    const r = partitionOldSessions(sessions, live, true);
    expect(r.oldCount).toBe(1);
    expect(Object.keys(r.visibleSessions).sort()).toEqual([RECENT, OLD].sort());
  });

  it("hide drops only the old rows, instantly and without touching the server", () => {
    const r = partitionOldSessions(sessions, live, false);
    expect(r.oldCount).toBe(1);
    expect(Object.keys(r.visibleSessions)).toEqual([RECENT]);
  });

  it("returns the same map ref when nothing is old (no needless re-render)", () => {
    const allLive = new Set([RECENT, OLD]);
    const r = partitionOldSessions(sessions, allLive, false);
    expect(r.oldCount).toBe(0);
    expect(r.visibleSessions).toBe(sessions);
  });
});

// Regression (ct-37163): hiding old sessions used to ORPHAN-PROMOTE subagents.
// The server only emits a subagent alongside its parent, so a subagent rides its
// parent in the cache. partitionOldSessions drops an OLD top-level parent but
// keeps the child (it has a parent id, so isOldSession skips it). categorizeSessions
// then saw the child with no parent in the set and promoted it to a loose
// top-level NEEDS INPUT card — which (a) only appeared when "show old" was OFF
// (parent gone) and (b) couldn't be hidden by the subagent toggle (it wasn't in
// subsByParent). The fix: a parentless subagent is never a flat card; it nests
// when its parent is present, and is dropped otherwise.
describe("hiding old must not promote a subagent to a loose card (ct-37163)", () => {
  const PARENT = OLD; // old top-level parent, backfilled by the completeness crawl
  const CHILD = cid(3); // its subagent — awaiting_input would land it in needsInput if loose
  const base: Record<string, InboxSession> = {
    [RECENT]: sess({ _id: RECENT, awaiting_input: true }),
    [PARENT]: sess({ _id: PARENT, awaiting_input: true }),
    [CHILD]: sess({ _id: CHILD, parent_conversation_id: PARENT, is_subagent: true, awaiting_input: true }),
  };
  const live = new Set([RECENT]); // PARENT + CHILD are absent from the live recent set → "old"
  const ids = (xs: InboxSession[]) => xs.map((x) => x._id);

  it("show-old ON: the child nests under its parent, never a loose needs-input card", () => {
    const { visibleSessions } = partitionOldSessions(base, live, true);
    const cat = categorizeSessions(visibleSessions, new Set());
    expect(ids(cat.subsByParent.get(PARENT) ?? [])).toContain(CHILD);
    expect(ids(cat.needsInput)).not.toContain(CHILD);
  });

  it("show-old OFF: dropping the old parent must NOT surface the orphaned child", () => {
    const { visibleSessions } = partitionOldSessions(base, live, false);
    const cat = categorizeSessions(visibleSessions, new Set());
    expect(ids(cat.needsInput)).not.toContain(PARENT); // old parent hidden
    expect(ids(cat.needsInput)).not.toContain(CHILD); // child rides it — not promoted
    expect(ids(cat.working)).not.toContain(CHILD);
    expect(ids(cat.newSessions)).not.toContain(CHILD);
  });

  it("a subagent whose parent is entirely absent (hard-deleted) is never promoted", () => {
    const cat = categorizeSessions({ [RECENT]: base[RECENT], [CHILD]: base[CHILD] }, new Set());
    expect(ids(cat.needsInput)).not.toContain(CHILD);
  });
});

// Agent-team teammates (spawned_by_conversation_id + agent_team_name, stamped
// by linkSpawnedBy) NEST under their lead like Task-tool subagents — but keep
// first-class semantics when the lead is absent: unlike a Task subagent they
// render as a normal flat card, never hidden, because a teammate is a real
// session someone may still need to answer. Forks (forked_from) and
// cast-spawn sessions (no team stamp) never nest.
describe("agent-team teammates nest under their lead", () => {
  const LEAD = cid(10);
  const MATE = cid(11);
  const ids = (xs: InboxSession[]) => xs.map((x) => x._id);
  const lead = sess({ _id: LEAD, awaiting_input: true, agent_team_name: "myteam", agent_name: "team-lead" });
  const mate = sess({
    _id: MATE,
    awaiting_input: true,
    spawned_by_conversation_id: LEAD,
    agent_team_name: "myteam",
    agent_name: "researcher",
  });

  it("lead present: the teammate nests under the lead and leaves the flat buckets", () => {
    const cat = categorizeSessions({ [LEAD]: lead, [MATE]: mate }, new Set());
    expect(ids(cat.subsByParent.get(LEAD) ?? [])).toContain(MATE);
    expect(ids(cat.needsInput)).toEqual([LEAD]);
  });

  it("lead absent: the teammate stays a normal flat card — never hidden like a Task-subagent orphan", () => {
    const cat = categorizeSessions({ [MATE]: mate }, new Set());
    expect(ids(cat.needsInput)).toContain(MATE);
  });

  it("spawned_by without a team stamp does not nest (cast spawn stays first-class)", () => {
    const spawned = sess({ _id: MATE, awaiting_input: true, spawned_by_conversation_id: LEAD });
    const cat = categorizeSessions({ [LEAD]: lead, [MATE]: spawned }, new Set());
    expect(cat.subsByParent.get(LEAD) ?? []).toHaveLength(0);
    expect(ids(cat.needsInput)).toContain(MATE);
  });

  it("forks never nest — they group in forksByParent only", () => {
    const fork = sess({ _id: MATE, awaiting_input: true, forked_from: LEAD });
    const cat = categorizeSessions({ [LEAD]: lead, [MATE]: fork }, new Set());
    expect(cat.subsByParent.get(LEAD) ?? []).toHaveLength(0);
    expect(ids(cat.forksByParent.get(LEAD) ?? [])).toContain(MATE);
    expect(ids(cat.needsInput)).toContain(MATE);
  });

  it("old partition: a teammate rides its LIVE lead, but ages out when the whole team is stale", () => {
    // Lead live, teammate outside the live window → not old (it nests under the lead).
    expect(isOldSession(mate, new Set([LEAD]))).toBe(false);
    // Neither in the live window → the teammate ages out like any session
    // (unlike a Task subagent, which is exempt outright).
    expect(isOldSession(mate, new Set([RECENT]))).toBe(true);
  });
});

// Regression (ct-38183): the flat (time / recent) views render every session as
// its own row in comparator order, so a subagent/teammate row landed wherever
// ITS activity sorted — stranded between unrelated cards while its
// recently-active parent sorted far above. flatViewSessions must hoist each
// child directly under its parent whenever the parent made the final list; a
// row whose parent is absent keeps its slot (same "parentless renders flat"
// semantics as categorizeSessions).
describe("flat views hoist subagent/teammate rows under their parent (ct-38183)", () => {
  const LEAD = cid(20);
  const MATE_A = cid(21);
  const MATE_B = cid(22);
  const UNRELATED = cid(23);
  const ids = (xs: InboxSession[]) => xs.map((x) => x._id);
  const team = (id: string, name: string, t: number) =>
    sess({
      _id: id,
      spawned_by_conversation_id: LEAD,
      agent_team_name: "myteam",
      agent_name: name,
      started_at: t,
      updated_at: t,
    });
  // The production shape: the lead worked recently (sorts to the top), its
  // teammates went quiet hours ago and sort next to an unrelated old card.
  const base: Record<string, InboxSession> = {
    [LEAD]: sess({ _id: LEAD, agent_team_name: "myteam", agent_name: "team-lead", started_at: 1000, updated_at: 5000 }),
    [UNRELATED]: sess({ _id: UNRELATED, started_at: 3000, updated_at: 3000 }),
    [MATE_A]: team(MATE_A, "researcher", 2000),
    [MATE_B]: team(MATE_B, "mapper", 1900),
  };
  const flatten = (sessions: Record<string, InboxSession>, mode: "time" | "recent", showSubagents = true) => {
    const cat = categorizeSessions(sessions, new Set());
    return flatViewSessions(cat.sorted, cat.subsByParent, { mode, showSubagents });
  };

  it("recent mode: teammates render directly under their lead, not at their own time slot", () => {
    expect(ids(flatten(base, "recent"))).toEqual([LEAD, MATE_A, MATE_B, UNRELATED]);
  });

  it("time mode: same hoist on the creation-time order", () => {
    // Creation order alone would be UNRELATED(3000), MATE_A, MATE_B, LEAD(1000).
    expect(ids(flatten(base, "time"))).toEqual([UNRELATED, LEAD, MATE_A, MATE_B]);
  });

  it("Task-tool subagents hoist the same way", () => {
    const sub = sess({ _id: MATE_A, parent_conversation_id: LEAD, is_subagent: true, started_at: 2000, updated_at: 2000 });
    const withSub = { [LEAD]: base[LEAD], [UNRELATED]: base[UNRELATED], [MATE_A]: sub };
    expect(ids(flatten(withSub, "recent"))).toEqual([LEAD, MATE_A, UNRELATED]);
  });

  it("parent absent: a teammate keeps its comparator slot as a flat row", () => {
    const noLead = { [UNRELATED]: base[UNRELATED], [MATE_A]: base[MATE_A], [MATE_B]: base[MATE_B] };
    expect(ids(flatten(noLead, "recent"))).toEqual([UNRELATED, MATE_A, MATE_B]);
  });

  it("subagent toggle off still drops nested rows entirely", () => {
    expect(ids(flatten(base, "recent", false))).toEqual([LEAD, UNRELATED]);
  });
});
