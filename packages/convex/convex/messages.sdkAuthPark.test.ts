// A session the daemon runs through the headless SDK writes its
// authentication_failed turn with the SDK's own lead. Synced, that turn parks
// the row on auth, which is what a fleet switch revives: on 2026-11-13 the
// Union line hosts moved to a working account and 39 sessions stopped on a
// 403 stayed where they were, because no row had parked.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const BRIEF = "The run is back at this station, with you.";

async function setup() {
  const t = convexTest(schema, allModules);
  const { user, conversation } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@line.dev" } as any);
    const conversation = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), owner_device_id: "line-host",
      started_at: 1, updated_at: 1, message_count: 0, status: "active", skip_title_generation: true,
    } as any);
    return { user, conversation };
  });
  const as = t.withIdentity({ subject: `${user}|session` });
  const row = () => t.run(async (ctx) => ctx.db.get(conversation as Id<"conversations">));
  return { as, conversation, row };
}

const SDK_AUTH_FAILURES = [
  "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
  "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
];

describe("an SDK session's authentication failure", () => {
  for (const banner of SDK_AUTH_FAILURES) {
    test(`parks the row on auth, one message at a time: ${banner.slice(0, 48)}`, async () => {
      const { as, conversation, row } = await setup();
      await as.mutation(api.messages.addMessage, { conversation_id: conversation, role: "user", content: BRIEF, timestamp: 10 });
      await as.mutation(api.messages.addMessage, { conversation_id: conversation, role: "assistant", content: banner, timestamp: 20 });
      expect(await row()).toMatchObject({ pending_api_error: true, pending_api_error_kind: "auth", pending_api_error_at: 20 });
    });
  }

  test("parks the row on auth when the turn arrives in a batch", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [
        { role: "user", content: BRIEF, timestamp: 10 },
        { role: "assistant", content: SDK_AUTH_FAILURES[0], timestamp: 20 },
      ],
    });
    expect(await row()).toMatchObject({ pending_api_error: true, pending_api_error_kind: "auth", pending_api_error_at: 20 });
  });

  test("a reply that says it failed to authenticate somewhere else parks nothing", async () => {
    const { as, conversation, row } = await setup();
    await as.mutation(api.messages.addMessage, {
      conversation_id: conversation, role: "assistant", content: "Failed to authenticate with GitHub, so the branch is not pushed yet.", timestamp: 20,
    });
    expect((await row())?.pending_api_error).not.toBe(true);
  });
});
