// listForWeb stamps every page with its workspace and lets a teammate's page
// through only when that workspace is a team the two share. Runs the handler
// against a tiny fake db (same shape as calls.test.ts).
import { describe, expect, test } from "bun:test";
import { GALLERY_LIMIT, listForWeb } from "./artifacts";

// `reads` counts every db read call, the unit Convex caps at 4,096 a query.
function fakeCtx(viewer: string, rows: Record<string, any[]>, reads = { n: 0 }) {
  const byId = new Map<string, any>();
  for (const table of Object.values(rows)) for (const r of table) byId.set(r._id, r);
  const result = (hit: any[]) => ({
    collect: async () => (reads.n++, hit),
    first: async () => (reads.n++, hit[0] ?? null),
    take: async (n: number) => (reads.n++, hit.slice(0, n)),
  });
  return {
    auth: { getUserIdentity: async () => ({ subject: `${viewer}|sess`, tokenIdentifier: "x" }) },
    db: {
      query: (table: string) => ({
        withIndex: (_i: string, builder: any) => {
          const eqs: Array<[string, any]> = [];
          builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
          const hit = (rows[table] ?? []).filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
          return {
            ...result(hit),
            order: (dir: "asc" | "desc") =>
              result([...hit].sort((a, b) => (dir === "desc" ? b.updated_at - a.updated_at : a.updated_at - b.updated_at))),
          };
        },
      }),
      get: async (id: string) => (reads.n++, byId.get(id) ?? null),
    },
  } as any;
}

const page = (id: string, user_id: string, extra: Record<string, any> = {}) => ({
  _id: id, slug: id, user_id, title: id, storage_id: "s", size: 1, version: 1,
  created_at: 1, updated_at: 1, ...extra,
});

describe("listForWeb workspace scoping", () => {
  test("stamps each page's workspace and keeps teammates' pages to shared teams", async () => {
    const ctx = fakeCtx("u1", {
      users: [{ _id: "u1", name: "Me" }, { _id: "u2", name: "Mate" }],
      team_memberships: [
        { _id: "m1", user_id: "u1", team_id: "t1" },
        { _id: "m2", user_id: "u2", team_id: "t1", visibility: "full" },
        { _id: "m3", user_id: "u2", team_id: "t2", visibility: "full" },
      ],
      conversations: [
        { _id: "c1", team_id: "t1" },
        { _id: "c2", team_id: "t2" },
        { _id: "c3", team_id: "t1", is_private: true },
      ],
      tasks: [{ _id: "k1", user_id: "u2", workspace: "team:t1" }],
      artifacts: [
        page("mine-team", "u1", { session_conversation_id: "c1" }),
        page("mine-solo", "u1"),
        page("mate-shared", "u2", { session_conversation_id: "c1" }),
        page("mate-task", "u2", { session_conversation_id: "c2", task_id: "k1" }),
        page("mate-other-team", "u2", { session_conversation_id: "c2" }),
        page("mate-private", "u2", { session_conversation_id: "c3" }),
        page("mate-solo", "u2"),
      ],
    });
    const handler = (listForWeb as any)._handler ?? (listForWeb as any).handler;
    const { artifacts } = await handler(ctx, {});
    const got = Object.fromEntries(artifacts.map((a: any) => [a.slug, [a.workspace, a.author_id, a.mine]]));
    expect(got).toEqual({
      "mine-team": ["team:t1", "u1", true],
      "mine-solo": ["user:u1", "u1", true],
      "mate-shared": ["team:t1", "u2", false],
      "mate-task": ["team:t1", "u2", false],
    });
  });
});

describe("listForWeb read budget", () => {
  test("an account with thousands of pages stays under Convex's read cap and gets its newest pages", async () => {
    const pages: any[] = [];
    const tasks: any[] = [];
    for (const owner of ["u1", "u2", "u3"]) {
      for (let i = 0; i < 2000; i++) {
        const task_id = `${owner}-k${i}`;
        tasks.push({ _id: task_id, user_id: owner, workspace: "team:t1" });
        pages.push(page(`${owner}-p${i}`, owner, { task_id, updated_at: i * 3 + (owner === "u2" ? 1 : 0) }));
      }
    }
    const reads = { n: 0 };
    const ctx = fakeCtx("u1", {
      users: [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }],
      team_memberships: [
        { _id: "m1", user_id: "u1", team_id: "t1" },
        { _id: "m2", user_id: "u2", team_id: "t1", visibility: "full" },
        { _id: "m3", user_id: "u3", team_id: "t1", visibility: "full" },
      ],
      tasks,
      artifacts: pages,
    }, reads);
    const handler = (listForWeb as any)._handler ?? (listForWeb as any).handler;
    const { artifacts } = await handler(ctx, {});
    expect(reads.n).toBeLessThan(4096);
    expect(artifacts).toHaveLength(GALLERY_LIMIT);
    expect(artifacts[0].slug).toBe("u2-p1999");
    const times = artifacts.map((a: any) => a.updated_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

// ct-88526: prod still hit the cap (eg-2812) after the per-owner scan cap,
// because the scan grows with team size: every teammate adds up to
// GALLERY_SCAN_PER_OWNER pages, each costing a workspace read, hidden ones too.
describe("listForWeb read budget on a big team", () => {
  test("a 20-member team with hundreds of pages each, half hidden, stays under the cap", async () => {
    const members = Array.from({ length: 20 }, (_, i) => `u${i + 1}`);
    const pages: any[] = [];
    const conversations: any[] = [];
    const comments: any[] = [];
    for (const owner of members) {
      for (let i = 0; i < 600; i++) {
        const conv = `${owner}-c${i}`;
        conversations.push({ _id: conv, team_id: i % 2 ? "t2" : "t1" });
        const id = `${owner}-p${i}`;
        pages.push(page(id, owner, { session_conversation_id: conv, updated_at: i * members.length + members.indexOf(owner) }));
        for (let c = 0; c < 5; c++) comments.push({ _id: `${id}-m${c}`, artifact_id: id, status: c ? "resolved" : "open" });
      }
    }
    const reads = { n: 0 };
    const ctx = fakeCtx("u1", {
      users: members.map((_id) => ({ _id })),
      team_memberships: [
        ...members.map((u, i) => ({ _id: `m${i}`, user_id: u, team_id: "t1", visibility: "full" })),
        ...members.slice(1).map((u, i) => ({ _id: `n${i}`, user_id: u, team_id: "t2", visibility: "full" })),
      ],
      conversations,
      artifact_comments: comments,
      artifacts: pages,
    }, reads);
    const handler = (listForWeb as any)._handler ?? (listForWeb as any).handler;
    const { artifacts } = await handler(ctx, {});
    expect(reads.n).toBeLessThan(4096);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((a: any) => a.workspace === "team:t1" || a.mine)).toBe(true);
  });
});

// F48: team editing reaches exactly the pages listForWeb shows a teammate:
// members of the page's own team, never of every team the owner is in.
import { teamEditAuth } from "./artifacts";

describe("teamEditAuth scope", () => {
  const rows = () => ({
    users: [{ _id: "u1", name: "Owner" }, { _id: "u2", name: "Mate" }, { _id: "u3", name: "Other" }],
    team_memberships: [
      { _id: "m1", user_id: "u1", team_id: "t1", visibility: "full" },
      { _id: "m2", user_id: "u2", team_id: "t1" },
      { _id: "m3", user_id: "u1", team_id: "t2", visibility: "full" },
      { _id: "m4", user_id: "u3", team_id: "t2" },
    ],
    conversations: [{ _id: "c1", team_id: "t1" }],
    artifacts: [
      page("team-page", "u1", { session_conversation_id: "c1", edit_mode: "team" }),
      page("solo-page", "u1", { edit_mode: "team" }),
    ],
  });
  const run = (slug: string, editor: string) =>
    ((teamEditAuth as any)._handler)(fakeCtx(editor, rows()), { slug, editor_user_id: editor });

  test("a member of the page's team may edit; a member of the owner's other team may not", async () => {
    expect((await run("team-page", "u2"))?.is_owner).toBe(false);
    expect(await run("team-page", "u3")).toBeNull();
  });

  test("a page in the owner's personal space has no team editors", async () => {
    expect(await run("solo-page", "u2")).toBeNull();
    expect((await run("solo-page", "u1"))?.is_owner).toBe(true);
  });
});
