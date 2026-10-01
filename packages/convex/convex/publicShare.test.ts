import { describe, expect, test } from "bun:test";
import { claimShareToken, getSharedCall, writeObjectShareLink } from "./publicShare";

const UUID_A = "1a221088-1fc3-48c8-a814-71119676adf0";
const UUID_B = "4c7c324f-3077-486a-a63c-65f188d18a0c";

// A db holding rows of one table, with the by_share_token / by_transcript_seq
// lookups claimShareToken and getSharedCall make.
function fakeDb(rows: Array<Record<string, any>>, segments: Array<Record<string, any>> = []) {
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db = {
    normalizeId: (_table: string, id: string) => (byId.has(id) ? id : null),
    async get(id: string) {
      return byId.get(id) ?? null;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      patches.push({ id, patch });
      byId.set(id, { ...byId.get(id), ...patch });
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
  return { db, patches, byId };
}

describe("claimShareToken", () => {
  test("turns the link on with a well-formed token and off with null", async () => {
    const { db, byId } = fakeDb([{ _id: "t1" }]);
    await claimShareToken({ db } as any, "tasks", byId.get("t1") as any, UUID_A);
    expect(byId.get("t1")?.share_token).toBe(UUID_A);
    await claimShareToken({ db } as any, "tasks", byId.get("t1") as any, null);
    expect(byId.get("t1")?.share_token).toBeUndefined();
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
    await expect(writeObjectShareLink({ db } as any, "u1" as any, "project", "x", UUID_A)).rejects.toThrow(/Unknown share kind/);
    await expect(writeObjectShareLink({ db } as any, "u1" as any, "task", "missing", UUID_A)).rejects.toThrow(/Not found/);
    expect(patches).toHaveLength(0);
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

  test("an unknown token is null", async () => {
    const { db } = fakeDb([]);
    expect(await (getSharedCall as any)._handler({ db }, { share_token: UUID_B })).toBeNull();
  });
});
