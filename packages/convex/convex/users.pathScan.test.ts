// Regression tests for scanConversationsForPath — the take()-based replacement
// for the paginate()-based path scan. The old version ran one paginated query
// per source (git_root, then project_path) inside a single mutation execution,
// which Convex rejects ("only a single paginated query in each function"), so
// delete-by-path threw for any conversation that wasn't matched by the very
// first git_root page. Discovered by `cast doctor`'s cleanup verification: its
// scratch project has no git repo, so the git_root range was empty and the
// second paginate call blew up — leaving the self-test conversation behind.

import { describe, expect, test } from "bun:test";
import { scanConversationsForPath } from "./users";

// Minimal ctx.db fake: one table, index-name → field mapping, eq/gte/lt
// constraint capture, ordered take(). Mirrors the hand-rolled fakes in
// buckets.test.ts / conversationSessionLookup.test.ts.
function fakeCtx(conversations: any[]) {
  return {
    db: {
      query(table: string) {
        expect(table).toBe("conversations");
        return {
          withIndex(index: string, builder: (q: any) => any) {
            const field = index === "by_user_git_root" ? "git_root" : "project_path";
            const constraints: Record<string, any> = {};
            const q: any = {
              eq: (f: string, v: any) => { constraints[`eq:${f}`] = v; return q; },
              gte: (f: string, v: any) => { constraints.gte = v; return q; },
              lt: (f: string, v: any) => { constraints.lt = v; return q; },
            };
            builder(q);
            return {
              take: async (n: number) => {
                const rows = conversations
                  .filter((c) => c.user_id === constraints["eq:user_id"])
                  .filter((c) => typeof c[field] === "string" && c[field] >= constraints.gte && c[field] < constraints.lt)
                  .sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
                return rows.slice(0, n);
              },
            };
          },
        };
      },
    },
  };
}

let nextId = 0;
const conv = (fields: Record<string, any>) => ({ _id: `c${nextId++}`, user_id: "u1", ...fields });

async function collect(ctx: any, prefix: string): Promise<string[]> {
  const out: string[] = [];
  await scanConversationsForPath(ctx, "u1", prefix, (c) => { out.push(c._id); return true; });
  return out;
}

describe("scanConversationsForPath", () => {
  test("finds a project_path-only conversation (the case the paginate version threw on)", async () => {
    const target = conv({ project_path: "/home/u/.codecast/doctor/e2e-x" });
    const ctx = fakeCtx([target, conv({ project_path: "/home/u/other" })]);
    expect(await collect(ctx, "/home/u/.codecast/doctor/e2e-x")).toEqual([target._id]);
  });

  test("git_root rows are matched via git_root and not double-visited via project_path", async () => {
    const repo = conv({ git_root: "/home/u/proj", project_path: "/home/u/proj/sub" });
    const ctx = fakeCtx([repo]);
    expect(await collect(ctx, "/home/u/proj")).toEqual([repo._id]);
  });

  test("sibling-prefix paths inside the index range are filtered out", async () => {
    const target = conv({ project_path: "/home/u/proj" });
    const sibling = conv({ project_path: "/home/u/proj-other" }); // >= prefix, < prefix+￿, but not a path match
    const ctx = fakeCtx([sibling, target]);
    expect(await collect(ctx, "/home/u/proj")).toEqual([target._id]);
  });

  test("visit returning false stops the scan", async () => {
    const a = conv({ project_path: "/p/x/a" });
    const b = conv({ project_path: "/p/x/b" });
    const ctx = fakeCtx([a, b]);
    const seen: string[] = [];
    await scanConversationsForPath(ctx, "u1", "/p/x", (c) => { seen.push(c._id); return false; });
    expect(seen.length).toBe(1);
  });

  test("a match beyond the first batch is still found (batch doubling, no skipped rows)", async () => {
    // 200 in-range sibling rows that fail the path-boundary filter, sorting
    // BEFORE the real match — the first take(128) is all misses and full, so
    // the scan must widen and re-scan rather than give up or skip.
    const rows = Array.from({ length: 200 }, (_, i) =>
      conv({ project_path: `/p/proj-decoy${String(i).padStart(3, "0")}` }));
    const target = conv({ project_path: "/p/proj/real" });
    const ctx = fakeCtx([...rows, target]);
    expect(await collect(ctx, "/p/proj")).toEqual([target._id]);
  });

  test("other users' conversations are invisible", async () => {
    const theirs = { ...conv({ project_path: "/p/x/a" }), user_id: "u2" };
    const ctx = fakeCtx([theirs]);
    expect(await collect(ctx, "/p/x")).toEqual([]);
  });
});
