import { describe, expect, test } from "bun:test";
import {
  matchBucketByName,
  findActiveBucketByExactName,
  resolveOrCreateBucket,
  assignConversationToBucketForUser,
  createBucketForUser,
} from "./buckets";

// A tiny in-memory stand-in for Convex's ctx.db, sufficient for the bucket write
// helpers: per-table arrays, the two indexes those helpers query, and
// insert/patch/get. Mirrors the hand-rolled fake in conversationSessionLookup.test.ts.
function fakeDb(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    inbox_buckets: [],
    bucket_assignments: [],
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
