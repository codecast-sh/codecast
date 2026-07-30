import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

const USER = "users_owner";
const CONVERSATION = "conversations_owned";

function context(tables: Record<string, any[]>) {
  const db = makeFakeDb({
    change_log: [],
    local_view_heads: [],
    ...tables,
  });
  return {
    db,
    ctx: {
      auth: {
        getUserIdentity: async () => ({ subject: `${USER}|session` }),
      },
      db,
    },
  };
}

describe("durable compatibility writers", () => {
  test("applyUndoPatches reuses the validated generic patch gates", async () => {
    const { db, ctx } = context({
      conversations: [{
        _id: CONVERSATION,
        user_id: USER,
        inbox_dismissed_at: 456,
        inbox_stashed_at: null,
        message_count: 5,
      }],
      client_state: [{
        _id: "client_state_owner",
        user_id: USER,
        ui: { inbox_scope: "team" },
      }],
    });

    await (dispatch as any)._handler(ctx, {
      action: "applyUndoPatches",
      args: [{
        conversations: {
          [CONVERSATION]: {
            inbox_dismissed_at: null,
            inbox_stashed_at: 123,
          },
        },
        client_state: {
          _: { current_conversation_id: CONVERSATION },
        },
      }],
    });

    expect(db._tables.conversations[0]).toMatchObject({
      inbox_dismissed_at: undefined,
      inbox_stashed_at: 123,
    });
    expect(db._tables.client_state[0].current_conversation_id).toBe(CONVERSATION);
  });

  test("persistClientTips updates only the supplied cross-device subset", async () => {
    const { db, ctx } = context({
      client_state: [{
        _id: "client_state_owner",
        user_id: USER,
        tips: { level: "all", dismissed: ["old"] },
      }],
    });

    await (dispatch as any)._handler(ctx, {
      action: "persistClientTips",
      args: [{ seen: ["first"] }],
    });

    expect(db._tables.client_state[0].tips).toEqual({
      level: "all",
      dismissed: ["old"],
      seen: ["first"],
    });
    expect(db._tables.client_state[0].tips._inlineSuppressed).toBeUndefined();
  });

  test("restoreArchivedDoc clears only archived_at", async () => {
    const { db, ctx } = context({
      docs: [{
        _id: "docs_archived",
        user_id: USER,
        title: "Restore me",
        archived_at: 999,
        updated_at: 111,
      }],
    });

    await (dispatch as any)._handler(ctx, {
      action: "restoreArchivedDoc",
      args: ["docs_archived"],
    });

    expect(db._tables.docs[0].archived_at).toBeUndefined();
    expect(db._tables.docs[0].updated_at).toBe(111);
  });

  test("named client-state writers persist explicit intent without auto patches", async () => {
    const { db, ctx } = context({
      client_state: [{
        _id: "client_state_owner",
        user_id: USER,
        ui: {
          inbox_scope: "mine",
          "inbox_scope:ts": 100,
          saved_views: [{ id: "old" }],
        },
        layouts: { dashboard: { sidebar: 25 } },
        drafts: { conversation: { draft_message: "stale" } },
      }],
    });

    await (dispatch as any)._handler(ctx, {
      action: "updateClientUI",
      args: [{ inbox_scope: "team" }],
      result: { inbox_scope: "team", "inbox_scope:ts": 200 },
    });
    await (dispatch as any)._handler(ctx, {
      action: "saveView",
      args: [{ name: "Mine" }],
      result: [{ id: "new", name: "Mine", created_at: 300 }],
    });
    await (dispatch as any)._handler(ctx, {
      action: "deleteView",
      args: ["new"],
      result: [],
    });
    await (dispatch as any)._handler(ctx, {
      action: "updateClientLayout",
      args: ["sidebar", { width: 288 }],
    });
    await (dispatch as any)._handler(ctx, {
      action: "clearDraftFinal",
      args: ["conversation"],
    });

    expect(db._tables.client_state[0]).toMatchObject({
      ui: {
        inbox_scope: "team",
        "inbox_scope:ts": 200,
        saved_views: [],
      },
      layouts: {
        dashboard: { sidebar: 25 },
        sidebar: { width: 288 },
      },
      drafts: {},
    });
  });
});
