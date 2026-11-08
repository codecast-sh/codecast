// `cast decide --run` (shared/contracts/commandRun.ts): the card carries the
// command; only the session's person, signed in and confirmed with Touch ID,
// can press Run; Run sends it to the session's machine; the machine's report
// delivers the answer with the output; Don't run sends nothing to the machine.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { seedPresence } from "./passkeys.testkit";
import { RUN_OPTION, SKIP_OPTION } from "@codecast/shared/contracts/commandRun";
import { formatDecisionAnswer, parseDecisionAnswer } from "@codecast/shared/contracts";
import { isHumanOnlyCategory } from "./lib/decisionCategory";

setDefaultTimeout(60_000);

const api = anyApi as any;
const ANA_TOKEN = "a".repeat(64);
const BEN_TOKEN = "b".repeat(64);
const GRANT = `cast role authority @ads --team Union --grant '[{"id":"ads-spend","kind":"spend","label":"Ads","limit":{"usd_per_month":500}}]'`;

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "a" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: now } as any);
    for (const [u, tok] of [[ana, ANA_TOKEN], [ben, BEN_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "cli", created_at: now, last_used_at: now } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: ana, team_id: acme, agent_type: "claude_code", session_id: "sess-ana-1", short_id: "jx7ana1", title: "Marketplace ads",
      started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", project_path: "/repo", owner_device_id: "dev-ana",
    } as any);
    return { ana, ben, conv };
  });
  const as = (u: unknown) => t.withIdentity({ subject: `${String(u)}|test` });
  const ask = (run: string) => t.mutation(api.sessionDecisions.ask, { api_token: ANA_TOKEN, session_id: "sess-ana-1", question: "Grant @ads $500 a month?", options: [], run });
  const row = (id: string) => t.run((ctx: any) => ctx.db.get(id));
  const commands = () => t.run((ctx: any) => ctx.db.query("daemon_commands").collect());
  const messages = () => t.run((ctx: any) => ctx.db.query("pending_messages").collect());
  return { t, ...ids, as, ask, row, commands, messages };
}

test("the card carries the parsed command, fixed options, and is the session's person's alone", async () => {
  const { ask, row } = await seed();
  const asked = await ask(`! ${GRANT}`);
  expect(asked.error).toBeUndefined();
  const d = await row(asked.id);
  expect(d.run).toMatchObject({ state: "waiting", device_id: "dev-ana", cwd: "/repo" });
  expect(d.run.argv).toEqual(["role", "authority", "@ads", "--team", "Union", "--grant", `[{"id":"ads-spend","kind":"spend","label":"Ads","limit":{"usd_per_month":500}}]`]);
  expect(d.options.map((o: any) => o.label)).toEqual([RUN_OPTION, SKIP_OPTION]);
  expect(d.blocking).toBe(true);
  expect(isHumanOnlyCategory(d.category)).toBe(true);
  expect(d.addressed).toBe(true);
});

test("a run line that is not one cast command is refused at ask", async () => {
  const { ask } = await seed();
  expect((await ask("cast tasks ls | head")).error).toMatch(/one cast command/);
  expect((await ask("cast decide 'x'")).error).toMatch(/another cast decide/);
  expect((await ask("cast role authority @ads --grant -")).error).toMatch(/no stdin/);
});

test("Run is refused through an api token, to another person, and without Touch ID", async () => {
  const { t, ask, as, ana, ben, commands, row } = await seed();
  const { id } = await ask(GRANT);
  // The asking agent holds the same token: a plain-shell answer and --for-human both refuse.
  expect((await t.mutation(api.sessionDecisions.answer, { api_token: ANA_TOKEN, decision_id: id, answer_index: 0 })).error).toMatch(/signed in/);
  expect((await t.mutation(api.sessionDecisions.answer, { api_token: ANA_TOKEN, decision_id: id, session_id: "sess-ana-1", for_human: true, answer_index: 0 })).error).toMatch(/signed in|cannot answer its own/);
  // A teammate who can read the session is not the person it runs as.
  await expect(as(ben).mutation(api.sessionDecisions.resolve, { decision_id: id, status: "answered", answer_index: 0, grant: await seedPresence(t, ben, "approve", String(id)) })).rejects.toThrow();
  // The person, without a passkey grant (an agent driving their browser has none).
  await expect(as(ana).mutation(api.sessionDecisions.resolve, { decision_id: id, status: "answered", answer_index: 0 })).rejects.toThrow();
  expect(await commands()).toHaveLength(0);
  expect((await row(id)).status).toBe("pending");
});

test("a person's Run goes to the session's machine, and the report delivers the answer with the output", async () => {
  const { t, ask, as, ana, row, commands, messages } = await seed();
  const { id } = await ask(GRANT);
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: id, status: "answered", answer_index: 0, grant: await seedPresence(t, ana, "approve", String(id)) });
  const cmds = await commands();
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toMatchObject({ command: "run_cast", target_device_id: "dev-ana" });
  expect(JSON.parse(cmds[0].args)).toMatchObject({ decision_id: String(id), argv: (await row(id)).run.argv, cwd: "/repo" });
  expect((await row(id)).run.state).toBe("queued");
  // Nothing reaches the session until the command has run.
  expect(await messages()).toHaveLength(0);

  await t.mutation(api.sessionDecisions.reportCommandRun, { api_token: ANA_TOKEN, decision_id: id, state: "running" });
  expect((await row(id)).run.state).toBe("running");
  await t.mutation(api.sessionDecisions.reportCommandRun, { api_token: ANA_TOKEN, decision_id: id, state: "done", exit_code: 0, output: "✓ @ads may spend (Ads)" });
  const d = await row(id);
  expect(d.run).toMatchObject({ state: "done", exit_code: 0, output: "✓ @ads may spend (Ads)" });
  const sent = await messages();
  expect(sent).toHaveLength(1);
  const parsed = parseDecisionAnswer(sent[0].content);
  expect(parsed).toMatchObject({ id: String(id), answer: RUN_OPTION });
  expect(parsed?.detail).toContain("exit 0");
  expect(parsed?.detail).toContain("✓ @ads may spend (Ads)");

  // A repeated report changes nothing and delivers nothing.
  expect(await t.mutation(api.sessionDecisions.reportCommandRun, { api_token: ANA_TOKEN, decision_id: id, state: "failed", exit_code: 1 })).toEqual({ ok: false });
  expect(await messages()).toHaveLength(1);
  // Another account cannot report on it.
  await expect(t.mutation(api.sessionDecisions.reportCommandRun, { api_token: BEN_TOKEN, decision_id: id, state: "done" })).rejects.toThrow(/not found/);
});

test("a machine that cannot take the run fails the card and tells the session", async () => {
  const { t, ask, as, ana, row, commands, messages } = await seed();
  const { id } = await ask(GRANT);
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: id, status: "answered", answer_index: 0, grant: await seedPresence(t, ana, "approve", String(id)) });
  const [cmd] = await commands();
  await t.mutation(api.users.reportCommandResult, { api_token: ANA_TOKEN, command_id: cmd._id, error: "Unknown command: run_cast" });
  await new Promise((r) => setTimeout(r, 30));
  await t.finishAllScheduledFunctions(() => {});
  expect((await row(id)).run).toMatchObject({ state: "failed" });
  const [msg] = await messages();
  expect(parseDecisionAnswer(msg.content)?.detail).toContain("Unknown command: run_cast");
});

test("Don't run is one press, sends nothing to the machine, and marks the command skipped", async () => {
  const { ask, as, ana, row, commands } = await seed();
  const { id } = await ask(GRANT);
  await as(ana).mutation(api.sessionDecisions.resolve, { decision_id: id, status: "answered", answer_index: 1 });
  expect((await row(id)).run.state).toBe("skipped");
  expect(await commands()).toHaveLength(0);
});

test("a run card cannot be edited into another command", async () => {
  const { t, ask } = await seed();
  const { id } = await ask(GRANT);
  const edited = await t.mutation(api.sessionDecisions.edit, { api_token: ANA_TOKEN, session_id: "sess-ana-1", decision_id: id, question: "Something else?" });
  expect(edited.error).toMatch(/cannot be edited/);
});

test("an out-of-date client's bare Run answer never reaches the session; its Don't run does", async () => {
  const { t, ask, as, ana, messages } = await seed();
  const { id } = await ask(GRANT);
  const send = (answer: string, client: string) => as(ana).mutation(api.dispatch.dispatch, { action: "sendMessage", args: [String((ids as any).conv), formatDecisionAnswer({ id: String(id), question: "Grant @ads $500 a month?", answer }), [], client] });
  const ids = await t.run(async (ctx: any) => ({ conv: (await ctx.db.query("conversations").first())._id }));
  await expect(send(RUN_OPTION, "client-run-1")).rejects.toThrow(/out of date/);
  expect(await messages()).toHaveLength(0);
  await send(SKIP_OPTION, "client-skip-1");
  expect(await messages()).toHaveLength(1);
});
