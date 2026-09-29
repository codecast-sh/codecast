import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import {
  extractTaskShortIds,
  foldChecksState,
  foldShepherdState,
  resolveTaskLinks,
  resolveTaskLinksFromText,
  prUrl,
  commitUrl,
  shortSha,
  conversationFromSessionTrailer,
} from "./gitRefs";

describe("extractTaskShortIds", () => {
  test("reads ids out of commit messages, branches and PR bodies", () => {
    expect(extractTaskShortIds("fix: stop the leak (ct-123)")).toEqual(["ct-123"]);
    expect(extractTaskShortIds("ct-123-fix-auth")).toEqual(["ct-123"]);
    expect(extractTaskShortIds("feature/ct-123")).toEqual(["ct-123"]);
    expect(extractTaskShortIds("ashot/ct-4102-and-ct-88/wip")).toEqual(["ct-4102", "ct-88"]);
  });

  test("is case insensitive and drops repeats, keeping first-seen order", () => {
    expect(extractTaskShortIds("CT-9 then ct-9 then ct-4")).toEqual(["ct-9", "ct-4"]);
  });

  test("takes only task ids, not the other short id shapes", () => {
    expect(extractTaskShortIds("pl-88 tr-42 jx7c6zk doc:aaaaaaaaaaaaaaaaaaaaaa ct-7")).toEqual(["ct-7"]);
  });

  test("does not split a longer token", () => {
    expect(extractTaskShortIds("abct-123")).toEqual([]);
    expect(extractTaskShortIds("")).toEqual([]);
    expect(extractTaskShortIds(undefined)).toEqual([]);
  });
});

describe("resolveTaskLinks", () => {
  const db = () =>
    makeFakeDb({
      tasks: [
        { _id: "task_a", short_id: "ct-1", plan_id: "plan_x", project_id: "proj_x" },
        { _id: "task_b", short_id: "ct-2", plan_id: "plan_x" },
      ],
    });

  test("resolves ids to rows and gathers their plans and projects once each", async () => {
    const links = await resolveTaskLinks({ db: db() }, ["ct-1", "ct-2"]);
    expect(links.task_ids).toEqual(["task_a", "task_b"] as any);
    expect(links.plan_ids).toEqual(["plan_x"] as any);
    expect(links.project_ids).toEqual(["proj_x"] as any);
  });

  test("a stale id in a commit message is skipped, not an error", async () => {
    const links = await resolveTaskLinks({ db: db() }, ["ct-999", "ct-1"]);
    expect(links.task_ids).toEqual(["task_a"] as any);
  });

  test("reads several pieces of git text at once", async () => {
    const links = await resolveTaskLinksFromText({ db: db() }, "closes ct-1", null, "ct-2-branch");
    expect(links.task_ids).toEqual(["task_a", "task_b"] as any);
  });
});

describe("conversationFromSessionTrailer", () => {
  // Full-length ids: the trailer refuses anything but a full conversation id.
  const MINE = "a".repeat(32);
  const MATE_SHARED = "b".repeat(32);
  const STRANGER = "c".repeat(32);
  const MATE_PRIVATE = "e".repeat(32);
  const MATE_REVEALED = "f".repeat(32);
  const HIDER_SHARED = "g".repeat(32);
  const MINE_OTHER = "h".repeat(32);
  const db = () =>
    makeFakeDb({
      conversations: [
        { _id: MINE, user_id: "user_me", team_id: "team_a", is_private: true },
        { _id: MINE_OTHER, user_id: "user_me", team_id: "team_a", is_private: true },
        { _id: MATE_SHARED, user_id: "user_mate", team_id: "team_a", is_private: false },
        { _id: MATE_PRIVATE, user_id: "user_mate", team_id: "team_a", is_private: true },
        { _id: MATE_REVEALED, user_id: "user_mate", team_id: "team_a", is_private: true, team_visibility: "full" },
        { _id: HIDER_SHARED, user_id: "user_hider", team_id: "team_a", is_private: false },
        { _id: STRANGER, user_id: "user_x", team_id: "team_b", is_private: false },
      ],
      team_memberships: [
        { _id: "m1", user_id: "user_me", team_id: "team_a" },
        { _id: "m2", user_id: "user_mate", team_id: "team_a" },
        { _id: "m3", user_id: "user_hider", team_id: "team_a", visibility: "hidden" },
      ],
    });
  const msg = (id: string) => `fix: a thing\n\nCodecast-Session: https://codecast.sh/conversation/${id}`;
  const link = (id: string, scope: any) => conversationFromSessionTrailer({ db: db() }, msg(id), scope);

  test("links a session the reporting user owns, private or not", async () => {
    expect(await link(MINE, { userId: "user_me", teamId: "team_a" })).toBe(MINE as any);
  });

  test("links a teammate's session only when the team may read it", async () => {
    expect(await link(MATE_SHARED, { teamId: "team_a" })).toBe(MATE_SHARED as any);
    expect(await link(MATE_REVEALED, { teamId: "team_a" })).toBe(MATE_REVEALED as any);
    expect(await link(MATE_SHARED, { userId: "user_me", teamId: "team_a" })).toBe(MATE_SHARED as any);
  });

  test("a private session routed to the team is not the team's to link", async () => {
    // team_id is routing: a private session carries it too.
    expect(await link(MATE_PRIVATE, { teamId: "team_a" })).toBeUndefined();
    expect(await link(MATE_PRIVATE, { userId: "user_me", teamId: "team_a" })).toBeUndefined();
    expect(await link(MINE, { teamId: "team_a" })).toBeUndefined();
  });

  test("an owner who hides from the team keeps even a shared session out", async () => {
    expect(await link(HIDER_SHARED, { teamId: "team_a" })).toBeUndefined();
  });

  test("a trailer naming another workspace's session links nothing", async () => {
    expect(await link(STRANGER, { userId: "user_me", teamId: "team_a" })).toBeUndefined();
    expect(await link(STRANGER, { teamId: "team_a" })).toBeUndefined();
  });

  test("a trailer replaces a link only from the same owner", async () => {
    expect(await link(MINE, { userId: "user_me", teamId: "team_a", current: MINE_OTHER })).toBe(MINE as any);
    expect(await link(MINE, { userId: "user_me", teamId: "team_a", current: MINE })).toBe(MINE as any);
    expect(await link(MATE_SHARED, { teamId: "team_a", current: MINE })).toBeUndefined();
    expect(await link(MINE, { userId: "user_me", teamId: "team_a", current: MATE_SHARED })).toBeUndefined();
    // A link to a row that no longer exists holds nothing back.
    expect(await link(MINE, { userId: "user_me", current: "z".repeat(32) })).toBe(MINE as any);
  });

  test("a missing session, a missing trailer and a quoted trailer link nothing", async () => {
    expect(await link("d".repeat(32), { teamId: "team_a" })).toBeUndefined();
    expect(await conversationFromSessionTrailer({ db: db() }, "fix: plain", { teamId: "team_a" as any })).toBeUndefined();
    expect(await conversationFromSessionTrailer({ db: db() }, `${msg(MINE)}\n\nprose after`, { userId: "user_me" as any })).toBeUndefined();
  });
});

describe("foldChecksState", () => {
  const check = (status: string, conclusion?: string) => ({
    name: `${status}-${conclusion ?? "none"}`,
    status,
    conclusion,
    updated_at: 0,
  });

  test("nothing ran", () => {
    expect(foldChecksState([])).toBe("none");
    expect(foldChecksState(undefined)).toBe("none");
  });

  test("one failure decides the answer even while others run", () => {
    expect(foldChecksState([check("completed", "failure"), check("in_progress")])).toBe("failure");
    expect(foldChecksState([check("completed", "timed_out")])).toBe("failure");
    expect(foldChecksState([check("completed", "cancelled")])).toBe("failure");
  });

  test("neutral and skipped do not stand in the way", () => {
    expect(foldChecksState([check("completed", "success"), check("completed", "neutral"), check("completed", "skipped")]))
      .toBe("success");
  });

  test("anything unfinished is pending", () => {
    expect(foldChecksState([check("completed", "success"), check("queued")])).toBe("pending");
    expect(foldChecksState([check("completed")])).toBe("pending");
  });
});

describe("foldShepherdState", () => {
  test("the ending states win over everything", () => {
    expect(foldShepherdState({ state: "merged", mergeable: false, checks_state: "failure" })).toBe("merged");
    expect(foldShepherdState({ state: "closed", behind_by: 3 })).toBe("closed");
  });

  test("conflicts outrank being behind, which outranks red CI", () => {
    expect(foldShepherdState({ state: "open", mergeable: false, behind_by: 3, checks_state: "failure" })).toBe("conflicts");
    expect(foldShepherdState({ state: "open", behind_by: 3, checks_state: "failure" })).toBe("behind");
    expect(foldShepherdState({ state: "open", checks_state: "failure", review_decision: "changes_requested" })).toBe("ci_red");
  });

  test("requested changes outrank waiting on CI", () => {
    expect(foldShepherdState({ state: "open", checks_state: "pending", review_decision: "changes_requested" }))
      .toBe("changes_requested");
    expect(foldShepherdState({ state: "open", checks_state: "pending" })).toBe("ci_pending");
  });

  test("an open PR nobody has ruled on is waiting for review", () => {
    expect(foldShepherdState({ state: "open", checks_state: "success" })).toBe("review_pending");
    expect(foldShepherdState({ state: "open", checks_state: "success", review_decision: "none" })).toBe("review_pending");
    expect(foldShepherdState({ state: "open", checks_state: "success", review_decision: "review_required" }))
      .toBe("review_pending");
  });

  test("approved and green is approved", () => {
    expect(foldShepherdState({ state: "open", checks_state: "success", review_decision: "approved" })).toBe("approved");
  });

  test("mergeable_state carries the same meanings as the numbers", () => {
    expect(foldShepherdState({ state: "open", mergeable_state: "dirty" })).toBe("conflicts");
    expect(foldShepherdState({ state: "open", mergeable_state: "behind" })).toBe("behind");
  });
});

describe("urls", () => {
  test("build the addresses a person can click", () => {
    expect(prUrl("codecast-sh/codecast", 12)).toBe("https://github.com/codecast-sh/codecast/pull/12");
    expect(commitUrl("codecast-sh/codecast", "abc1234")).toBe("https://github.com/codecast-sh/codecast/commit/abc1234");
    expect(shortSha("abcdef1234567890")).toBe("abcdef1");
    expect(shortSha(undefined)).toBe("");
  });
});
