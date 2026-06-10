import { describe, expect, test } from "bun:test";
import type { Doc, Id } from "./_generated/dataModel";
import { isWebDocOwner, mapWebDocDetail, webUpdate } from "./docs";

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

function createWebUpdateCtx(userId: string, docs: Array<Record<string, unknown>>) {
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
