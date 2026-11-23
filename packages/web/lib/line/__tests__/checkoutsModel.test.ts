import { describe, expect, test } from "bun:test";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { checkoutsPage, checkoutsSummary, filesByFolder, folderOf, levelWords } from "../checkoutsModel";

const H = 3600_000;
const NOW = 100 * H;

const row = (over: Partial<CheckoutRow>): CheckoutRow => ({
  _id: over.path ?? "r", workspace: "team:t", reported_at: NOW, device_label: "Ashot Main Mac",
  repository: "union-ai/union-mobile", device_id: "mac", path: "/Users/ashot/src/union-pipeline", branch: "main", upstream: "origin/main",
  head_sha: "a", ahead: 0, behind: 0, fetched_at: NOW,
  uncommitted: { total: 0, sessions: [], unattributed: [], unattributed_more: 0 },
  level: { state: "level", levelled_at: NOW - H },
  ...over,
});

// The showcase: the laptop's union-mobile stuck 21h on one test it edited, 63 uncommitted paths; the clean clone level;
// the Second Mac 1002 behind with 8 commits main lacks.
const stuck = row({
  _id: "stuck", path: "/Users/ashot/src/union-mobile", behind: 159,
  uncommitted: {
    total: 63,
    sessions: [
      { conversation_id: "c-done", session_id: "s1", client: "claude", state: "finished", last_activity: NOW - 20 * H, paths: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"], more: 0 },
      { conversation_id: "c-live", session_id: "s2", client: "claude", state: "working", last_activity: NOW, paths: ["outreach/landing/a.tsx"], more: 3 },
      { conversation_id: null, session_id: "s3", client: "codex", state: "idle", last_activity: NOW - H, paths: ["x"], more: 0 },
    ],
    unattributed: ["README.md"], unattributed_more: 54,
  },
  // Reported by an earlier daemon, which told one writer as `filed`.
  level: { state: "stuck", files: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"], reason: "changed here and on main without a clean merge", since: NOW - 21 * H, filed: { at: NOW - 20 * H, to: "session", conversation_id: "c-done" } } as any,
});
const clean = row({ _id: "clean" });
const second = row({ _id: "second", device_id: "mini", device_label: "Second Mac", path: "/Users/ashot/src/union-mobile", ahead: 8, behind: 1002, level: { state: "off", reason: "holds commits main lacks" } });
const titles: Record<string, string> = { "c-done": "Opt-out repair test", "c-live": "Landing hero copy" };
const titleOf = (id: string) => titles[id];

describe("every machine's checkouts of a repository", () => {
  test("what needs a person leads; each machine keeps its live checkouts; old worktrees fold to a count", () => {
    const wt = (id: string, total: number, sessions: CheckoutRow["uncommitted"]["sessions"] = []) => row({ _id: id, device_id: "mini", device_label: "Second Mac", path: `/Users/ashot/src/union-mobile/.codecast/worktrees/${id}`, behind: 700, uncommitted: { total, sessions, unattributed: [], unattributed_more: 0 }, level: { state: "off", reason: "a worktree" } });
    const busy = wt("busy", 2, [{ conversation_id: "c-live", session_id: "s", client: "claude", state: "working", last_activity: NOW, paths: ["a"], more: 1 }]);
    const page = checkoutsPage([clean, second, stuck, wt("old1", 30), wt("old2", 7), busy], NOW, titleOf);
    expect(page.needs.map((c) => c.id)).toEqual(["stuck"]);
    expect(page.machines.map((m) => [m.machine, m.live.map((c) => c.id), m.stale.checkouts.length, m.stale.files])).toEqual([
      ["Second Mac", ["second", "busy"], 2, 37],
      ["Ashot Main Mac", ["clean"], 0, 0],
    ]);
    expect(checkoutsSummary([clean, second, stuck])).toEqual({ checkouts: 3, machines: 2, holdingWork: 2, stuck: 1, behind: 2 });
  });

  test("uncommitted work reads by session title, working first; finished work with a conversation can ship; no id is shown", () => {
    const c = checkoutsPage([stuck], NOW, titleOf).needs[0];
    expect(c.holdsWork).toBe(true);
    expect(c.sessions.map((s) => [s.title, s.state, s.canShip])).toEqual([
      ["Landing hero copy", "working", false],
      ["a codex session not synced here", "idle", false],
      ["Opt-out repair test", "finished", true],
    ]);
    expect(c.unattributed).toEqual({ paths: ["README.md"], more: 54, reading: false });
    expect(c.finished.map((s) => s.title)).toEqual(["Opt-out repair test"]);
  });

  test("a stuck level says in a glance why, for how long, and who was told; git's sentence stays whole", () => {
    const c = checkoutsPage([stuck], NOW, titleOf).needs[0];
    expect(c.level).toEqual({
      tone: "stuck",
      words: "conflicts in 1 file · stuck 21h",
      reason: "changed here and on main without a clean merge",
      files: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"],
      since: NOW - 21 * H,
      told: "told Opt-out repair test",
      toldBrief: "told its writer",
      stuckFor: "21h",
      heading: "Conflicts with main in 1 file",
    });
    // The writer of the stuck file, by title, and already told by the earlier daemon.
    expect(c.asks).toEqual({ writers: [{ conversationId: "c-done", title: "Opt-out repair test", files: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"], told: true }], nobody: { files: [], told: false } });
    // Nobody is owed word before the daemon's 30 minutes are up.
    expect(levelWords({ state: "stuck", files: ["a"], reason: "r", since: NOW - 10 * 60_000, told: [] }, NOW, titleOf).told).toBe("will tell its writers at 30m");
    expect(levelWords({ state: "stuck", files: ["a", "b"], reason: "r", since: NOW - H, told: [] }, NOW, titleOf).told).toBe("nobody told yet");
    expect(levelWords({ state: "stuck", files: ["a"], reason: "r", since: NOW - H, told: [{ at: NOW, files: 1, to: "finding" }] }, NOW, titleOf).told).toBe("filed a finding");
    // Each writer about its own files: two sessions and a finding for the files nobody wrote.
    const many = levelWords({ state: "stuck", files: ["a", "b", "c"], reason: "r", since: NOW - H, told: [{ at: NOW, files: 1, to: "session", conversation_id: "c-done" }, { at: NOW, files: 1, to: "session", conversation_id: "c-live" }, { at: NOW, files: 1, to: "finding" }] }, NOW, titleOf);
    expect(many).toMatchObject({ told: "told 2 writers, filed a finding", toldBrief: "told 2 writers" });
    expect(levelWords({ state: "level", levelled_at: NOW - 2 * H }, NOW, titleOf).words).toBe("level with main, levelled 2h ago");
    expect(levelWords({ state: "off", reason: "a worktree" }, NOW, titleOf)).toMatchObject({ tone: "off", words: "not kept level: a worktree" });
  });

  test("needs you is what a person must act on; finished work waits in its own group", () => {
    const behind = row({ _id: "behind", device_id: "mini", device_label: "Mac-mini", path: "/Users/ashot/src/union-mobile", behind: 3819, uncommitted: { total: 191, sessions: [], unattributed: ["a"], unattributed_more: 190 }, level: { state: "off", reason: "holds commits main lacks" } });
    const done = row({ _id: "done", path: "/Users/ashot/src/union-mobile/.codecast/worktrees/w1", uncommitted: { total: 2, sessions: [{ conversation_id: "c-done", session_id: "s", client: "claude", state: "finished", last_activity: NOW - 2 * H, paths: ["a"], more: 1 }], unattributed: [], unattributed_more: 0 }, level: { state: "off", reason: "a worktree" } });
    const page = checkoutsPage([clean, stuck, behind, done], NOW, titleOf);
    expect(page.needs.map((c) => [c.id, c.farBehind])).toEqual([["stuck", false], ["behind", true]]);
    expect(page.ready.map((c) => c.id)).toEqual(["done"]);
    expect(page.machines.flatMap((m) => m.live.map((c) => c.id))).toEqual(["clean"]);
  });

  test("each conflicting file goes to the session that wrote it last; the rest to nobody; told by the daemon or the page", () => {
    const two = row({
      _id: "two", behind: 364,
      uncommitted: {
        total: 4,
        sessions: [
          { conversation_id: "c-done", session_id: "s1", client: "claude", state: "finished", last_activity: NOW - 3 * H, paths: ["a.ts", "b.ts"], more: 0 },
          { conversation_id: "c-live", session_id: "s2", client: "claude", state: "idle", last_activity: NOW - H, paths: ["b.ts"], more: 0 },
        ],
        unattributed: ["c.ts"], unattributed_more: 0,
      },
      level: { state: "stuck", files: ["a.ts", "b.ts", "c.ts"], reason: "3 file(s) changed here and in 0ace94e without a clean merge", since: NOW - 2 * H, told: [{ at: NOW - H, files: 1, to: "session", conversation_id: "c-done" }] },
    });
    const c = checkoutsPage([two], NOW, titleOf).needs[0];
    // The last writer first.
    expect(c.asks).toEqual({
      writers: [
        { conversationId: "c-live", title: "Landing hero copy", files: ["b.ts"], told: false },
        { conversationId: "c-done", title: "Opt-out repair test", files: ["a.ts"], told: true },
      ],
      nobody: { files: ["c.ts"], told: false },
    });
    expect(c.level.heading).toBe("Conflicts with main in 3 files");
    // The row and the drawer say one stuck age.
    expect(c.level.words).toBe(`conflicts in 3 files · stuck ${c.level.stuckFor}`);
  });

  test("files read under their folders, eight then how many more, names whole", () => {
    const paths = ["outreach/backend/tests/unit/ct94516Remediation.test.ts", "outreach/backend/tests/unit/b.test.ts", "outreach/landing/a.tsx", "README.md", ...Array.from({ length: 6 }, (_, i) => `x/f${i}.ts`)];
    expect(filesByFolder(paths)).toEqual({
      groups: [
        { folder: "outreach/backend/tests/unit/", names: ["ct94516Remediation.test.ts", "b.test.ts"] },
        { folder: "outreach/landing/", names: ["a.tsx"] },
        { folder: "", names: ["README.md"] },
        { folder: "x/", names: ["f0.ts", "f1.ts", "f2.ts", "f3.ts"] },
      ],
      more: 2,
    });
  });

  test("a folder reads from home", () => {
    expect(folderOf("/Users/ashot/src/union-mobile")).toBe("~/src/union-mobile");
    expect(folderOf("/home/ubuntu/work/codecast")).toBe("~/work/codecast");
    expect(folderOf("/srv/x")).toBe("/srv/x");
  });
});
