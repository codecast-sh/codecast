import { describe, expect, test } from "bun:test";
import { findUserLocalCheckouts } from "./conversations";
import { makeFakeDb } from "./testDb";

// A busy remote holds thousands of one person's sessions. The query streams
// the newest of them and keeps one entry per checkout root, rather than
// collecting every row (which ran the isolate out of memory on 2026-11-25).

const REMOTE = "git@github.com:acme/demo.git";

function context(conversations: any[]) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "owner|sess", tokenIdentifier: "test" }) },
    db: makeFakeDb({ users: [{ _id: "owner" }], conversations }, { creationTime: true }),
  };
}

const conv = (i: number, git_root: string | undefined, updated_at: number, user_id = "owner") =>
  ({ _id: `c${i}`, user_id, git_remote_url: REMOTE, git_root, project_path: git_root ? `${git_root}/pkg` : undefined, updated_at });

describe("conversations.findUserLocalCheckouts", () => {
  test("one entry per root, most recently updated first, other users excluded", async () => {
    const ctx = context([
      conv(1, "/src/demo", 10),
      conv(2, "/wt/demo-fix", 50),
      conv(3, "/src/demo", 90),
      conv(4, undefined, 99),
      conv(5, "/theirs/demo", 100, "other"),
    ]);
    expect(await (findUserLocalCheckouts as any)._handler(ctx, { git_remote_url: REMOTE })).toEqual([
      { git_root: "/src/demo", project_path: "/src/demo/pkg", updated_at: 90 },
      { git_root: "/wt/demo-fix", project_path: "/wt/demo-fix/pkg", updated_at: 50 },
    ]);
  });

  test("reads only the newest sessions on a busy remote", async () => {
    const rows = [conv(0, "/old/demo", 1)];
    for (let i = 1; i <= 2500; i++) rows.push(conv(i, "/src/demo", 1000 + i));
    const ctx = context(rows);
    const out = await (findUserLocalCheckouts as any)._handler(ctx, { git_remote_url: REMOTE });
    expect(out.map((r: any) => r.git_root)).toEqual(["/src/demo"]);
    expect(out[0].updated_at).toBe(3500);
  });
});
