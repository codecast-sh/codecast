import { describe, expect, test } from "bun:test";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { checkoutsByMachine, checkoutsSummary, folderOf, levelWords } from "../checkoutsModel";

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
  level: { state: "stuck", files: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"], reason: "changed here and on main without a clean merge", since: NOW - 21 * H, filed: { at: NOW - 20 * H, to: "session", conversation_id: "c-done" } },
});
const clean = row({ _id: "clean" });
const second = row({ _id: "second", device_id: "mini", device_label: "Second Mac", path: "/Users/ashot/src/union-mobile", ahead: 8, behind: 1002, level: { state: "off", reason: "holds commits main lacks" } });
const titles: Record<string, string> = { "c-done": "Opt-out repair test", "c-live": "Landing hero copy" };
const titleOf = (id: string) => titles[id];

describe("every machine's checkouts of a repository", () => {
  test("machines with stuck or held work come first, and the figures say how many", () => {
    const machines = checkoutsByMachine([clean, second, stuck], NOW, titleOf);
    expect(machines.map((m) => m.machine)).toEqual(["Ashot Main Mac", "Second Mac"]);
    expect(machines[0].checkouts.map((c) => c.folder)).toEqual(["~/src/union-mobile", "~/src/union-pipeline"]);
    expect(checkoutsSummary([clean, second, stuck])).toEqual({ checkouts: 3, machines: 2, holdingWork: 2, stuck: 1, behind: 2 });
  });

  test("uncommitted work reads by session title, working first; finished work with a conversation can ship; no id is shown", () => {
    const c = checkoutsByMachine([stuck], NOW, titleOf)[0].checkouts[0];
    expect(c.holdsWork).toBe(true);
    expect(c.sessions.map((s) => [s.title, s.state, s.canShip])).toEqual([
      ["Landing hero copy", "working", false],
      ["a codex session not synced here", "idle", false],
      ["Opt-out repair test", "finished", true],
    ]);
    expect(c.unattributed).toEqual({ paths: ["README.md"], more: 54 });
  });

  test("a stuck level says on which file, why, for how long, and who was told", () => {
    const c = checkoutsByMachine([stuck], NOW, titleOf)[0].checkouts[0];
    expect(c.level).toEqual({
      tone: "stuck",
      words: "stuck 21h on outreach/backend/tests/unit/ct94516Remediation.test.ts: changed here and on main without a clean merge",
      files: ["outreach/backend/tests/unit/ct94516Remediation.test.ts"],
      since: NOW - 21 * H,
      told: "told Opt-out repair test",
    });
    expect(levelWords({ state: "stuck", files: ["a", "b"], reason: "r", since: NOW - H, filed: null }, NOW, titleOf).told).toBe("nobody told yet");
    expect(levelWords({ state: "stuck", files: ["a"], reason: "r", since: NOW - H, filed: { at: NOW, to: "finding" } }, NOW, titleOf).told).toBe("filed as a finding");
    expect(levelWords({ state: "level", levelled_at: NOW - 2 * H }, NOW, titleOf).words).toBe("level with main, levelled 2h ago");
    expect(levelWords({ state: "off", reason: "a worktree" }, NOW, titleOf)).toMatchObject({ tone: "off", words: "not kept level: a worktree" });
  });

  test("a folder reads from home", () => {
    expect(folderOf("/Users/ashot/src/union-mobile")).toBe("~/src/union-mobile");
    expect(folderOf("/home/ubuntu/work/codecast")).toBe("~/work/codecast");
    expect(folderOf("/srv/x")).toBe("/srv/x");
  });
});
