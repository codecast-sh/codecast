import { describe, expect, test } from "bun:test";
import { levelAskWords, levelWriters, withPageAsks, type CheckoutLevel, type CheckoutSession } from "./checkouts";

const H = 3600_000;
const session = (id: string, last: number, paths: string[]): CheckoutSession => ({ conversation_id: id, session_id: id, client: "claude", state: "idle", last_activity: last, paths, more: 0 });
const stuck: Extract<CheckoutLevel, { state: "stuck" }> = { state: "stuck", files: ["src/a.ts", "src/b.ts", "routes/[id].tsx"], reason: "3 file(s) changed here and in 0ace94e without a clean merge", since: 10 * H, told: [] };

/** One way out: upstream's change brought in by hand. Nothing that overwrites the file, and the commands a shared checkout forbids. */
function expectOneWayOut(body: string) {
  expect(body).toContain("The way out, over these files only: bring upstream's change into each by hand");
  for (const overwrite of ["checkout --", "pathspec-from-file", ".patch", "apply --3way", "Either way out"]) expect(body).not.toContain(overwrite);
  expect(body).toContain("Never run git pull, merge, rebase, stash, checkout, restore, reset or commit in this shared checkout");
}

describe("a stuck level's asks", () => {
  test("each conflicting file goes to the synced session that wrote it last; the rest to nobody", () => {
    const sessions = [session("old", 1 * H, ["src/a.ts", "src/b.ts"]), session("new", 5 * H, ["src/b.ts"]), { ...session("local", 9 * H, ["routes/[id].tsx"]), conversation_id: null }];
    expect(levelWriters({ uncommitted: { sessions }, level: stuck })).toEqual({
      writers: [{ conversation_id: "old", files: ["src/a.ts"] }, { conversation_id: "new", files: ["src/b.ts"] }],
      nobody: ["routes/[id].tsx"],
    });
    expect(levelWriters({ uncommitted: { sessions }, level: { state: "level", levelled_at: null } })).toEqual({ writers: [], nobody: [] });
  });

  test("sent from the page, the ask names every file and spells upstream's version of each, quoted for the shell", () => {
    const { title, body } = levelAskWords({ path: "/Users/ashot/src/union-mobile", upstream: "origin/main", behind: 364 }, stuck, ["src/b.ts", "routes/[id].tsx"], null, { host: "Mac-mini", whose: "session" });
    expect(title).toBe("union-mobile on Mac-mini: 2 of your files conflict with origin/main");
    expect(body).toContain("(364 commits behind)");
    expect(body).toContain("  src/b.ts\n  routes/[id].tsx\n");
    expect(body).not.toContain("The full list");
    expect(body).not.toContain("three-way merge");
    expect(body).toContain("The other 1 conflicting file belongs to other sessions");
    expect(body).toContain("  `git -C /Users/ashot/src/union-mobile show origin/main:src/b.ts`\n  `git -C /Users/ashot/src/union-mobile show 'origin/main:routes/[id].tsx'`\n");
    expect(body).not.toContain("src/a.ts");
    expectOneWayOut(body);
  });

  test("sent by the daemon, the ask names its first files with their merge files, points at the full list, and lists upstream's commits", () => {
    const mine = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const local = {
      list: "/tmp/codecast-level/union-mobile-abc-conv.txt",
      mergeDir: "/Users/ashot/src/union-mobile/.git/codecast/level-conflicts",
      merges: { "src/f0.ts": { kind: "merged" as const, file: "/x/src/f0.ts" }, "src/f1.ts": { kind: "upstream-deleted" as const } },
      commits: ["- 0ace94e Rework the router"],
      to: "0ace94e1234567890",
    };
    const { title, body } = levelAskWords({ path: "/Users/ashot/src/union-mobile", upstream: "origin/main", behind: 1 }, { files: mine, since: 10 * H }, mine, local, { host: "Mac-mini", whose: "session" });
    expect(title).toBe("union-mobile on Mac-mini: 10 of your files conflict with origin/main");
    expect(body).toContain("(1 commit behind)");
    expect(body).toContain("  src/f0.ts\n  src/f1.ts (upstream deletes it: delete your copy, or move your edit to where upstream moved that code)\n");
    expect(mine.filter((f) => body.includes(`${f}\n`) || body.includes(`${f} (`))).toEqual(mine.slice(0, 8));
    expect(body).toContain("  +2 more\nThe full list: /tmp/codecast-level/union-mobile-abc-conv.txt");
    expect(body).toContain("Upstream changed them in:\n- 0ace94e Rework the router");
    expect(body).toContain("is at /Users/ashot/src/union-mobile/.git/codecast/level-conflicts/<file>");
    expect(body).toContain("(`git -C /Users/ashot/src/union-mobile show 0ace94e12:<file>`)");
    expect(body).toContain("Edit only the files named here and in the list.");
    expectOneWayOut(body);
  });

  test("the page's asks count as told for the episode they were made in, once per reader", () => {
    const asks = [
      { at: 11 * H, since: 10 * H, files: 1, to: "session" as const, conversation_id: "new" },
      { at: 11 * H, since: 10 * H, files: 1, to: "finding" as const },
      { at: 3 * H, since: 2 * H, files: 1, to: "session" as const, conversation_id: "old" },
    ];
    const level = withPageAsks({ ...stuck, told: [{ at: 10.5 * H, files: 1, to: "session", conversation_id: "new" }] }, asks);
    expect(level.state === "stuck" && level.told).toEqual([
      { at: 10.5 * H, files: 1, to: "session", conversation_id: "new" },
      { at: 11 * H, files: 1, to: "finding" },
    ]);
    expect(withPageAsks({ state: "level", levelled_at: 1 }, asks)).toEqual({ state: "level", levelled_at: 1 });
  });
});
