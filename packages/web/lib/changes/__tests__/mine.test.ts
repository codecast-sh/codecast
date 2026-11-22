/**
 * Whose a change is and what a filtered grid draws (the Deploys page's shared filters): each change's owner from what it
 * joins, Mine against the viewer, one group picked by its name, and the row a link points at surviving every filter.
 */
import { describe, expect, test } from "bun:test";
import type { CheckoutRow, CheckoutSession } from "@codecast/shared/contracts/checkouts";
import type { QueueCommit } from "@codecast/shared/contracts/deployTargets";
import { assemble, type ChangePullRequest } from "../assemble";
import { changeLifecycle, type ChangeTone, type Lifecycle } from "../lifecycle";
import { changeRowOf, filterChanges,groupChanges, groupLabel, groupOf, isMineChange, type ChangeRow, type ChangeViewer } from "../rows";
import { changeMatches } from "../../deploys/focus";
import { mineOnly } from "../../deploys/targets";

const now = 1_790_000_000_000;
const MIN = 60_000;
const repo = "acme/app";

const session = (id: string): CheckoutSession => ({ conversation_id: id, session_id: `s-${id}`, client: "claude", state: "working", last_activity: now - 5 * MIN, paths: ["a.ts"], more: 0 });
const checkout = (over: Partial<CheckoutRow> & Pick<CheckoutRow, "path" | "branch" | "device_id">): CheckoutRow => ({
  _id: `${over.device_id}:${over.path}`, workspace: "team:t1", reported_at: now - 2 * MIN, device_label: "Mac",
  repository: repo, upstream: "origin/main", head_sha: "aaaaaaa1111", ahead: 1, behind: 0, fetched_at: now - 10 * MIN,
  uncommitted: { total: 0, sessions: [], unattributed: [], unattributed_more: 0 }, level: { state: "off", reason: "a worktree" },
  ...over,
});
const pr = (over: Partial<ChangePullRequest> & Pick<ChangePullRequest, "number">): ChangePullRequest => ({ repository: repo, state: "open", updated_at: now - MIN, created_at: now - MIN, ...over });
const queued = (sha: string, author: string | null): QueueCommit => ({ sha, subject: `commit ${sha}`, at: now - 20 * MIN, author, session: null, tasks: [], ci: "passed", ci_url: null });

const jason: ChangeViewer = { userId: "u-jason", login: "JasonBenn", name: "Jason Benn", devices: new Set(["dev-jason"]) };
const owners: Record<string, string[]> = { "c-jason": ["u-jason"], "c-ashot": ["u-ashot"] };

describe("whose a change is", () => {
  const changes = assemble({
    repository: repo,
    now,
    checkouts: [
      // A branch whose pull request Ashot opened, though Jason's session wrote in it: the pull request's author decides.
      checkout({ device_id: "dev-jason", path: "/w/pr-ashot", branch: "pr-ashot", uncommitted: { total: 1, sessions: [session("c-jason")], unattributed: [], unattributed_more: 0 } }),
      // Ashot's session on Jason's machine: the session decides, not the machine.
      checkout({ device_id: "dev-jason", path: "/w/ashot-on-jason", branch: "ashot-on-jason", uncommitted: { total: 1, sessions: [session("c-ashot")], unattributed: [], unattributed_more: 0 } }),
      // Nobody's session: whose machine it sits on.
      checkout({ device_id: "dev-jason", path: "/w/by-hand", branch: "by-hand" }),
      // A session the viewer's store does not hold, on someone else's machine.
      checkout({ device_id: "dev-other", path: "/w/unknown", branch: "unknown", uncommitted: { total: 1, sessions: [session("c-nobody")], unattributed: [], unattributed_more: 0 } }),
    ],
    pullRequests: [pr({ number: 7, head_ref: "pr-ashot", author_github_username: "ashot" }), pr({ number: 8, head_ref: "jason-pr", author_github_username: "jasonbenn" })],
    targets: [{ name: "web", repository: repo, queue: { groups: [{ commits: [queued("abcdef1234", "Jason Benn"), queued("bcdef12345", "ashot")] }] } }],
    titleOf: () => null,
    ownersOf: (id) => owners[id],
  });
  const by = (key: string) => changes.find((c) => c.key === key)!;

  test("each change names its owner by the strongest fact it joins", () => {
    expect(by("branch:pr-ashot").owner).toEqual({ by: "pr", login: "ashot" });
    expect(by("pr:8").owner).toEqual({ by: "pr", login: "jasonbenn" });
    expect(by("branch:ashot-on-jason").owner).toEqual({ by: "session", users: ["u-ashot"] });
    expect(by("branch:by-hand").owner).toEqual({ by: "device", devices: ["dev-jason"] });
    expect(by("branch:unknown").owner).toEqual({ by: "device", devices: ["dev-other"] });
    expect(by("commit:abcdef1234").owner).toEqual({ by: "commit", author: "Jason Benn" });
  });

  test("Mine matches the viewer's login (any case), account, device or commit name", () => {
    const mine = changes.filter((c) => isMineChange(c, jason)).map((c) => c.key).sort();
    expect(mine).toEqual(["branch:by-hand", "commit:abcdef1234", "pr:8"]);
  });

  test("a change's row carries its writers' sessions, so a session link can find it", () => {
    const c = by("branch:ashot-on-jason");
    const r = changeRowOf({ ...c, lifecycle: changeLifecycle(c.facts) });
    expect(changeMatches(r, { kind: "session", id: "c-ashot" })).toBe(true);
    expect(changeMatches(r, { kind: "session", id: "c-jason" })).toBe(false);
  });

  test("a viewer not loaded yet owns nothing", () => {
    const nobody: ChangeViewer = { userId: null, login: null, name: null, devices: new Set() };
    expect(changes.some((c) => isMineChange(c, nobody))).toBe(false);
  });
});

const row = (key: string, tone: ChangeTone, over: Partial<ChangeRow> = {}): ChangeRow => ({
  key,
  lifecycle: { now: { stage: "check", state: tone === "yellow" ? "active" : "waiting", tone, word: "", detail: null } } as unknown as Lifecycle,
  updated_at: now - MIN,
  ...over,
});
const mineOwner = { owner: { by: "session" as const, users: ["u-jason"] } };
const theirs = { owner: { by: "session" as const, users: ["u-ashot"] } };

describe("the grid's filters", () => {
  const rows = [
    row("red-mine", "red", mineOwner),
    row("blue-theirs", "blue", { ...theirs, refs: { branch: "x", pr: 42, shas: ["feedface00"] } }),
    row("moving-mine", "yellow", mineOwner),
    row("waiting-theirs", "muted", { ...theirs, writers: [{ title: null, state: "working", conversation_id: "kd7abcdefghijk" }] }),
    row("old-mine", "muted", { ...mineOwner, updated_at: now - 10 * 24 * 60 * MIN }),
  ];
  const keys = (rs: ChangeRow[]) => rs.map((r) => r.key);

  test("each row falls in one group; an untouched one is parked", () => {
    expect(rows.map((r) => groupOf(r, now))).toEqual(["you", "you", "moving", "waiting", "parked"]);
  });

  test("no filter keeps every row", () => {
    expect(keys(filterChanges(rows, { mine: false, group: null }, jason, now))).toEqual(keys(rows));
  });

  test("a picked group keeps only its rows, Mine only the viewer's, both together only the viewer's in that group", () => {
    expect(keys(filterChanges(rows, { mine: false, group: "you" }, jason, now))).toEqual(["red-mine", "blue-theirs"]);
    expect(keys(filterChanges(rows, { mine: true, group: null }, jason, now))).toEqual(["red-mine", "moving-mine", "old-mine"]);
    expect(keys(filterChanges(rows, { mine: true, group: "you" }, jason, now))).toEqual(["red-mine"]);
  });

  test("the row a link points at survives a filter that would hide it", () => {
    const keep = (r: ChangeRow) => changeMatches(r, { kind: "pr", pr: 42 });
    expect(keys(filterChanges(rows, { mine: true, group: "moving" }, jason, now, keep))).toEqual(["blue-theirs", "moving-mine"]);
    expect(changeMatches(rows[1], { kind: "sha", sha: "feedf" })).toBe(true);
    expect(changeMatches(rows[1], { kind: "branch", name: "x" })).toBe(true);
    expect(changeMatches(rows[0], { kind: "pr", pr: 42 })).toBe(false);
  });

  test("a session link keeps the change that session wrote, by its id or its short id", () => {
    for (const id of ["kd7abcdefghijk", "kd7abcd", "KD7ABCD"]) {
      const keep = (r: ChangeRow) => changeMatches(r, { kind: "session", id });
      expect(keys(filterChanges(rows, { mine: true, group: "you" }, jason, now, keep))).toEqual(["red-mine", "waiting-theirs"]);
    }
    // Too short to be a short id: names nothing.
    expect(changeMatches(rows[3], { kind: "session", id: "kd7" })).toBe(false);
    expect(changeMatches(rows[0], { kind: "session", id: "kd7abcd" })).toBe(false);
  });

  test("a picked group with nothing left keeps its name on screen, so it can be cleared", () => {
    const shown = filterChanges(rows, { mine: true, group: "waiting" }, jason, now);
    expect(shown).toEqual([]);
    expect(groupChanges(shown, now, "waiting").map((g) => [g.id, g.rows.length])).toEqual([["waiting", 0]]);
    expect(groupChanges(shown, now).length).toBe(0);
  });

  test("the failures and turns read Needs attention, and Needs you once only the viewer's are shown", () => {
    const you = groupChanges(rows, now).find((g) => g.id === "you")!;
    expect(groupLabel(you, false)).toBe("Needs attention");
    expect(groupLabel(you, true)).toBe("Needs you");
    const moving = groupChanges(rows, now).find((g) => g.id === "moving")!;
    expect(groupLabel(moving, true)).toBe("Moving");
  });
});

describe("Mine on the commits waiting on main", () => {
  const groups = [{ key: "g", session: null, ci: "passed" as const, commits: [queued("aaaa111", "jasonbenn"), queued("bbbb222", "ashot")] }];
  test("keeps the viewer's commits, and the one a link points at", () => {
    expect(mineOnly(groups, jason).flatMap((g) => g.commits.map((c) => c.sha))).toEqual(["aaaa111"]);
    expect(mineOnly(groups, jason, (c) => c.sha === "bbbb222").flatMap((g) => g.commits.map((c) => c.sha))).toEqual(["aaaa111", "bbbb222"]);
  });
});
