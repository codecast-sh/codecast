import { describe, expect, it } from "bun:test";
import { computeVisualOrder, placeInboxRows, type InboxSession } from "../inboxStore";
import { priorityPlaceReader, priorityRanks, rankLabelOf, sortByPriority } from "../priorityOrder";

// The inbox's Priorities view: the status sections stay, each sorted by the
// viewer's priority a session serves (rank, then milestone order), every other
// session last in its existing order: unlinked, a teammate's priority, one with
// no rank, or one in another workspace (not loaded here: "elsewhere").
// computeVisualOrder is what Ctrl+J/K walks and walkOrder (Ctrl+I) reads.

const cid = (t: string) => `${t}z${t.length}`.padEnd(32, "0");
const tag = (s: InboxSession) => (s.session_id ?? "").slice("session-".length);
const ME = "user_me";

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: cid(id),
  session_id: `session-${id}`,
  updated_at: Date.now() - 60_000,
  agent_status_updated_at: Date.now() - 60_000,
  last_role_is_user: false,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  user_id: ME,
  ...(extra.is_idle === false
    ? { agent_status: "working" as const, last_heartbeat: Date.now() - 5_000, daemon_alive_until: Date.now() + 85_000 }
    : {}),
  ...extra,
});

// A rank here is the pass's slot (ai_rank); null is a priority set aside, which has none.
const priority = (id: string, rank: number | null, steps: string[], user_id = ME) => ({
  _id: id, short_id: id, status: rank == null ? "set_aside" : "active", ai_rank: rank, person_pos: null, workspace: "team:t1", last_active_at: 0, user_id,
  steps: steps.map((key) => ({ key })),
});
const priorities = {
  pA: priority("pA", 1, ["s1", "s2"]),
  pB: priority("pB", 2, ["s1"]),
  pAside: priority("pAside", null, ["s1"]),
  pTheirs: priority("pTheirs", 1, ["s1"], "user_teammate"),
} as any;

const link = (priority_id: string, priority_step_key?: string) => ({ priority_id, priority_step_key: priority_step_key ?? null });

// Listed so the unranked rows come first in the input: the sort must move them.
const rows = [
  // Waiting longest, so the Status view files it first in Needs You.
  session("none1", { updated_at: Date.now() - 3 * 3_600_000, agent_status_updated_at: Date.now() - 3 * 3_600_000 }),
  session("b"),
  session("theirs", link("pTheirs", "s1")),
  session("a2", link("pA", "s2")),
  session("aside", link("pAside", "s1")),
  session("bs1", link("pB", "s1")),
  session("none2"),
  session("a1", link("pA", "s1")),
  session("anostep", link("pA")),
  // Its priority is in another workspace, so this window never loaded it.
  session("other", link("pOtherWorkspace", "s1")),
  session("wknone", { is_idle: false }),
  session("wkb", { is_idle: false, ...link("pB", "s1") }),
  session("wka", { is_idle: false, ...link("pA", "s1") }),
];

const state = (mode: "priorities" | "grouped") => ({
  sessions: Object.fromEntries(rows.map((s) => [s._id, s])),
  sessionsWithQueuedMessages: new Set<string>(),
  activeProjectFilter: null,
  pendingMessages: {},
  currentSessionId: null,
  pendingSessionCreates: {},
  activeBucketFilter: null,
  bucketAssignments: {},
  buckets: {},
  showFavorites: false,
  collapsedSections: {},
  recentFreezeOrder: null,
  currentUser: { _id: ME },
  priorities,
  clientState: { ui: { inbox_view_mode: mode } },
});

describe("sortByPriority", () => {
  it("orders by rank, then milestone, then unranked in their given order", () => {
    const placeOf = priorityPlaceReader(priorities, ME);
    expect(sortByPriority(rows.filter((s) => s.is_idle), placeOf).map(tag)).toEqual([
      "a1", "a2", "anostep", "bs1", "none1", "b", "theirs", "aside", "none2", "other",
    ]);
  });

  it("reads no rank for no link, a teammate's priority, a priority without a rank, or no viewer", () => {
    const placeOf = priorityPlaceReader(priorities, ME);
    expect(placeOf(session("x"))).toBeNull();
    expect(placeOf(session("x", link("pTheirs", "s1")))).toBeNull();
    expect(placeOf(session("x", link("pAside", "s1")))).toBeNull();
    expect(priorityPlaceReader(priorities, null)(session("x", link("pA", "s1")))).toBeNull();
    expect(placeOf(session("x", link("pB", "s1")))).toEqual({ rank: 2, step: 0 });
  });

  it("a link to a priority not loaded here reads elsewhere, not None", () => {
    const placeOf = priorityPlaceReader(priorities, ME);
    expect(placeOf(session("x", link("pOtherWorkspace", "s1")))).toBe("elsewhere");
    expect(rankLabelOf(placeOf(session("x", link("pOtherWorkspace", "s1"))))).toBe("elsewhere");
    expect(rankLabelOf(placeOf(session("x")))).toBeNull();
    expect(rankLabelOf(placeOf(session("x", link("pB", "s1"))))).toBe(2);
  });
});

describe("priorityRanks", () => {
  it("reads the effective order: a priority the person placed above the pass's ranks first", () => {
    const placed = { ...priorities, pB: { ...priorities.pB, person_pos: 0.5 } };
    expect([...priorityRanks(placed)]).toEqual([["pB", 1], ["pA", 2], ["pTheirs", 1]]);
    const placeOf = priorityPlaceReader(placed, ME);
    expect(sortByPriority([session("a1", link("pA", "s1")), session("bs1", link("pB", "s1"))], placeOf).map(tag)).toEqual(["bs1", "a1"]);
  });
});

describe("computeVisualOrder in the Priorities view", () => {
  it("keeps the status sections and sorts each by rank, milestone, then unlinked in the Status view's order", () => {
    const grouped = computeVisualOrder(state("grouped")).map(tag);
    const unranked = new Set(["none1", "b", "theirs", "aside", "none2", "other", "wknone"]);
    const statusOrderOf = (section: string[]) => grouped.filter((t) => section.includes(t) && unranked.has(t));
    const needsYou = ["none1", "b", "theirs", "a2", "aside", "bs1", "none2", "a1", "anostep", "other"];
    expect(computeVisualOrder(state("priorities")).map(tag)).toEqual([
      "a1", "a2", "anostep", "bs1", ...statusOrderOf(needsYou),
      "wka", "wkb", "wknone",
    ]);
    // Same sections as the Status view: Needs You above Working there too.
    expect(grouped.slice(0, needsYou.length).sort()).toEqual([...needsYou].sort());
  });

  it("Ctrl+I (walkOrder needsYou) lands on the highest-ranked Needs You session", () => {
    expect(computeVisualOrder(state("grouped"), { walk: "needsYou" }).map(tag)[0]).not.toBe("a1");
    const walked = computeVisualOrder(state("priorities"), { walk: "needsYou" }).map(tag);
    expect(walked[0]).toBe("a1");
    expect(walked).not.toContain("wka");
  });

  it("Ctrl+I never lands on a Couldn't finish row first, however it ranks", () => {
    // A hosted conversation that ended on a stop sits in Needs You's placement
    // but the panel draws it under "Couldn't finish", below Needs You.
    // Its priority outranks every other: the plain rank sort would put it first.
    const stopped = session("stopped", { agent_type: "codecast", hosted_stop: "error", ...link("pTop", "s1") } as Partial<InboxSession>);
    const s = state("priorities");
    s.sessions = { ...s.sessions, [stopped._id]: stopped };
    s.priorities = { ...priorities, pTop: priority("pTop", 0, ["s1"]) };
    const walked = computeVisualOrder(s, { walk: "needsYou" }).map(tag);
    expect(walked[0]).toBe("a1");
    expect(walked.at(-1)).toBe("stopped");
    // And the full order draws it after every Needs You row, before Working.
    const order = computeVisualOrder(s).map(tag);
    expect(order.indexOf("stopped")).toBe(order.indexOf("wka") - 1);
  });

  it("a collapsed section is skipped, as in the Status view", () => {
    const s = { ...state("priorities"), collapsedSections: { needs_input: true } };
    expect(computeVisualOrder(s).map(tag)).toEqual(["wka", "wkb", "wknone"]);
  });

  it("the placed sections are the ones the Status view places", () => {
    const placed = placeInboxRows(state("priorities") as any, { focusedId: null });
    expect(placed.needsInput.length).toBe(10);
    expect(placed.working.length).toBe(3);
  });
});
