import { describe, expect, test } from "bun:test";
import {
  matchBucketByName,
  findActiveBucketByExactName,
  resolveOrCreateBucket,
  assignConversationToBucketForUser,
  createBucketForUser,
  webAssignV2,
  webCreateV2,
  webListV2,
  webUpdateV2,
} from "./buckets";

// A tiny in-memory stand-in for Convex's ctx.db, sufficient for the bucket write
// helpers: per-table arrays, the two indexes those helpers query, and
// insert/patch/get. Mirrors the hand-rolled fake in conversationSessionLookup.test.ts.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    inbox_buckets: [],
    bucket_assignments: [],
    local_view_heads: [],
    local_command_receipts: [],
    conversations: [],
    ...seed,
  };
  let counter = 0;
  return {
    _tables: tables,
    query(table: string) {
      return {
        withIndex(_index: string, builder: (q: any) => any) {
          const eqs: Array<[string, any]> = [];
          builder({
            eq(field: string, value: any) {
              eqs.push([field, value]);
              return this;
            },
          });
          const rows = (tables[table] ?? []).filter((r) =>
            eqs.every(([f, v]) => String(r[f]) === String(v)),
          );
          return {
            collect: async () => rows,
            first: async () => rows[0] ?? null,
            unique: async () => {
              if (rows.length > 1) throw new Error("Expected a unique indexed row");
              return rows[0] ?? null;
            },
          };
        },
      };
    },
    async insert(table: string, doc: any) {
      const _id = `${table}-${++counter}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, fields: any) {
      for (const rows of Object.values(tables)) {
        const row = rows.find((r) => r._id === id);
        if (row) Object.assign(row, fields);
      }
    },
    async get(id: string) {
      for (const rows of Object.values(tables)) {
        const row = rows.find((r) => r._id === id);
        if (row) return row;
      }
      return null;
    },
  };
}

const USER = "user-1" as any;

function webCtx(db: ReturnType<typeof fakeDb>, userId: string | null = USER) {
  return {
    db,
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
  } as any;
}

describe("findActiveBucketByExactName", () => {
  const buckets = [
    { _id: "b1", name: "API", archived_at: undefined },
    { _id: "b2", name: "apiv2", archived_at: undefined },
    { _id: "b3", name: "gone", archived_at: 123 },
  ] as any[];

  test("matches case-insensitively but exactly — never the substring sibling", async () => {
    expect((await findActiveBucketByExactName(buckets, "api"))?._id).toBe("b1");
    expect((await findActiveBucketByExactName(buckets, "APIV2"))?._id).toBe("b2");
  });

  test("ignores archived labels and unknown names", async () => {
    expect(await findActiveBucketByExactName(buckets, "gone")).toBeNull();
    expect(await findActiveBucketByExactName(buckets, "nope")).toBeNull();
  });
});

describe("resolveOrCreateBucket", () => {
  test("creates a label on first use, then reuses it (no duplicate)", async () => {
    const db = fakeDb();
    const ctx = { db } as any;

    const first = await resolveOrCreateBucket(ctx, USER, "api");
    expect(first.created).toBe(true);
    expect(db._tables.inbox_buckets).toHaveLength(1);

    // Same name, different casing + whitespace → same bucket, no new row.
    const second = await resolveOrCreateBucket(ctx, USER, "  API ");
    expect(second.created).toBe(false);
    expect(second.bucketId).toBe(first.bucketId);
    expect(db._tables.inbox_buckets).toHaveLength(1);
  });

  test("a near-name does NOT fuzzy-match — it creates a distinct label", async () => {
    const db = fakeDb();
    const ctx = { db } as any;
    await resolveOrCreateBucket(ctx, USER, "apiv2");
    const fresh = await resolveOrCreateBucket(ctx, USER, "api");
    expect(fresh.created).toBe(true);
    expect(db._tables.inbox_buckets).toHaveLength(2);
  });

  test("new labels sort after existing ones (max sort_order + 1024)", async () => {
    const db = fakeDb();
    const ctx = { db } as any;
    await createBucketForUser(ctx, USER, { name: "first" });
    await createBucketForUser(ctx, USER, { name: "second" });
    const orders = db._tables.inbox_buckets.map((b: any) => b.sort_order);
    expect(orders[1]).toBeGreaterThan(orders[0]);
  });

  test("blank name is rejected", async () => {
    const db = fakeDb();
    const ctx = { db } as any;
    await expect(resolveOrCreateBucket(ctx, USER, "   ")).rejects.toThrow(/required/i);
  });
});

describe("assignConversationToBucketForUser", () => {
  test("inserts then upserts the single (user, conversation) row — never a second", async () => {
    const db = fakeDb();
    const ctx = { db } as any;
    const conv = "conv-1" as any;

    await assignConversationToBucketForUser(ctx, USER, conv, "b1" as any);
    expect(db._tables.bucket_assignments).toHaveLength(1);
    expect(db._tables.bucket_assignments[0].bucket_id).toBe("b1");

    // Re-file under a different label: same row, updated in place.
    await assignConversationToBucketForUser(ctx, USER, conv, "b2" as any);
    expect(db._tables.bucket_assignments).toHaveLength(1);
    expect(db._tables.bucket_assignments[0].bucket_id).toBe("b2");

    // Unfile (null): the tombstone row survives with no bucket.
    await assignConversationToBucketForUser(ctx, USER, conv, null);
    expect(db._tables.bucket_assignments).toHaveLength(1);
    expect(db._tables.bucket_assignments[0].bucket_id).toBeUndefined();
  });
});

describe("matchBucketByName (existing helper, used by rename/rm)", () => {
  const buckets = [{ _id: "b1", name: "backend" }, { _id: "b2", name: "frontend" }] as any[];

  test("exact wins, substring falls back, miss lists the catalog", () => {
    expect((matchBucketByName(buckets, "backend") as any)._id).toBe("b1");
    expect((matchBucketByName(buckets, "front") as any)._id).toBe("b2");
    const miss = matchBucketByName(buckets, "zzz");
    expect("error" in miss && miss.error).toContain("backend, frontend");
  });
});

describe("buckets v2 complete view and command receipts", () => {
  test("auth unavailability is explicit and cannot masquerade as an empty catalog", async () => {
    const result = await (webListV2 as any)._handler(webCtx(fakeDb(), null), {});
    expect(result).toEqual({
      contractId: "buckets.principal/v2",
      viewKey: "buckets:principal",
      access: "unauthenticated",
    });
    expect("buckets" in result).toBe(false);
  });

  test("an authenticated empty catalog is a granted complete view at revision zero", async () => {
    const result = await (webListV2 as any)._handler(webCtx(fakeDb()), {});
    expect(result.access).toBe("granted");
    expect(result.viewRevision).toBe(0);
    expect(result.buckets).toEqual([]);
    expect(result.assignments).toEqual([]);
  });

  test("create is atomic with a revision receipt and exact replay is side-effect free", async () => {
    const db = fakeDb();
    const ctx = webCtx(db);
    const args = { command_id: "cmd-create", name: "Infra", color: "blue" };
    const first = await (webCreateV2 as any)._handler(ctx, args);
    const replay = await (webCreateV2 as any)._handler(ctx, args);
    expect(replay).toEqual(first);
    expect(db._tables.inbox_buckets).toHaveLength(1);
    expect(db._tables.local_command_receipts).toHaveLength(1);
    expect(first.coverage).toEqual([{
      contractId: "buckets.principal/v2",
      viewKey: "buckets:principal",
      revision: 1,
    }]);

    const view = await (webListV2 as any)._handler(ctx, {});
    expect(view.viewRevision).toBe(1);
    expect(view.buckets.map((bucket: any) => bucket.name)).toEqual(["Infra"]);
  });

  test("update and assignment each cover the same complete atomic view", async () => {
    const db = fakeDb({
      inbox_buckets: [{ _id: "b1", user_id: USER, name: "Before", created_at: 1, updated_at: 1 }],
      conversations: [{ _id: "c1", user_id: USER }],
    });
    const ctx = webCtx(db);
    const updated = await (webUpdateV2 as any)._handler(ctx, {
      command_id: "cmd-update",
      bucket_id: "b1",
      name: "After",
    });
    const assigned = await (webAssignV2 as any)._handler(ctx, {
      command_id: "cmd-assign",
      conversation_id: "c1",
      bucket_id: "b1",
    });
    expect(updated.coverage[0].revision).toBe(1);
    expect(assigned.coverage[0].revision).toBe(2);
    expect(db._tables.bucket_assignments).toHaveLength(1);
    expect(db._tables.inbox_buckets[0].name).toBe("After");
  });

  test("foreign relationship rejection is durable and does not move view coverage", async () => {
    const db = fakeDb({
      conversations: [{ _id: "foreign", user_id: "someone-else" }],
    });
    const ctx = webCtx(db);
    const args = { command_id: "cmd-foreign", conversation_id: "foreign" };
    const first = await (webAssignV2 as any)._handler(ctx, args);
    const replay = await (webAssignV2 as any)._handler(ctx, args);
    expect(first.status).toBe("rejected");
    expect(first.rejection.code).toBe("NOT_FOUND");
    expect(replay).toEqual(first);
    expect(db._tables.bucket_assignments).toEqual([]);
    expect(db._tables.local_view_heads).toEqual([]);
  });
});
