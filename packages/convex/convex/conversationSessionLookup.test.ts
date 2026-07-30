import { describe, expect, test } from "bun:test";
import { findConversationBySessionReference, findConversationByAnyRef, findConversationByAnyRefWhere, resolveConversationRefRanked } from "./conversationSessionLookup";

const createLookupCtx = ({
  conversationsBySessionId = {},
  managedSessionsBySessionId = {},
  conversationsById = {},
  conversationsByShortId = {},
}: {
  conversationsBySessionId?: Record<string, any>;
  managedSessionsBySessionId?: Record<string, any>;
  conversationsById?: Record<string, any>;
  conversationsByShortId?: Record<string, any>;
}) => ({
  db: {
    query(table: string) {
      return {
        withIndex(indexName: string, builder: (query: { eq(fieldName: string, value: string): unknown }) => unknown) {
          let matchedValue = "";
          builder({
            eq(_fieldName: string, value: string) {
              matchedValue = value;
              return value;
            },
          });

          const single = () => {
            if (table === "conversations" && indexName === "by_session_id") {
              return conversationsBySessionId[matchedValue] ?? null;
            }
            if (table === "managed_sessions" && indexName === "by_session_id") {
              return managedSessionsBySessionId[matchedValue] ?? null;
            }
            return null;
          };
          // by_short_id can be a single conversation or an array (collision case).
          const shortIdMatches = () => {
            const v = conversationsByShortId[matchedValue];
            if (!v) return [];
            return Array.isArray(v) ? v : [v];
          };
          return {
            async first() {
              if (table === "conversations" && indexName === "by_short_id") {
                return shortIdMatches()[0] ?? null;
              }
              return single();
            },
            async take(_n: number) {
              if (table === "conversations" && indexName === "by_short_id") {
                return shortIdMatches();
              }
              const one = single();
              return one ? [one] : [];
            },
          };
        },
      };
    },
    async get(id: string) {
      return conversationsById[id] ?? null;
    },
  },
});

describe("findConversationBySessionReference", () => {
  test("returns the direct conversation match when the session id is current", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "session-1" };
    const result = await findConversationBySessionReference(
      createLookupCtx({ conversationsBySessionId: { "session-1": conversation } }),
      "session-1",
      "user-1"
    );

    expect(result).toEqual(conversation);
  });

  test("falls back through managed_sessions when the conversation session id is stale", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "old-session" };
    const result = await findConversationBySessionReference(
      createLookupCtx({
        managedSessionsBySessionId: {
          "new-session": { _id: "managed-1", user_id: "user-1", conversation_id: "conv-1" },
        },
        conversationsById: { "conv-1": conversation },
      }),
      "new-session",
      "user-1"
    );

    expect(result).toEqual(conversation);
  });

  test("ignores managed session matches for a different user", async () => {
    const result = await findConversationBySessionReference(
      createLookupCtx({
        managedSessionsBySessionId: {
          "new-session": { _id: "managed-1", user_id: "user-2", conversation_id: "conv-1" },
        },
        conversationsById: {
          "conv-1": { _id: "conv-1", user_id: "user-2", session_id: "old-session" },
        },
      }),
      "new-session",
      "user-1"
    );

    expect(result).toBeNull();
  });
});

// Full-id-wins: on a real deployment ctx.db.normalizeId exists, and a ref that
// normalizes to a conversations id must resolve by db.get BEFORE the short-id
// scan — short_id is _id.slice(0,7), so a full id's prefix can collide with a
// DIFFERENT conversation's short_id, and the scan would let a newer accepted
// collision shadow the id's true target (the ct-40176 device-move hazard).
describe("findConversationByAnyRefWhere full-id-wins (normalizeId present)", () => {
  const withNormalizeId = (ctx: any, conversationsById: Record<string, any>) => {
    ctx.db.normalizeId = (_table: string, id: string) => (conversationsById[id] ? id : null);
    return ctx;
  };

  test("a full id resolves to its own row even when its prefix collides with another short_id", async () => {
    const target = { _id: "jx7c6zktargettargettargettarget0", user_id: "user-1" };
    const collider = { _id: "jx7c6zkcollider", user_id: "user-1", short_id: "jx7c6zk" };
    const byId = { [target._id]: target };
    const ctx = withNormalizeId(
      createLookupCtx({ conversationsById: byId, conversationsByShortId: { "jx7c6zk": collider } }),
      byId,
    );
    const result = await findConversationByAnyRefWhere(ctx, target._id, () => true);
    expect(result).toEqual(target);
  });

  test("a full id the caller can't access returns null — never falls back to a prefix collision", async () => {
    const target = { _id: "jx7c6zktargettargettargettarget0", user_id: "user-2" };
    const collider = { _id: "jx7c6zkcollider", user_id: "user-1", short_id: "jx7c6zk" };
    const byId = { [target._id]: target };
    const ctx = withNormalizeId(
      createLookupCtx({ conversationsById: byId, conversationsByShortId: { "jx7c6zk": collider } }),
      byId,
    );
    const result = await findConversationByAnyRefWhere(
      ctx, target._id, (c: any) => c.user_id === "user-1",
    );
    expect(result).toBeNull();
  });

  test("a foreign-table id (normalizeId → null) is rejected, not blindly db.get'd", async () => {
    // db.get would happily return this doc (it's in another table); with
    // normalizeId present the legacy last-resort must never run.
    const foreignDoc = { _id: "kd7sometaskid0000000000000000000", user_id: "user-1" };
    const ctx = withNormalizeId(
      createLookupCtx({ conversationsById: { [foreignDoc._id]: foreignDoc } }),
      {}, // normalizeId: not a conversations id
    );
    const result = await findConversationByAnyRefWhere(ctx, foreignDoc._id, () => true);
    expect(result).toBeNull();
  });

  test("a non-conversation ref (normalizeId → null) still resolves via session_id", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "uuid-session" };
    const ctx = withNormalizeId(
      createLookupCtx({ conversationsBySessionId: { "uuid-session": conversation } }),
      {},
    );
    const result = await findConversationByAnyRefWhere(ctx, "uuid-session", () => true);
    expect(result).toEqual(conversation);
  });
});

describe("findConversationByAnyRef", () => {
  test("resolves a short_id (what users type for `cast send`)", async () => {
    const conversation = { _id: "jx7c6zkfull", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsByShortId: { "jx7c6zk": conversation } }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("truncates a long paste to the 7-char short_id", async () => {
    const conversation = { _id: "jx7c6zkfull", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsByShortId: { "jx7c6zk": conversation } }),
      "jx7c6zkfull0000",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("falls back to a Claude session_id (what detectCurrentSessionId returns for --from)", async () => {
    const conversation = { _id: "conv-1", user_id: "user-1", session_id: "uuid-session" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsBySessionId: { "uuid-session": conversation } }),
      "uuid-session",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("falls back to a direct conversation _id", async () => {
    const conversation = { _id: "conv-direct", user_id: "user-1" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsById: { "conv-direct": conversation } }),
      "conv-direct",
      "user-1"
    );
    expect(result).toEqual(conversation);
  });

  test("refuses a short_id belonging to another user (no cross-user messaging)", async () => {
    const result = await findConversationByAnyRef(
      createLookupCtx({
        conversationsByShortId: { "jx7c6zk": { _id: "x", user_id: "user-2", short_id: "jx7c6zk" } },
      }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toBeNull();
  });

  test("picks the user's own conversation when a short_id collides across users", async () => {
    // Real-world case: two conversations share the 7-char prefix, the other
    // user's sorts first. A bare .first() would grab theirs and fail the owner
    // check — the resolver must scan for the caller's own match.
    const mine = { _id: "jx7c6zkMINE", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({
        conversationsByShortId: {
          "jx7c6zk": [
            { _id: "jx7c6zkOTHER", user_id: "user-2", short_id: "jx7c6zk" },
            mine,
          ],
        },
      }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toEqual(mine);
  });

  test("returns null for an empty ref", async () => {
    const result = await findConversationByAnyRef(createLookupCtx({}), "  ", "user-1");
    expect(result).toBeNull();
  });

  test("prefers the NEWEST own conversation when the user owns several colliders", async () => {
    // Index scans ascend by creation time; the fake db stores candidates in
    // that order. Short ids circulate for recent sessions, so newest must win.
    const older = { _id: "jx7c6zkOLD", user_id: "user-1", short_id: "jx7c6zk" };
    const newer = { _id: "jx7c6zkNEW", user_id: "user-1", short_id: "jx7c6zk" };
    const result = await findConversationByAnyRef(
      createLookupCtx({ conversationsByShortId: { "jx7c6zk": [older, newer] } }),
      "jx7c6zk",
      "user-1"
    );
    expect(result).toEqual(newer);
  });
});

describe("resolveConversationRefRanked", () => {
  const never = () => false;

  test("caller's own session wins over someone else's OLDER collider (cast read jx75d4p regression)", async () => {
    // The bug: .first() returned the oldest collider — another user's private
    // conversation — so `cast read <short-id>` said "Access denied" for the
    // caller's own session.
    const theirs = { _id: "jx75d4pTHEIRS", user_id: "user-2", short_id: "jx75d4p" };
    const mine = { _id: "jx75d4pMINE", user_id: "user-1", short_id: "jx75d4p" };
    const result = await resolveConversationRefRanked(
      createLookupCtx({ conversationsByShortId: { "jx75d4p": [theirs, mine] } }),
      "jx75d4p",
      "user-1",
      never
    );
    expect(result).toEqual(mine);
  });

  test("falls back to the newest candidate the caller can access", async () => {
    const older = { _id: "a", user_id: "user-2", short_id: "jx7aaaa" };
    const newer = { _id: "b", user_id: "user-3", short_id: "jx7aaaa" };
    const result = await resolveConversationRefRanked(
      createLookupCtx({ conversationsByShortId: { "jx7aaaa": [older, newer] } }),
      "jx7aaaa",
      "user-1",
      async (c) => c._id !== "a"
    );
    expect(result).toEqual(newer);
  });

  test("still returns a candidate when none are accessible, so the caller can say Access denied (not found)", async () => {
    const theirs = { _id: "a", user_id: "user-2", short_id: "jx7bbbb" };
    const result = await resolveConversationRefRanked(
      createLookupCtx({ conversationsByShortId: { "jx7bbbb": [theirs] } }),
      "jx7bbbb",
      "user-1",
      never
    );
    expect(result).toEqual(theirs);
  });

  test("a full conversation id resolves directly and wins over short-id candidates", async () => {
    const full = { _id: "jx75d4pvw40zz4yaekqdz612ed8aejvp", user_id: "user-2", short_id: "jx75d4p" };
    const result = await resolveConversationRefRanked(
      createLookupCtx({
        conversationsById: { [full._id]: full },
        conversationsByShortId: { "jx75d4p": [{ _id: "other", user_id: "user-1", short_id: "jx75d4p" }] },
      }),
      full._id,
      "user-1",
      never
    );
    expect(result).toEqual(full);
  });

  test("a longer-than-7 ref is truncated to its short id when no full id matches", async () => {
    const conv = { _id: "jx7ccccfull", user_id: "user-1", short_id: "jx7cccc" };
    const result = await resolveConversationRefRanked(
      createLookupCtx({ conversationsByShortId: { "jx7cccc": [conv] } }),
      "jx7ccccXYZ",
      "user-1",
      never
    );
    expect(result).toEqual(conv);
  });
});
