import { describe, expect, test } from "bun:test";
import type { Doc, Id } from "./_generated/dataModel";
import { docTextUpdates, generateShareLink, get, isWebDocOwner, mapWebDocDetail, search, unshare, webGet, webUpdate } from "./docs";
import { webGetDocDetail } from "./taskMining";

type Patch = { id: string; patch: Record<string, unknown> };

function doc(partial: Partial<Doc<"docs">> = {}): Doc<"docs"> {
  return {
    _id: "doc1" as Id<"docs">,
    _creationTime: 1,
    user_id: "owner_user" as Id<"users">,
    title: "Plan Capture",
    content: "body",
    doc_type: "note",
    source: "human",
    created_at: 10,
    updated_at: 20,
    ...partial,
  };
}

function createWebUpdateCtx(
  userId: string,
  docs: Array<Record<string, unknown>>,
  memberships: Array<{ user_id: string; team_id: string }> = [],
) {
  const rows = new Map(docs.map((doc) => [doc._id as string, doc]));
  const patches: Patch[] = [];
  const ctx = {
    auth: {
      async getUserIdentity() {
        return { subject: `${userId}|session` };
      },
    },
    db: {
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
        rows.set(id, { ...rows.get(id), ...patch });
      },
      // Just enough of the query builder for isTeamMember's
      // team_memberships.by_user_team lookup.
      query(table: string) {
        if (table !== "team_memberships") throw new Error(`unexpected query on ${table}`);
        const eqs: Record<string, string> = {};
        const q = { eq: (field: string, value: string) => ((eqs[field] = value), q) };
        return {
          withIndex(_name: string, fn: (q: unknown) => unknown) {
            fn(q);
            return {
              async first() {
                return (
                  memberships.find((m) => m.user_id === eqs.user_id && m.team_id === eqs.team_id)
                  ?? null
                );
              },
            };
          },
        };
      },
    },
  };

  return { ctx, patches, rows };
}

async function runWebUpdate(ctx: unknown, args: Record<string, unknown>) {
  return (webUpdate as any)._handler(ctx, args);
}

describe("webUpdate authorization", () => {
  test("denies a cross-user update without patching the doc", async () => {
    const doc = {
      _id: "doc_owner",
      user_id: "owner_user",
      title: "Original",
      content: "Body",
      doc_type: "note",
      source: "human",
      created_at: 1,
      updated_at: 1,
    };
    const { ctx, patches, rows } = createWebUpdateCtx("other_user", [doc]);

    expect(isWebDocOwner(doc as any, "other_user" as any)).toBe(false);
    // webUpdate now gates on canAccessDoc (owner-or-team). A cross-user with no
    // shared team is still denied — now via "Unauthorized" rather than owner-only.
    await expect(runWebUpdate(ctx, { id: "doc_owner", title: "Patched" })).rejects.toThrow("Unauthorized");

    expect(patches).toHaveLength(0);
    expect(rows.get("doc_owner")?.title).toBe("Original");
  });

  test("allows the owner to update their own doc", async () => {
    const doc = {
      _id: "doc_owner",
      user_id: "owner_user",
      title: "Original",
      content: "Body",
      doc_type: "note",
      source: "human",
      created_at: 1,
      updated_at: 1,
    };
    const { ctx, patches, rows } = createWebUpdateCtx("owner_user", [doc]);

    expect(isWebDocOwner(doc as any, "owner_user" as any)).toBe(true);
    await expect(runWebUpdate(ctx, { id: "doc_owner", title: "Patched" })).resolves.toEqual({ success: true });

    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("doc_owner");
    expect(patches[0].patch.title).toBe("Patched");
    expect(typeof patches[0].patch.updated_at).toBe("number");
    expect(rows.get("doc_owner")?.title).toBe("Patched");
  });
});

// Regression: docs are team-visible (canAccessDoc) and even team-editable
// (webUpdate), but generateShareLink/unshare kept a strict creator-only check
// from before that migration. Opening a teammate's doc and clicking Share threw
// "Doc not found" in prod. Both now gate on requireAccessibleDoc (owner-or-team),
// matching plans.generateShareLink.
describe("share link authorization", () => {
  const teamDoc = () => ({
    _id: "doc_team",
    user_id: "owner_user",
    team_id: "team1",
    title: "Team doc",
    content: "Body",
    doc_type: "note",
    source: "human",
    created_at: 1,
    updated_at: 1,
  });

  test("a teammate can generate a share link for a team doc", async () => {
    const { ctx, patches, rows } = createWebUpdateCtx("other_user", [teamDoc()], [
      { user_id: "other_user", team_id: "team1" },
    ]);

    const result = await (generateShareLink as any)._handler(ctx, { id: "doc_team" });
    expect(typeof result.share_token).toBe("string");
    expect(patches).toHaveLength(1);
    expect(rows.get("doc_team")?.share_token).toBe(result.share_token);
  });

  test("a cross-user with no shared team is still denied without patching", async () => {
    const { ctx, patches } = createWebUpdateCtx("other_user", [teamDoc()], [
      { user_id: "other_user", team_id: "unrelated_team" },
    ]);

    await expect(
      (generateShareLink as any)._handler(ctx, { id: "doc_team" }),
    ).rejects.toThrow(/Doc not found/);
    expect(patches).toHaveLength(0);
  });

  test("the owner reuses an existing token without re-patching", async () => {
    const doc = { ...teamDoc(), share_token: "tok-existing" };
    const { ctx, patches } = createWebUpdateCtx("owner_user", [doc]);

    const result = await (generateShareLink as any)._handler(ctx, { id: "doc_team" });
    expect(result.share_token).toBe("tok-existing");
    expect(patches).toHaveLength(0);
  });

  test("a teammate can unshare a team doc", async () => {
    const doc = { ...teamDoc(), share_token: "tok-existing" };
    const { ctx, rows } = createWebUpdateCtx("other_user", [doc], [
      { user_id: "other_user", team_id: "team1" },
    ]);

    await expect((unshare as any)._handler(ctx, { id: "doc_team" })).resolves.toEqual({
      success: true,
    });
    expect(rows.get("doc_team")?.share_token).toBeUndefined();
  });
});

describe("mapWebDocDetail", () => {
  test("adds display title metadata for plan-mode docs", () => {
    const result = mapWebDocDetail({
      doc: doc({
        title: "pl-1234",
        source: "plan_mode",
        content: "# Ship the Fix\n\nDetails",
      }),
    });

    expect(result.display_title).toBe("Ship the Fix");
    expect(result.plan_name).toBe("pl-1234");
  });

  test("keeps related conversations and active plan typed on the detail DTO", () => {
    const conversation = {
      _id: "conv1" as Id<"conversations">,
      session_id: "sess1",
      title: "Debug session",
      project_path: "/repo",
      started_at: 100,
      updated_at: 200,
      message_count: 12,
      short_id: "cc-1",
    };
    const activePlan = {
      _id: "plan1" as Id<"plans">,
      short_id: "pl-1",
      title: "Plan",
      status: "in_progress",
    };

    const result = mapWebDocDetail({
      doc: doc(),
      relatedConversations: [conversation],
      activePlan,
    });

    expect(result.related_conversations).toEqual([conversation]);
    expect(result.active_plan).toEqual(activePlan);
  });
});

// Regression: clicking a malformed /docs/<id> link (e.g. a conversation id pasted
// into a doc-typed link or pill) routed a non-docs id into webGet / webGetDocDetail.
// With a v.id("docs") arg validator the server threw ArgumentValidationError, which
// the ErrorBoundary surfaced as a full-page crash of the dashboard shell. The guard
// is ctx.db.normalizeId("docs", id): a cross-table id must resolve to null, never throw.
describe("doc-by-id queries tolerate a cross-table id", () => {
  // Mirrors Convex: ids only normalize for the table they belong to. We model docs
  // ids with a "doc_" prefix; anything else (a conversation id like jx781mx…) → null.
  function createDocReadCtx(opts: { userId: string; docs?: Record<string, any> }) {
    const docs = opts.docs ?? {};
    const getCalls: string[] = [];
    const ctx = {
      auth: {
        async getUserIdentity() {
          return { subject: `${opts.userId}|session` };
        },
      },
      db: {
        async get(id: string) {
          getCalls.push(id);
          if (id === opts.userId) return { _id: opts.userId, active_team_id: "team1" };
          return docs[id] ?? null;
        },
        normalizeId(table: string, id: string) {
          return table === "docs" && id.startsWith("doc_") ? id : null;
        },
        query() {
          throw new Error("query() should not run on the cross-table-id early return");
        },
      },
    };
    return { ctx, getCalls };
  }

  const CONVERSATION_ID = "jx781mxkm0wpasx3ck4pbeecq5881mzc";

  test("webGet returns null (no throw) for a conversation id, without fetching it", async () => {
    const { ctx, getCalls } = createDocReadCtx({ userId: "u1" });
    const res = await (webGet as any)._handler(ctx, { id: CONVERSATION_ID });
    expect(res).toBeNull();
    // Never reaches ctx.db.get with the cross-table id (would have returned the
    // conversation document typed as a doc — Convex ids are globally unique).
    expect(getCalls).not.toContain(CONVERSATION_ID);
  });

  test("webGetDocDetail returns null (no throw) for a conversation id", async () => {
    const { ctx, getCalls } = createDocReadCtx({ userId: "u1" });
    const res = await (webGetDocDetail as any)._handler(ctx, { id: CONVERSATION_ID });
    expect(res).toBeNull();
    expect(getCalls).not.toContain(CONVERSATION_ID);
  });

  test("webGet still resolves a valid docs-table id owned by the user", async () => {
    const ownedDoc = {
      _id: "doc_1",
      user_id: "u1",
      title: "Unified Value Scoring",
      content: "body",
      doc_type: "design",
      source: "human",
      created_at: 10,
      updated_at: 20,
    };
    const { ctx } = createDocReadCtx({ userId: "u1", docs: { doc_1: ownedDoc } });
    const res = await (webGet as any)._handler(ctx, { id: "doc_1" });
    expect(res?._id).toBe("doc_1");
    expect(res?.title).toBe("Unified Value Scoring");
  });
});

// A teammate reading a team doc through the CLI (`cast doc show` / `cast doc
// search`) used to get "Doc not found" while the same doc opened fine in the
// browser: the api_token endpoints were creator-only, and the title search was
// pinned to the caller's own user_id via the index filter field.
function createCliCtx(opts: {
  userId: string;
  docs: Array<Record<string, unknown>>;
  memberships?: Array<{ user_id: string; team_id: string }>;
}) {
  const memberships = opts.memberships ?? [];
  const rows = new Map(opts.docs.map((d) => [d._id as string, d]));
  return {
    db: {
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      query(table: string) {
        if (table === "api_tokens") {
          return {
            withIndex() {
              return { async first() { return { _id: "tok1", user_id: opts.userId }; } };
            },
          };
        }
        if (table === "team_memberships") {
          const eqs: Record<string, string> = {};
          const q = { eq: (field: string, value: string) => ((eqs[field] = value), q) };
          return {
            withIndex(_name: string, fn: (q: unknown) => unknown) {
              fn(q);
              return {
                async first() {
                  return memberships.find(
                    (m) => m.user_id === eqs.user_id && m.team_id === eqs.team_id,
                  ) ?? null;
                },
              };
            },
          };
        }
        if (table === "docs") {
          return {
            withSearchIndex(_name: string, fn: (q: any) => unknown) {
              const q: any = { search: () => q, eq: () => q };
              fn(q);
              return { async take() { return [...rows.values()]; } };
            },
          };
        }
        throw new Error(`unexpected query on ${table}`);
      },
    },
  };
}

describe("CLI doc access is owner-or-team", () => {
  const teamDoc = {
    _id: "doc_team",
    user_id: "owner_user",
    team_id: "team_1",
    title: "Goanna Receive Layer",
    content: "body",
    doc_type: "plan",
    source: "agent",
    created_at: 1,
    updated_at: 2,
  };

  test("get returns a teammate's team doc", async () => {
    const ctx = createCliCtx({
      userId: "mate_user",
      docs: [teamDoc],
      memberships: [{ user_id: "mate_user", team_id: "team_1" }],
    });
    const res = await (get as any)._handler(ctx, { api_token: "t", id: "doc_team" });
    expect(res?._id).toBe("doc_team");
  });

  test("get still denies a non-member", async () => {
    const ctx = createCliCtx({ userId: "stranger", docs: [teamDoc] });
    const res = await (get as any)._handler(ctx, { api_token: "t", id: "doc_team" });
    expect(res).toBeNull();
  });

  test("search surfaces a teammate's team doc and hides a stranger's", async () => {
    const privateDoc = { ...teamDoc, _id: "doc_private", team_id: undefined, title: "Private Note" };
    const mate = createCliCtx({
      userId: "mate_user",
      docs: [teamDoc, privateDoc],
      memberships: [{ user_id: "mate_user", team_id: "team_1" }],
    });
    const mateRes = await (search as any)._handler(mate, { api_token: "t", query: "Goanna" });
    expect(mateRes.map((d: any) => d._id)).toEqual(["doc_team"]);

    const stranger = createCliCtx({ userId: "stranger", docs: [teamDoc, privateDoc] });
    const strangerRes = await (search as any)._handler(stranger, { api_token: "t", query: "Goanna" });
    expect(strangerRes).toEqual([]);
  });
});

// The doc is one text: its title is its leading heading. docTextUpdates is
// the single rule every CLI/web text write goes through.
describe("docTextUpdates", () => {
  test("a content edit adopts the body's leading heading as the title", () => {
    const existing = doc({ title: "Old", content: "# Old\n\nbody" });
    expect(docTextUpdates(existing, { content: "# New Name\n\nnew body" })).toEqual({
      title: "New Name",
      content: "# New Name\n\nnew body",
    });
  });

  test("a content edit with no heading keeps the title and writes it in as one", () => {
    const existing = doc({ title: "Kept", content: "# Kept\n\nold" });
    expect(docTextUpdates(existing, { content: "plain body" })).toEqual({
      content: "# Kept\n\nplain body",
    });
  });

  test("a title edit rewrites the leading heading and keeps the body", () => {
    const existing = doc({ title: "Old", content: "# Old\n\nbody" });
    expect(docTextUpdates(existing, { title: "Renamed" })).toEqual({
      title: "Renamed",
      content: "# Renamed\n\nbody",
    });
  });

  test("a title edit on a legacy body without a heading gains one", () => {
    const existing = doc({ title: "Old", content: "legacy body" });
    expect(docTextUpdates(existing, { title: "Renamed" })).toEqual({
      title: "Renamed",
      content: "# Renamed\n\nlegacy body",
    });
  });

  test("no text args, no changes", () => {
    expect(docTextUpdates(doc(), {})).toEqual({});
  });
});
