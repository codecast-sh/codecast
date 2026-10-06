import { describe, expect, test } from "bun:test";
import { instantSessionRows, mergeSearchRows, rankSessions, sessionMatchesQuery, sessionStanding, standingMark, type SessionStanding } from "../instantSessionSearch";

const session = (over: any) => ({
  _id: over._id,
  session_id: over._id,
  agent_type: "claude",
  message_count: 10,
  updated_at: 1000,
  ...over,
});

// filterInboxScopeFromState reads these; "mine" scope keeps the viewer's rows.
const stateWith = (rows: any[], meId = "u1") => ({
  sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
  clientState: { ui: { inbox_scope: "mine" as const } },
  currentUser: { _id: meId },
  teamInboxIds: new Set<string>(),
  currentSessionId: null,
});

describe("sessionMatchesQuery", () => {
  test("summaries and project path are part of the haystack", () => {
    const s = session({ _id: "a", title: "Nightly sweep", idle_summary: "fixed the crosshatch", project_path: "/src/codecast" });
    expect(sessionMatchesQuery(s, "crosshatch")).toBe(true);
    expect(sessionMatchesQuery(s, "codecast")).toBe(true);
    expect(sessionMatchesQuery(s, "unrelated")).toBe(false);
  });

  test("a session is findable by the character name it wears", () => {
    const s = session({ _id: "a", title: "Agent org hierarchy", character_avatar: "hedgehog", character_name: "Nettle" });
    expect(sessionMatchesQuery(s, "nettle")).toBe(true);
    expect(sessionMatchesQuery(session({ _id: "b", title: "Agent org hierarchy" }), "nettle")).toBe(false);
  });
});

describe("instantSessionRows", () => {
  test("a title hit outranks a summary hit, recency breaks ties", () => {
    const rows = instantSessionRows(
      stateWith([
        session({ _id: "summary", title: "Inbox work", idle_summary: "sidebar tweaks", user_id: "u1", updated_at: 5000 }),
        session({ _id: "title", title: "Sidebar polish", user_id: "u1", updated_at: 1000 }),
      ]) as any,
      "sidebar",
    );
    expect(rows.map((r) => r.conversationId)).toEqual(["title", "summary"]);
  });

  test("a short query matches nothing, so no tier is drawn", () => {
    expect(instantSessionRows(stateWith([session({ _id: "a", title: "Sidebar", user_id: "u1" })]) as any, "s")).toEqual([]);
  });

  test("mineOnly drops sessions owned by someone else", () => {
    const rows = instantSessionRows(
      stateWith([
        session({ _id: "mine", title: "Sidebar polish", user_id: "u1" }),
        session({ _id: "theirs", title: "Sidebar rewrite", user_id: "u2" }),
      ]) as any,
      "sidebar",
      12,
      { mineOnly: true },
    );
    expect(rows.map((r) => r.conversationId)).toEqual(["mine"]);
  });

  test("the row carries a snippet from where the match landed", () => {
    const [row] = instantSessionRows(
      stateWith([session({ _id: "a", title: "Nightly sweep", idle_summary: "fixed the crosshatch weave", user_id: "u1" })]) as any,
      "crosshatch",
    );
    expect(row.instantSnippet).toBe("fixed the crosshatch weave");
    expect(row.instant).toBe(true);
    expect(row.matches).toEqual([]);
  });
});

describe("mergeSearchRows", () => {
  const contentRow = { conversationId: "a", title: "A", matches: [{ messageId: "m", content: "hit", role: "user", timestamp: 1 }], matchCount: 1, updatedAt: 2, authorName: "", isOwn: true, messageCount: 4 };
  const instantRow = { conversationId: "a", title: "A", matches: [], matchCount: 0, updatedAt: 2, authorName: "", isOwn: true, messageCount: 0, instant: true, instantSnippet: "summary line" };
  const otherInstant = { ...instantRow, conversationId: "b" };

  test("an earlier tier wins the row and keeps its message matches", () => {
    const merged = mergeSearchRows([contentRow], [instantRow, otherInstant]);
    expect(merged.map((r) => r.conversationId)).toEqual(["a", "b"]);
    expect(merged[0].matches).toHaveLength(1);
    expect(merged[0].instant).toBeUndefined();
  });

  test("the winner adopts what it lacks from the later tier", () => {
    const [merged] = mergeSearchRows([{ ...contentRow, messageCount: 0 }], [instantRow]);
    expect(merged.instantSnippet).toBe("summary line");
    expect(merged.messageCount).toBe(0);
  });

  test("an absent tier is skipped", () => {
    expect(mergeSearchRows(undefined, [instantRow]).map((r) => r.conversationId)).toEqual(["a"]);
  });
});

describe("rankSessions", () => {
  const H = 3_600_000;
  const NOW = 1_000 * H;
  const quiet: SessionStanding = { state: "done", shelf: null, sub: false, mine: true };
  const rank = (rows: any[], q: string, standing: Record<string, Partial<SessionStanding>> = {}) =>
    rankSessions(rows, q, (r: any) => ({ ...quiet, ...standing[r._id] }), 25, NOW).map((r: any) => r._id);

  test("a title hit beats a fresher hit in a summary (the ⌘K 'cloud' case)", () => {
    const rows = [
      session({ _id: "aurora", title: "Aurora toy hardware design", idle_summary: "ran the cloud render", updated_at: NOW }),
      session({ _id: "chip", title: "Cloud Linux chip cleanup", updated_at: NOW - 18 * H }),
      session({ _id: "dev", title: "Dev server cloud standardization", updated_at: NOW - 9 * H }),
    ];
    expect(rank(rows, "cloud")).toEqual(["dev", "chip", "aurora"]);
  });

  test("a word starting the query names a session as strongly as the title's first word", () => {
    const rows = [
      session({ _id: "mid", title: "Dev server cloud standardization", updated_at: NOW - 2 * H }),
      session({ _id: "inside", title: "Wordcloud renderer", updated_at: NOW }),
      session({ _id: "lead", title: "Cloud host parity", updated_at: NOW - 3 * H }),
    ];
    expect(rank(rows, "cloud")).toEqual(["lead", "mid", "inside"]);
  });

  test("a worker's ask gets no lift: it reports to its parent, not to you", () => {
    const rows = [
      session({ _id: "worker", title: "Sim worker", updated_at: NOW - 1 * H }),
      session({ _id: "own", title: "Sim own", updated_at: NOW - 1 * H }),
    ];
    expect(rank(rows, "sim", { worker: { sub: true, state: "needs_input" } })).toEqual(["own", "worker"]);
    expect(standingMark({ state: "needs_input", shelf: null, sub: true, mine: true })).toBe(null);
    expect(standingMark({ state: "working", shelf: null, sub: true, mine: true })).toBe("working");
    expect(standingMark({ state: "needs_input", shelf: "stashed", sub: false, mine: true })).toBe(null);
  });

  test("every typed word must land somewhere, in any order", () => {
    const rows = [
      session({ _id: "a", title: "Cloud box unblock and cleanup", updated_at: NOW }),
      session({ _id: "b", title: "Cloud host parity", updated_at: NOW }),
    ];
    expect(rank(rows, "cleanup cloud")).toEqual(["a"]);
  });

  test("inside a tier, a session that needs you or is working rises over a slightly fresher one", () => {
    const rows = [
      session({ _id: "fresh", title: "Sim pool", updated_at: NOW - 1 * H }),
      session({ _id: "asks", title: "Sim verify", updated_at: NOW - 6 * H }),
      session({ _id: "busy", title: "Sim offload", updated_at: NOW - 3 * H }),
    ];
    expect(rank(rows, "sim", { asks: { state: "needs_input" }, busy: { state: "working" } })).toEqual(["asks", "busy", "fresh"]);
  });

  test("workers, set-aside sessions and teammates' sink below an equal own session", () => {
    const rows = ["sub", "stashed", "killed", "theirs", "own"].map((id) => session({ _id: id, title: `Deploy ${id}`, updated_at: NOW - 2 * H }));
    expect(rank(rows, "deploy", {
      sub: { sub: true }, stashed: { shelf: "stashed" }, killed: { shelf: "killed" }, theirs: { mine: false },
    })).toEqual(["own", "theirs", "stashed", "sub", "killed"]);
  });

  test("an empty query orders by standing and recency, not by match", () => {
    const rows = [
      session({ _id: "old", title: "A", updated_at: NOW - 48 * H }),
      session({ _id: "new", title: "B", updated_at: NOW - 1 * H }),
      session({ _id: "asks", title: "C", updated_at: NOW - 3 * H }),
    ];
    expect(rank(rows, "", { asks: { state: "needs_input" } })).toEqual(["asks", "new", "old"]);
  });
});

describe("sessionStanding", () => {
  test("a server-only row reads its shelf from its triage stamps", () => {
    const row = session({ _id: "a", user_id: "u2", inbox_stashed_at: 5, isOwn: false });
    expect(sessionStanding(row, "u1", null)).toEqual({ state: null, shelf: "stashed", sub: false, mine: false });
  });

  test("a live row is placed the way the inbox places it", () => {
    const row = session({ _id: "a", user_id: "u1", awaiting_input: true, is_idle: true, is_connected: true });
    expect(sessionStanding(row, "u1", row).state).toBe("needs_input");
  });

  test("a worker is a sub; a killed row is killed whatever else it says", () => {
    const row = session({ _id: "a", user_id: "u1", parent_conversation_id: "p", inbox_killed_at: 9, inbox_stashed_at: 5 });
    const s = sessionStanding(row, "u1", null);
    expect(s.sub).toBe(true);
    expect(s.shelf).toBe("killed");
  });
});

describe("mid-word summary hits", () => {
  const mine: SessionStanding = { state: null, shelf: null, sub: false, mine: true };
  test("drop out when three stronger hits answer the query, and stay when they are all there is", () => {
    const now = 1_000_000;
    const row = (id: string, title: string, idle_summary = "") => ({ _id: id, title, idle_summary, updated_at: now });
    const strong = [row("a", "Dentist cleaning"), row("b", "Call the dentist"), row("c", "Ask", "dental insurance claim")];
    const weak = [row("d", "Fix auth", "identified the race")];
    const ranked = rankSessions([...weak, ...strong], "dent", () => mine, 10, now).map((r) => r._id);
    expect(ranked).not.toContain("d");
    expect(ranked.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(rankSessions(weak, "dent", () => mine, 10, now).map((r) => r._id)).toEqual(["d"]);
  });
});
