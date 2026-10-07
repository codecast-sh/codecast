import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { CALL_LINK_REFUSED_WORDS, channelRoomKey } from "@codecast/shared/contracts";
import schema from "./schema";
import { claimShareToken, getSharedCall, getSharedProject, writeObjectShareLink } from "./publicShare";

const UUID_A = "1a221088-1fc3-48c8-a814-71119676adf0";
const UUID_B = "4c7c324f-3077-486a-a63c-65f188d18a0c";

// A db holding rows of one table, with the by_share_token / by_transcript_seq
// lookups claimShareToken and getSharedCall make.
function fakeDb(rows: Array<Record<string, any>>, segments: Array<Record<string, any>> = []) {
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; row: Record<string, any> }> = [];
  const db = {
    normalizeId: (_table: string, id: string) => (byId.has(id) ? id : null),
    async get(id: string) {
      return byId.get(id) ?? null;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      patches.push({ id, patch });
      byId.set(id, { ...byId.get(id), ...patch });
    },
    async insert(table: string, row: Record<string, any>) {
      inserts.push({ table, row });
      return `${table}_${inserts.length}`;
    },
    query(table: string) {
      const eqs: Record<string, unknown> = {};
      const q = { eq: (f: string, v: unknown) => ((eqs[f] = v), q) };
      return {
        withIndex(_name: string, fn: (q: unknown) => unknown) {
          fn(q);
          const hits = () =>
            table === "transcript_segments"
              ? segments.filter((s) => s.transcript_id === eqs.transcript_id)
              : [...byId.values()].filter((r) => r.share_token === eqs.share_token);
          return {
            first: async () => hits()[0] ?? null,
            collect: async () => hits(),
          };
        },
      };
    },
  };
  return { db, patches, inserts, byId };
}

describe("claimShareToken", () => {
  test("turns the link on with a well-formed token and off with null", async () => {
    const { db, byId, inserts } = fakeDb([{ _id: "t1" }]);
    await claimShareToken({ db } as any, "tasks", byId.get("t1") as any, UUID_A, "u1" as any);
    expect(byId.get("t1")?.share_token).toBe(UUID_A);
    await claimShareToken({ db } as any, "tasks", byId.get("t1") as any, null, "u1" as any);
    expect(byId.get("t1")?.share_token).toBeUndefined();
    expect(inserts.map((i) => [i.table, i.row.kind, i.row.actor_user_id])).toEqual([
      ["authority_events", "share_link_minted", "u1"],
      ["authority_events", "share_link_revoked", "u1"],
    ]);
  });

  test("refuses a token another row already serves, so a link cannot be re-aimed", async () => {
    const { db, byId, patches } = fakeDb([{ _id: "t1", share_token: UUID_A }, { _id: "t2" }]);
    await expect(claimShareToken({ db } as any, "tasks", byId.get("t2") as any, UUID_A)).rejects.toThrow(/Invalid share token/);
    expect(patches).toHaveLength(0);
  });

  test("refuses a guessable token and keeps an existing one without writing", async () => {
    const { db, byId, patches } = fakeDb([{ _id: "t1", share_token: UUID_B }]);
    await expect(claimShareToken({ db } as any, "tasks", byId.get("t1") as any, "abc123")).rejects.toThrow(/Invalid share token/);
    await claimShareToken({ db } as any, "tasks", byId.get("t1") as any, UUID_B);
    expect(patches).toHaveLength(0);
  });
});

describe("writeObjectShareLink", () => {
  test("an unknown kind or a missing row writes nothing", async () => {
    const { db, patches } = fakeDb([]);
    await expect(writeObjectShareLink({ db } as any, "u1" as any, "spaceship", "x", UUID_A)).rejects.toThrow(/Unknown share kind/);
    await expect(writeObjectShareLink({ db } as any, "u1" as any, "task", "missing", UUID_A)).rejects.toThrow(/Not found/);
    expect(patches).toHaveLength(0);
  });
});

// A call's link opens by the people who sat through it (or a team admin) and
// closes by any reader: a channel huddle is readable by the whole channel,
// and somebody who was never in the room must not put its words, guests'
// included, on the open web (lib/callRecordingRuns.mayPublishCall).
describe("a call's public link", () => {
  const modules = {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
  };
  async function channelCall() {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const ids = await t.run(async (ctx: any) => {
      const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true, chat: true } });
      const [ana, ben, ada] = await Promise.all(["Ana", "Ben", "Ada"].map((name) => ctx.db.insert("users", { name })));
      for (const [u, role] of [[ana, "member"], [ben, "member"], [ada, "admin"]] as const) {
        await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role, joined_at: now });
      }
      const channel = await ctx.db.insert("chat_channels", { team_id: team, name: "design", kind: "public", created_by: ana, created_at: now, updated_at: now });
      const call = await ctx.db.insert("transcripts", {
        room_key: channelRoomKey(String(channel)),
        team_id: team,
        started_by: ana,
        status: "ended",
        started_at: now,
        ended_at: now + 60_000,
        participants: [{ id: String(ana), name: "Ana" }, { id: "guest:g1", name: "Dana (guest)" }],
        routes: [],
        last_seq: 0,
      });
      return { team, ana, ben, ada, call };
    });
    const share = (who: string, token: string | null) =>
      t.run(async (ctx: any) => writeObjectShareLink(ctx, who as any, "call", String(ids.call), token));
    const token = () => t.run(async (ctx: any) => (await ctx.db.get(ids.call))?.share_token ?? null);
    return { t, ...ids, share, token };
  }

  test("a channel member who was not in the call may not open it, and may close it", async () => {
    const c = await channelCall();
    await expect(c.share(String(c.ben), UUID_A)).rejects.toThrow(CALL_LINK_REFUSED_WORDS);
    expect(await c.token()).toBeNull();
    await c.share(String(c.ana), UUID_A);
    expect(await c.token()).toBe(UUID_A);
    // Keeping the link it already has is not opening it.
    await c.share(String(c.ben), UUID_A);
    await c.share(String(c.ben), null);
    expect(await c.token()).toBeNull();
  });

  test("turning it on or off is a line in the room's thread, once per change, naming who", async () => {
    const c = await channelCall();
    const lines = () =>
      c.t.run(async (ctx: any) => (await ctx.db.query("call_chat_messages").collect()).map((r: any) => [r.event, String(r.user_id), String(r.transcript_id)]));
    await c.share(String(c.ana), UUID_A);
    // Keeping the link it already has changes nothing, and says nothing.
    await c.share(String(c.ana), UUID_A);
    await c.share(String(c.ben), null);
    await c.share(String(c.ben), null);
    expect(await lines()).toEqual([
      ["link_on", String(c.ana), String(c.call)],
      ["link_off", String(c.ben), String(c.call)],
    ]);
  });

  test("a speaker and a team admin may open it", async () => {
    const c = await channelCall();
    await c.share(String(c.ana), UUID_A);
    expect(await c.token()).toBe(UUID_A);
    await c.share(String(c.ana), null);
    await c.share(String(c.ada), UUID_B);
    expect(await c.token()).toBe(UUID_B);
  });
});

describe("getSharedCall", () => {
  test("a stranger reads names and words but never a user id", async () => {
    const call = {
      _id: "c1",
      share_token: UUID_A,
      room_key: "team:abc",
      status: "ended",
      started_at: 1,
      ended_at: 2,
      title: "Standup",
      participants: [{ id: "user_secret_1", name: "Ada Lovelace" }],
      summary: "Talked.",
      action_items: ["Ship"],
    };
    const { db } = fakeDb([call], [
      { transcript_id: "c1", seq: 1, speaker_id: "user_secret_1", speaker_name: "Ada Lovelace", text: "hi", t0: 0, t1: 5 },
    ]);
    const ctx = { db, storage: { getUrl: async () => null } };
    const out = await (getSharedCall as any)._handler(ctx, { share_token: UUID_A });
    expect(out.title).toBe("Standup");
    expect(out.segments[0].text).toBe("hi");
    expect(out.segments[0].speaker_id).toBe(out.participants[0].id);
    expect(JSON.stringify(out)).not.toContain("user_secret_1");
    expect(JSON.stringify(out)).not.toContain("team:abc");
  });

  test("a deleted team's call serves nothing, and a restore brings the link back", async () => {
    const call = { _id: "c1", team_id: "team1", share_token: UUID_A, room_key: "team:abc", status: "ended", started_at: 1, participants: [] };
    const team = { _id: "team1", deleted_at: 5 };
    const { db } = fakeDb([call, team]);
    const ctx = { db, storage: { getUrl: async () => null } };
    expect(await (getSharedCall as any)._handler(ctx, { share_token: UUID_A })).toBeNull();
    await db.patch("team1", { deleted_at: undefined });
    expect((await (getSharedCall as any)._handler(ctx, { share_token: UUID_A }))?.status).toBe("ended");
  });

  test("an unknown token is null", async () => {
    const { db } = fakeDb([]);
    expect(await (getSharedCall as any)._handler({ db }, { share_token: UUID_B })).toBeNull();
  });
});

describe("getSharedProject", () => {
  test("carries only the work filed in the project's own workspace", async () => {
    const project = { _id: "p1", user_id: "u1", workspace: "team:t1", title: "Launch", status: "active", share_token: UUID_A, created_at: 1, updated_at: 2 };
    const tasks = [
      { _id: "k1", project_id: "p1", workspace: "team:t1", short_id: "ct-1", title: "Ours", status: "open", priority: "high", updated_at: 1 },
      { _id: "k2", project_id: "p1", workspace: "user:u9", short_id: "ct-2", title: "Someone's private", status: "open", priority: "low", updated_at: 1 },
    ];
    const db = {
      get: async (id: string) => (id === "u1" ? { name: "Ada" } : null),
      query: (table: string) => ({
        withIndex: (_n: string, fn: (q: any) => any) => {
          const eqs: Record<string, unknown> = {};
          const q = { eq: (f: string, v: unknown) => ((eqs[f] = v), q) };
          fn(q);
          const rows = table === "projects" ? [project] : table === "tasks" ? tasks : [];
          const hits = rows.filter((r: any) => Object.entries(eqs).every(([k, v]) => r[k] === v));
          return { first: async () => hits[0] ?? null, collect: async () => hits };
        },
      }),
    };
    const out = await (getSharedProject as any)._handler({ db }, { share_token: UUID_A });
    expect(out.title).toBe("Launch");
    expect(out.tasks.map((t: any) => t.title)).toEqual(["Ours"]);
    expect(JSON.stringify(out)).not.toContain("u1");
  });
});
