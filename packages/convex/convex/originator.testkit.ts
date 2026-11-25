// The backend the originator read's tests share (/cli/sessions/originator, /cli/intent/verify): Ana and Eve with CLI
// tokens, and helpers that make sessions, echo lines into them and post to the routes.
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

export const api = anyApi as any;
export const ANA_TOKEN = "a".repeat(64);
export const EVE_TOKEN = "e".repeat(64);

const backends: any[] = [];
/** Run in each file's afterEach: lets the scheduled work of every backend seeded since finish. */
export async function finishBackends() {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
}

export async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    for (const [u, tok] of [[ana, ANA_TOKEN], [eve, EVE_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    return { ana, eve };
  });
  let n = 0;
  const conv = (fields: Record<string, unknown> = {}) => t.run(async (ctx: any) => {
    const sid = `sess-${++n}`;
    const id = await ctx.db.insert("conversations", {
      user_id: ids.ana, agent_type: "claude_code", session_id: sid, title: `Session ${n}`,
      started_at: now, updated_at: now, message_count: 0, is_private: true, status: "active", project_path: "/repo",
      // The daemon's mark for a session a person runs at a terminal (cli parser detectCliFlags).
      cli_flags: "--interactive",
      ...fields,
    } as any);
    await ctx.db.patch(id, { short_id: `jx${String(n).padStart(5, "0")}` });
    return id;
  });
  let clock = now;
  // `sameTime`: at the previous message's timestamp, as Claude Code records a slash command's expansion.
  const echo = (conversation_id: unknown, content: string, role: "user" | "assistant" = "user", sameTime = false) =>
    t.mutation(api.messages.addMessage, { conversation_id, api_token: ANA_TOKEN, role, content, message_uuid: `m-${++n}`, timestamp: sameTime ? clock : (clock += 1000) });
  const as = (u: unknown) => t.withIdentity({ subject: `${String(u)}|test` });
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await res.json();
  };
  const originator = (conversation_id: unknown, extra: Record<string, unknown> = {}, token = ANA_TOKEN) =>
    post("/cli/sessions/originator", { api_token: token, conversation_id: String(conversation_id), ...extra });
  const pending = (conversation_id: unknown) =>
    t.run((ctx: any) => ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation_id)).collect());
  return { t, ...ids, conv, echo, as, post, originator, pending, now: () => clock };
}
