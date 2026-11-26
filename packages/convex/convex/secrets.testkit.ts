// Shared setup for the Vault's function tests: a seeded team with tokens, an
// agent's read from its session, and a person's signed-in answer.
import { afterAll, afterEach, beforeAll } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { APPROVE_FOR_SESSION } from "@codecast/shared/contracts/secrets";
import { seedPresence } from "./passkeys.testkit";

export const api = anyApi as any;
const KEY_ENV = "CONNECTION_SECRETS_KEY";
export const ANA_TOKEN = "a".repeat(64);
export const BEN_TOKEN = "b".repeat(64);
export const CAT_TOKEN = "c".repeat(64);
export const STRIPE = "sk_" + "test_51HsecretVALUEdoNotLeak9876";

let previousKey: string | undefined;
const backends: any[] = [];

/** The deployment key every encrypt and decrypt needs, and backends drained after each test: call once per test file. */
export function useVaultTestEnv() {
  beforeAll(() => {
    previousKey = process.env[KEY_ENV];
    process.env[KEY_ENV] = "test-deployment-key-0123456789abcdef";
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
  });
  afterEach(async () => {
    for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
  });
}

export async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "a" } as any);
    const beta = await ctx.db.insert("teams", { name: "Beta", created_at: now, invite_code: "b" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: beta, role: "member", joined_at: now } as any);
    for (const [u, tok] of [[ana, ANA_TOKEN], [ben, BEN_TOKEN], [cat, CAT_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: ana, team_id: acme, agent_type: "claude_code", session_id: "sess-ana-1", short_id: "jx7ana1", title: "Wire up billing",
      started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", project_path: "/repo",
    } as any);
    return { acme, beta, ana, ben, cat, conv };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

export const read = (t: any, refs: string[], extra: Record<string, unknown> = {}) =>
  t.action(api.secrets.cliRead, { api_token: ANA_TOKEN, refs, conversation: "jx7ana1", purpose: "run", ...extra });
/** The Touch ID grant string a person's press on the web carries, for one secret. */
export const touch = async (t: any, as: (u: string) => any, user: string, action: "reveal" | "ask_first_off" | "touch_id_off", ref: string) =>
  seedPresence(t, user, action, (await as(user).query(api.secrets.show, { ref }))._id);
/** A person answers on the web, signed in: the only way an Ask first decision settles. An Approve comes with its Touch ID grant. */
export const answer = async (t: any, as: (u: string) => any, user: string, decision: string, index: number) => {
  const row = await t.run(async (ctx: any) => (await ctx.db.query("session_decisions").collect()).find((d: any) => d.short_id === decision));
  const grant = row.options[index]?.label === APPROVE_FOR_SESSION ? await seedPresence(t, user, "approve", String(row._id)) : undefined;
  return as(user).mutation(api.sessionDecisions.resolve, { decision_id: row._id, status: "answered", answer_index: index, grant });
};
