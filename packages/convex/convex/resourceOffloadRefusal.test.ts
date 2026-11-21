import { expect, test, setDefaultTimeout } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

const start = makeFunctionReference<"mutation">("resourceOffload:start");
const preflight = makeFunctionReference<"query">("resourceOffload:preflight");

// Production Convex redacts a plain Error to "Server Error", so a refusal
// reaches the person only when it is a ConvexError carrying the reason.
async function refusalOf(run: Promise<unknown>) {
  const error = await run.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  return JSON.stringify((error as ConvexError<unknown>).data);
}

async function offlineLaptop() {
  const t = convexTest(schema, allModules);
  const { user, conv } = await t.run(async ctx => {
    const user = await ctx.db.insert("users", {});
    const now = Date.now();
    await ctx.db.insert("devices", { user_id: user, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now - 24 * 3600_000 });
    await ctx.db.insert("devices", { user_id: user, device_id: "linux", label: "Linux", platform: "linux", is_remote: true, last_seen: now });
    const conv = await ctx.db.insert("conversations", { user_id: user, session_id: "s1", owner_device_id: "mac", agent_type: "claude_code", status: "active", is_private: true, message_count: 1, started_at: now, updated_at: now });
    return { user, conv };
  });
  const args = { source_device_id: "mac", wait_for_idle_ms: 60_000, selections: [{ conversation_id: conv, session_id: "s1", destination_id: "linux", attested: [] as string[] }] };
  return { authed: t.withIdentity({ subject: user }), args };
}

test("a dry-run start refused because the laptop is offline says why, not Server Error", async () => {
  const { authed, args } = await offlineLaptop();
  expect(await refusalOf(authed.mutation(start, { ...args, dry_run: true }))).toContain("The source laptop is not online");
});

test("a preflight refused because the laptop is offline says why, not Server Error", async () => {
  const { authed, args } = await offlineLaptop();
  expect(await refusalOf(authed.query(preflight, args))).toContain("The source laptop is not online");
});

test("an invalid request to start says why, not Server Error", async () => {
  const { authed, args } = await offlineLaptop();
  expect(await refusalOf(authed.mutation(start, { ...args, wait_for_idle_ms: 1000 }))).toContain("Allow at least a minute");
});
