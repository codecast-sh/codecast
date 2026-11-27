import { describe, expect, it } from "bun:test";
import { cardPriorityRankOf, chipFilterOpts, chipFilterSection, chipMatchesSession, computeChipCounts, priorityChipRows, priorityRankOfFromState, resolveComposeProjectPath, type InboxSession } from "../inboxStore";
import { priorityChipKey, priorityChipKeysOf, priorityTopNOfChipKey, projectAxisLabel, projectAxisNoun } from "../workProjects";

// The filter's Top 3 / 5 / 10: a session answers to `pr:<n>` on the folder
// chip axis when it serves one of the viewer's own n highest-ranked priorities
// in that priority's workspace, whichever workspace is active, so include,
// hide and ⇧-add work as they do for folders.

const ME = "user_me";
const row = (id: string, priority_id?: string, extra: Partial<InboxSession> = {}): InboxSession =>
  ({ _id: id.padEnd(32, "x"), session_id: id, updated_at: 1, project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", priority_id, ...extra }) as InboxSession;
const priority = (id: string, rank: number, workspace = "team:t1", user_id = ME) =>
  ({ _id: id, status: "active", ai_rank: rank, person_pos: null, workspace, last_active_at: 0, user_id, steps: [] });

// Ranks 1..12 in the active workspace, the viewer's #1 in another workspace, one a teammate's.
const priorities: Record<string, ReturnType<typeof priority>> = {};
for (let r = 1; r <= 12; r++) priorities[`p${r}`] = priority(`p${r}`, r);
priorities.pElsewhere = priority("pElsewhere", 1, "team:t2");
priorities.pTheirs = priority("pTheirs", 1, "team:t1", "user_them");

const sessions = [
  row("s1", "p1"), row("s3", "p3"), row("s4", "p4"), row("s7", "p7"), row("s12", "p12"),
  row("elsewhere", "pElsewhere"), row("theirs", "pTheirs"), row("none"),
];
const state = (extra: Record<string, unknown> = {}) => ({
  priorities,
  priorityRanks: { pElsewhere: { _id: "pElsewhere", workspace: "team:t2", rank: 1 } },
  sessions: Object.fromEntries(sessions.map((s) => [s._id, s])),
  currentUser: { _id: ME },
  clientState: { ui: { active_team_id: "t1" } },
  ...extra,
});
const visible = (filter: string, exclude = false, extra: Record<string, unknown> = {}) =>
  sessions
    .filter((s) => chipMatchesSession(s, chipFilterOpts(state({ activeProjectFilter: filter, chipFilterExclude: exclude, ...extra }) as any, {})))
    .map((s) => s.session_id);

describe("Top N keys", () => {
  it("a rank answers to every Top N at or above it", () => {
    expect(priorityChipKeysOf(1)).toEqual(["pr:3", "pr:5", "pr:10"]);
    expect(priorityChipKeysOf(4)).toEqual(["pr:5", "pr:10"]);
    expect(priorityChipKeysOf(10)).toEqual(["pr:10"]);
    expect(priorityChipKeysOf(11)).toEqual([]);
    expect(priorityChipKeysOf(null)).toEqual([]);
  });

  it("reads and names a key", () => {
    expect(priorityTopNOfChipKey(priorityChipKey(5))).toBe(5);
    expect(priorityTopNOfChipKey("pr:x")).toBeNull();
    expect(priorityTopNOfChipKey("app")).toBeNull();
    expect(projectAxisNoun("pr:3")).toBe("priority");
    expect(projectAxisLabel("pr:10", {}, () => undefined)).toBe("Top 10");
  });
});

describe("Top N filter", () => {
  it("includes only sessions serving the viewer's own top N, in each workspace; a teammate's priority never counts", () => {
    expect(visible("pr:3")).toEqual(["s1", "s3", "elsewhere"]);
    expect(visible("pr:5")).toEqual(["s1", "s3", "s4", "elsewhere"]);
    expect(visible("pr:10")).toEqual(["s1", "s3", "s4", "s7", "elsewhere"]);
  });

  it("with another workspace active, a session on the viewer's #2 there still counts under Top 3", () => {
    const codecast = { pC1: priority("pC1", 1, "team:codecast"), pC2: priority("pC2", 2, "team:codecast"), pC3: priority("pC3", 3, "team:codecast"), pC4: priority("pC4", 4, "team:codecast"), pMate: priority("pMate", 1, "team:codecast", "user_them") };
    const rows = [row("onC2", "pC2"), row("onC4", "pC4"), row("onMate", "pMate")];
    const opts = chipFilterOpts(state({
      activeProjectFilter: "pr:3",
      priorities: { ...priorities, ...codecast },
      sessions: Object.fromEntries(rows.map((x) => [x._id, x])),
      clientState: { ui: { active_team_id: "union" } },
    }) as any, {});
    expect(rows.filter((x) => chipMatchesSession(x, opts)).map((x) => x.session_id)).toEqual(["onC2"]);
  });

  it("hiding Top 3 keeps everything else, unranked sessions included", () => {
    expect(visible("pr:3", true)).toEqual(["s4", "s7", "s12", "theirs", "none"]);
  });

  it("⇧-adds alongside a folder like any other key", () => {
    const other = row("other", undefined, { project_path: "/Users/me/src/other", git_root: "/Users/me/src/other" });
    const opts = chipFilterOpts(state({ activeProjectFilter: "pr:3", extraProjectFilters: [{ id: "other", path: null, exclude: false }] }) as any, {});
    expect([...sessions, other].filter((s) => chipMatchesSession(s, opts)).map((s) => s.session_id)).toEqual(["s1", "s3", "elsewhere", "other"]);
  });

  it("follows a re-rank: the reader is built from the state it is given", () => {
    const moved = { ...priorities, p7: priority("p7", 2), p3: priority("p3", 7) };
    expect(visible("pr:3", false, { priorities: moved })).toEqual(["s1", "s7", "elsewhere"]);
  });

  it("a cached rank for a priority no longer in the live rows never counts", () => {
    const { p2: _gone, ...live } = { ...priorities, p2: priority("p2", 2) };
    const stale = { p2: { _id: "p2", workspace: "team:t1", rank: 2 } };
    const extra = { priorities: live, priorityRanks: stale };
    const withS2 = [...sessions, row("s2", "p2")];
    const opts = chipFilterOpts(state({ activeProjectFilter: "pr:3", ...extra, sessions: Object.fromEntries(withS2.map((x) => [x._id, x])) }) as any, {});
    // p2 left, so p3 and p4 move up to ranks 2 and 3; s2's cached rank 2 is not read.
    expect(withS2.filter((x) => chipMatchesSession(x, opts)).map((x) => x.session_id)).toEqual(["s1", "s3", "s4", "elsewhere"]);
  });

  it("a filter with no Top N term never builds the rank reader", () => {
    expect(chipFilterOpts(state({ activeProjectFilter: "app" }) as any, {}).priorityRankOf).toBeUndefined();
  });
});

describe("Top N counts", () => {
  it("counts each Top N, smallest first, and nothing without a rank reader", () => {
    const rankOf = priorityRankOfFromState(state() as any);
    expect(priorityChipRows(sessions, rankOf)).toEqual([["pr:3", 3], ["pr:5", 4], ["pr:10", 5]]);
    expect(priorityChipRows(sessions, undefined)).toEqual([]);
  });

  it("no session in the top 10: no rows, so the menu leaves the section out", () => {
    const rankOf = priorityRankOfFromState(state() as any);
    expect(priorityChipRows([row("s12", "p12"), row("none")], rankOf)).toEqual([]);
  });

  it("the folder counts are unchanged by priority keys", () => {
    const { projectCounts } = computeChipCounts(sessions, {});
    expect(projectCounts.every(([k]) => projectAxisNoun(k) === "folder")).toBe(true);
  });
});

describe("compose path under a Top N filter", () => {
  it("a Top N filter leaves the viewed conversation's folder free to seed", () => {
    const conversation = { projectPath: "/Users/me/src/app", gitRoot: "/Users/me/src/app" };
    expect(resolveComposeProjectPath({ conversation, activeProjectFilter: "pr:3" })).toBe("/Users/me/src/app");
  });
});

describe("Top N counts nested sessions as their card", () => {
  it("a card whose worker serves a top priority counts once, as the filter keeps it", () => {
    const parent = row("parent");
    const worker = row("worker", "p2", { parent_conversation_id: parent._id } as Partial<InboxSession>);
    const subsByParent = new Map([[parent._id, [worker]]]);
    const rankOf = cardPriorityRankOf(priorityRankOfFromState(state({ sessions: Object.fromEntries([...sessions, parent, worker].map((x) => [x._id, x])) }) as any), subsByParent);
    const counted = priorityChipRows([parent], rankOf);
    expect(counted).toEqual([["pr:3", 1], ["pr:5", 1], ["pr:10", 1]]);
    const opts = chipFilterOpts(state({ activeProjectFilter: "pr:3", sessions: Object.fromEntries([...sessions, parent, worker].map((x) => [x._id, x])) }) as any, {});
    expect(chipFilterSection([parent], subsByParent, (x) => chipMatchesSession(x, opts)).map((x) => x.session_id)).toEqual(["parent"]);
  });
});

describe("whether the menus offer Top N", () => {
  it("a role's rider ranked in the top 10 makes the section appear, as the filter can show it", () => {
    const lead = row("lead");
    const rider = row("rider", "p1", { role_id: "r1", parent_conversation_id: lead._id } as Partial<InboxSession>);
    const all = Object.fromEntries([...sessions, lead, rider].map((x) => [x._id, x]));
    const rankOf = cardPriorityRankOf(priorityRankOfFromState(state({ sessions: all }) as any), new Map([[lead._id, [rider]]]));
    expect(priorityChipRows([lead], rankOf).length).toBe(3);
  });
});
