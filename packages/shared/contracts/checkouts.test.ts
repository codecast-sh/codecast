import { describe, expect, test } from "bun:test";
import { levelAskWords, levelWriters, withPageAsks, type CheckoutLevel, type CheckoutSession } from "./checkouts";

const H = 3600_000;
const session = (id: string, last: number, paths: string[]): CheckoutSession => ({ conversation_id: id, session_id: id, client: "claude", state: "idle", last_activity: last, paths, more: 0 });
const stuck: Extract<CheckoutLevel, { state: "stuck" }> = { state: "stuck", files: ["src/a.ts", "src/b.ts", "routes/[id].tsx"], reason: "3 file(s) changed here and in 0ace94e without a clean merge", since: 10 * H, told: [] };

describe("a stuck level's asks", () => {
  test("each conflicting file goes to the synced session that wrote it last; the rest to nobody", () => {
    const sessions = [session("old", 1 * H, ["src/a.ts", "src/b.ts"]), session("new", 5 * H, ["src/b.ts"]), { ...session("local", 9 * H, ["routes/[id].tsx"]), conversation_id: null }];
    expect(levelWriters({ uncommitted: { sessions }, level: stuck })).toEqual({
      writers: [{ conversation_id: "old", files: ["src/a.ts"] }, { conversation_id: "new", files: ["src/b.ts"] }],
      nobody: ["routes/[id].tsx"],
    });
    expect(levelWriters({ uncommitted: { sessions }, level: { state: "level", levelled_at: null } })).toEqual({ writers: [], nobody: [] });
  });

  test("sent from the page, the ask names every file and spells the ways out over them, quoted for the shell", () => {
    const { title, body } = levelAskWords({ path: "/Users/ashot/src/union-mobile", upstream: "origin/main", behind: 364 }, stuck, ["src/b.ts", "routes/[id].tsx"], null, { host: "Mac-mini", whose: "session" });
    expect(title).toBe("union-mobile on Mac-mini: 2 of your files conflict with origin/main");
    expect(body).toContain("(364 commits behind)");
    expect(body).toContain("  src/b.ts\n  routes/[id].tsx\n");
    expect(body).not.toContain("The full list");
    expect(body).toContain("The other 1 conflicting file belongs to other sessions");
    expect(body).toContain("diff -- src/b.ts 'routes/[id].tsx' > /tmp/union-mobile-level.patch && git --literal-pathspecs -C /Users/ashot/src/union-mobile checkout -- src/b.ts 'routes/[id].tsx'");
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
