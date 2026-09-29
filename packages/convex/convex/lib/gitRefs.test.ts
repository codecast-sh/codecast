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
  const TEAMMATE = "b".repeat(32);
  const STRANGER = "c".repeat(32);
  const db = () =>
    makeFakeDb({
      conversations: [
        { _id: MINE, user_id: "user_me", team_id: "team_a" },
        { _id: TEAMMATE, user_id: "user_mate", team_id: "team_a" },
        { _id: STRANGER, user_id: "user_x", team_id: "team_b" },
      ],
    });
  const msg = (id: string) => `fix: a thing\n\nCodecast-Session: https://codecast.sh/conversation/${id}`;

  test("links a session the reporting user owns", async () => {
    expect(await conversationFromSessionTrailer({ db: db() }, msg(MINE), { userId: "user_me" as any })).toBe(MINE as any);
  });

  test("links a teammate's session for a commit in the same team", async () => {
    expect(await conversationFromSessionTrailer({ db: db() }, msg(TEAMMATE), { teamId: "team_a" as any })).toBe(TEAMMATE as any);
  });

  test("a trailer naming another workspace's session links nothing", async () => {
    expect(await conversationFromSessionTrailer({ db: db() }, msg(STRANGER), { userId: "user_me" as any, teamId: "team_a" as any })).toBeUndefined();
  });

  test("a missing session, a missing trailer and a quoted trailer link nothing", async () => {
    expect(await conversationFromSessionTrailer({ db: db() }, msg("d".repeat(32)), { teamId: "team_a" as any })).toBeUndefined();
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
