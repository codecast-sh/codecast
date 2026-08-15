import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list } from "./reviewQueue";

const VIEWER = "user-viewer" as any;
const TEAMMATE = "user-teammate" as any;
const STRANGER = "user-stranger" as any;
const TEAM = "team-main" as any;

function user(_id: string, name: string) {
  return { _id, name, email: `${_id}@example.test` };
}

function conversation(_id: string, owner: any, extra: Record<string, unknown> = {}) {
  return { _id, user_id: owner, is_private: true, status: "active", title: `Session ${_id}`, ...extra };
}

function comment(_id: string, conversationId: string, author: any, extra: Record<string, unknown> = {}) {
  return {
    _id,
    conversation_id: conversationId,
    user_id: author,
    content: `note ${_id}`,
    created_at: 0,
    ...extra,
  };
}

function ctx(seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [user(VIEWER, "Viewer"), user(TEAMMATE, "Teammate"), user(STRANGER, "Stranger")],
    conversations: [],
    comments: [],
    artifacts: [],
    artifact_comments: [],
    workflow_runs: [],
    team_memberships: [],
    ...seed,
  });
  return {
    db,
    auth: {
      async getUserIdentity() {
        return { subject: `${VIEWER}|session` };
      },
    },
  } as any;
}

describe("reviewQueue.list", () => {
  test("unions open items from all three sources, newest first", async () => {
    const c = ctx({
      conversations: [conversation("conv-1", VIEWER)],
      comments: [
        comment("c1", "conv-1", TEAMMATE, {
          file_path: "codecast/foo.ts",
          line_number: 42,
          created_at: 100,
        }),
      ],
      artifacts: [
        { _id: "art-1", user_id: VIEWER, slug: "launch-plan", title: "Launch plan", created_at: 1 },
      ],
      artifact_comments: [
        { _id: "ac-1", artifact_id: "art-1", author_name: "Guest", text: "typo in step 2", status: "open", delivered: true, version: 1, batch_id: "b", created_at: 300 },
        { _id: "ac-2", artifact_id: "art-1", author_name: "Guest", text: "resolved one", status: "resolved", delivered: true, version: 1, batch_id: "b", created_at: 400 },
      ],
      workflow_runs: [
        { _id: "run-1", user_id: VIEWER, status: "paused", workflow_name: "deploy", gate_prompt: "Ship it?", primary_conversation_id: "conv-1", created_at: 200, updated_at: 200 },
        { _id: "run-2", user_id: VIEWER, status: "running", created_at: 250, updated_at: 250 },
      ],
    });

    const items = await (list as any)._handler(c, {});
    expect(items.map((i: any) => i.kind)).toEqual(["page_comment", "workflow_gate", "comment_thread"]);

    const page = items[0];
    expect(page.title).toBe("Launch plan");
    expect(page.count).toBe(1); // only the OPEN page comment counts
    expect(page.artifact_slug).toBe("launch-plan");
    // Server-built jump target — clients never assemble artifact URLs.
    expect(page.artifact_url).toBe("https://codecast.sh/a/launch-plan");

    const gate = items[1];
    expect(gate.title).toBe("Gate · deploy");
    expect(gate.detail).toBe("Ship it?");
    expect(gate.conversation_id).toBe("conv-1");

    const thread = items[2];
    expect(thread.title).toBe("foo.ts:42");
    expect(thread.conversation_id).toBe("conv-1");
    expect(thread.actor_name).toBe("Teammate");
    expect(thread.last_actor_is_viewer).toBe(false);
  });

  test("resolved threads and inaccessible conversations stay out", async () => {
    const c = ctx({
      conversations: [
        conversation("conv-mine", VIEWER),
        conversation("conv-private", STRANGER),
      ],
      comments: [
        // Fully resolved thread on my conversation: not an item.
        comment("c1", "conv-mine", TEAMMATE, { file_path: "a.ts", line_number: 1, created_at: 10, resolved_at: 11 }),
        // Open thread on a stranger's private conversation: filtered by access.
        comment("c2", "conv-private", STRANGER, { file_path: "b.ts", line_number: 2, created_at: 20 }),
      ],
    });
    const items = await (list as any)._handler(c, {});
    expect(items).toEqual([]);
  });

  test("a thread the viewer spoke last in is marked as waiting on others", async () => {
    const c = ctx({
      conversations: [conversation("conv-1", VIEWER, { team_id: TEAM, is_private: false })],
      team_memberships: [
        { _id: "m1", user_id: VIEWER, team_id: TEAM, visibility: "summary" },
        { _id: "m2", user_id: TEAMMATE, team_id: TEAM, visibility: "summary" },
      ],
      comments: [
        comment("c1", "conv-1", TEAMMATE, { created_at: 10 }),
        comment("c2", "conv-1", VIEWER, { created_at: 20 }),
      ],
    });
    const items = await (list as any)._handler(c, {});
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("comment_thread");
    expect(items[0].count).toBe(2);
    expect(items[0].last_actor_is_viewer).toBe(true);
  });
});
