import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { reviveClientId } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./pendingMessages.ts": () => import("./pendingMessages"),
  "./messages.ts": () => import("./messages"),
  "./conversations.ts": () => import("./conversations"),
  "./dispatch.ts": () => import("./dispatch"),
};

const TOKEN = "revive-gate-test-token";

// A daemon's crash revive is a "continue" codecast types on the person's
// behalf. It goes out only under a recovery mode they chose; a machine that
// never chose one (the default) gets none, whichever daemon version asks.
async function setup(recovery: { cc_auto_continue?: boolean }) {
  const t = convexTest(schema, modules);
  const { conv } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { emailVerificationTime: 1 } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "mac", label: "Mac", platform: "darwin", last_seen: Date.now(), ...recovery } as any);
    const conv = await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", started_at: Date.now() } as any);
    return { conv };
  });
  const send = (client_id: string) =>
    t.mutation(api.pendingMessages.sendMessageToSession, { conversation_id: conv, content: "continue", client_id, api_token: TOKEN });
  const queued = () => t.run((ctx) => ctx.db.query("pending_messages").collect());
  return { conv, send, queued };
}

describe("crash revives follow the recovery mode", () => {
  test("a machine that never chose a mode gets no revive", async () => {
    const { conv, send, queued } = await setup({});
    expect(await send(reviveClientId(conv, Date.now()))).toBeNull();
    expect(await queued()).toHaveLength(0);
  });

  test("a machine that turned recovery on is revived", async () => {
    const { conv, send, queued } = await setup({ cc_auto_continue: true });
    expect(await send(reviveClientId(conv, Date.now()))).not.toBeNull();
    expect(await queued()).toHaveLength(1);
  });

  test("a person's own message is never held back", async () => {
    const { send, queued } = await setup({});
    expect(await send("typed-by-hand")).not.toBeNull();
    expect(await queued()).toHaveLength(1);
  });
});
