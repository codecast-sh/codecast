import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { reportCapabilityContents, webCapabilityContent } from "./capabilityContent";
import { MAX_CONTENT_BODY_CHARS } from "./capabilitiesSchema";

const OWNER = "u_owner";
const STRANGER = "u_stranger";
const TOKEN = "cast_test_token";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: auth(userId),
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
  } as any;
}

async function tokenTables(extra: Record<string, any[]> = {}) {
  return {
    api_tokens: [{ _id: "tok_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    users: [{ _id: OWNER }, { _id: STRANGER }],
    capability_content: [],
    ...extra,
  } as Record<string, any[]>;
}

describe("reportCapabilityContents", () => {
  test("stores a skill body and the reader gets it back", async () => {
    const tables = await tokenTables();
    const c = ctx(OWNER, tables);
    const result = await (reportCapabilityContents as any)._handler(c, {
      api_token: TOKEN,
      items: [
        {
          kind: "skill",
          name: "deploy",
          hash: "abc123abc123abcd",
          body: "---\nname: deploy\n---\nship it\n",
        },
      ],
    });
    expect(result.stored).toBe(1);
    expect(tables.capability_content).toHaveLength(1);
    const read = await (webCapabilityContent as any)._handler(ctx(OWNER, tables), {
      kind: "skill",
      name: "deploy",
    });
    expect(read.body).toContain("ship it");
    expect(read.truncated).toBe(false);
  });

  test("an identical re-report writes nothing", async () => {
    const tables = await tokenTables();
    const c = ctx(OWNER, tables);
    const item = {
      kind: "skill",
      name: "deploy",
      hash: "abc123abc123abcd",
      body: "body\n",
    };
    await (reportCapabilityContents as any)._handler(c, { api_token: TOKEN, items: [item] });
    tables._patched = [];
    const db = c.db;
    db._patched.length = 0;
    const second = await (reportCapabilityContents as any)._handler(c, { api_token: TOKEN, items: [item] });
    expect(second.unchanged).toBe(1);
    expect(second.stored).toBe(0);
    expect(c.db._patched).toEqual([]);
  });

  test("a changed body updates the row", async () => {
    const tables = await tokenTables();
    const c = ctx(OWNER, tables);
    await (reportCapabilityContents as any)._handler(c, {
      api_token: TOKEN,
      items: [{ kind: "skill", name: "deploy", hash: "oldoldoldoldold1", body: "v1\n" }],
    });
    await (reportCapabilityContents as any)._handler(c, {
      api_token: TOKEN,
      items: [{ kind: "skill", name: "deploy", hash: "newnewnewnewnew2", body: "v2\n" }],
    });
    expect(tables.capability_content).toHaveLength(1);
    expect(tables.capability_content[0].body).toContain("v2");
  });

  test("a stranger cannot read someone else's body", async () => {
    const tables = await tokenTables({
      capability_content: [
        {
          _id: "cc1",
          user_id: OWNER,
          kind: "skill",
          name: "secret",
          body: "nope",
          body_hash: "h",
          updated_at: 1,
        },
      ],
    });
    const read = await (webCapabilityContent as any)._handler(ctx(STRANGER, tables), {
      kind: "skill",
      name: "secret",
    });
    expect(read).toBeNull();
  });

  test("an overlong body is truncated rather than dropped", async () => {
    const tables = await tokenTables();
    const c = ctx(OWNER, tables);
    const body = "x".repeat(MAX_CONTENT_BODY_CHARS + 50);
    await (reportCapabilityContents as any)._handler(c, {
      api_token: TOKEN,
      items: [{ kind: "skill", name: "huge", hash: "hhhhhhhhhhhhhhhh", body }],
    });
    expect(tables.capability_content[0].body.length).toBe(MAX_CONTENT_BODY_CHARS);
    expect(tables.capability_content[0].truncated).toBe(true);
  });
});
