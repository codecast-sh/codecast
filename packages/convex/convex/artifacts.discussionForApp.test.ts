// The phone's page screen reads a page's discussion through discussionForApp
// and resolves through setCommentStatusForApp. A reader the page admits sees
// its open comments; the owner sees the resolved ones too; a gated page shows
// nothing to a reader without its keys; only the owner flips a comment.
import { describe, expect, test } from "bun:test";
import { discussionForApp, setCommentStatusForApp } from "./artifacts";

function fakeCtx(viewer: string | null, rows: Record<string, any[]>) {
  const byId = new Map<string, any>();
  for (const table of Object.values(rows)) for (const r of table) byId.set(r._id, r);
  return {
    auth: { getUserIdentity: async () => (viewer ? { subject: `${viewer}|sess`, tokenIdentifier: "x" } : null) },
    db: {
      query: (table: string) => ({
        withIndex: (_i: string, builder?: any) => {
          const eqs: Array<[string, any]> = [];
          builder?.({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
          const hit = (rows[table] ?? []).filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
          return { collect: async () => hit, first: async () => hit[0] ?? null };
        },
      }),
      get: async (id: string) => byId.get(id) ?? null,
      patch: async (id: string, p: any) => Object.assign(byId.get(id), p),
      normalizeId: (_t: string, id: string) => (byId.has(id) ? id : null),
    },
  } as any;
}

const rows = () => ({
  artifacts: [
    { _id: "a1", slug: "openpage", user_id: "owner", title: "Open", version: 1, created_at: 1, updated_at: 5 },
    { _id: "a2", slug: "lockedpage", user_id: "owner", title: "Locked", version: 1, password_hash: "h", created_at: 1, updated_at: 1 },
  ],
  users: [{ _id: "owner", name: "Owner" }, { _id: "viewer", name: "Viewer" }],
  artifact_comments: [
    { _id: "c1", artifact_id: "a1", author_name: "V", author_email: "v@x.org", text: "open one", status: "open", created_at: 2, version: 1 },
    { _id: "c2", artifact_id: "a1", author_name: "V", text: "done one", status: "resolved", created_at: 1, version: 1 },
  ],
});

const run = (fn: any, ctx: any, args: any) => (fn._handler ?? fn.handler)(ctx, args);

describe("discussionForApp", () => {
  test("the owner sees every comment oldest first, emails stripped, in the pageThreads row shape", async () => {
    const got = await run(discussionForApp, fakeCtx("owner", rows()), { slug: "openpage" });
    expect(got).toMatchObject({ _id: "a1", slug: "openpage", title: "Open", user_id: "owner", comments_disabled: false });
    expect(got.comments.map((c: any) => c._id)).toEqual(["c2", "c1"]);
    expect(got.comments.every((c: any) => !("author_email" in c))).toBe(true);
  });

  test("another reader of an open page sees only its open comments", async () => {
    const got = await run(discussionForApp, fakeCtx("viewer", rows()), { slug: "openpage" });
    expect(got.comments.map((c: any) => c._id)).toEqual(["c1"]);
  });

  test("a gated page without keys, a missing page, or no sign-in returns null", async () => {
    expect(await run(discussionForApp, fakeCtx("viewer", rows()), { slug: "lockedpage" })).toBeNull();
    expect(await run(discussionForApp, fakeCtx("viewer", rows()), { slug: "nope" })).toBeNull();
    expect(await run(discussionForApp, fakeCtx(null, rows()), { slug: "openpage" })).toBeNull();
  });
});

describe("setCommentStatusForApp", () => {
  test("the owner resolves and reopens", async () => {
    const r = rows();
    const ctx = fakeCtx("owner", r);
    await run(setCommentStatusForApp, ctx, { comment_id: "c1", resolved: true });
    expect(r.artifact_comments[0].status).toBe("resolved");
    await run(setCommentStatusForApp, ctx, { comment_id: "c1", resolved: false });
    expect(r.artifact_comments[0].status).toBe("open");
  });

  test("anyone else is refused", async () => {
    const r = rows();
    await expect(run(setCommentStatusForApp, fakeCtx("viewer", r), { comment_id: "c1", resolved: true })).rejects.toThrow();
    expect(r.artifact_comments[0].status).toBe("open");
  });
});
