// Areas set in plain words (decisionAreas.ts) under convex-test, with the
// model call stubbed at fetch: the words become a map onto the team's members
// and projects, a dry run changes nothing, applying writes each member's
// areas, and the call is refused when the team's model budget has no cap.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { setBudgetCap } from "./lib/teamBudget";

setDefaultTimeout(60_000);

const TOKEN = "f".repeat(64);
const T0 = 1_760_000_000_000;

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
const model = { replies: [] as string[], prompts: [] as string[] };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  model.replies = [];
  model.prompts = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    model.prompts.push(body.messages?.[0]?.content?.[0]?.text ?? JSON.stringify(body.messages));
    const text = model.replies.shift() ?? '{"members":[]}';
    return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function setup(opts: { budget?: boolean } = {}) {
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
    "./decisionAreas.ts": () => import("./decisionAreas"),
    "./modelCalls.ts": () => import("./modelCalls"),
  });
  const ids = await t.run(async (ctx) => {
    const ashot = await ctx.db.insert("users", { name: "Ashot Petrosian", email: "ashot@example.com" } as any);
    const samvit = await ctx.db.insert("users", { name: "Samvit Ramadurgam" } as any);
    const jason = await ctx.db.insert("users", { name: "Jason Benn" } as any);
    const bot = await ctx.db.insert("users", { name: "Mr Bot", is_bot: true } as any);
    await ctx.db.insert("api_tokens", { user_id: ashot, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const team = await ctx.db.insert("teams", { name: "Union" } as any);
    for (const [u, role] of [[ashot, "admin"], [samvit, "member"], [jason, "member"], [bot, "member"]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role, joined_at: T0 } as any);
    }
    await ctx.db.patch(ashot, { active_team_id: team } as any);
    const workspace = `team:${team}`;
    if (opts.budget !== false) await setBudgetCap(ctx, workspace, team, 100, ashot, Date.now());
    const project = (title: string) => ctx.db.insert("projects", { user_id: ashot, team_id: team, workspace, title, status: "active", created_at: T0, updated_at: T0 } as any);
    const deals = await project("Deal flow");
    const intros = await project("Intros");
    const desk = await project("Desk");
    const evals = await project("Evals");
    return { ashot, samvit, jason, bot, team, deals, intros, desk, evals };
  });
  const focusOf = (user: any) => t.run(async (ctx) => {
    const m: any = await ctx.db.query("team_memberships").withIndex("by_user_team", (q) => q.eq("user_id", user).eq("team_id", ids.team)).first();
    return { projects: (m.focus_project_ids ?? []).map(String).sort(), takes: m.takes_decisions !== false };
  });
  return { t, ...ids, focusOf };
}

/** The model's answer for "Samvit: deals, intros and calling; Jason: desk and evals": members and projects by roster key. */
function replyFor(prompt: string, names: Record<string, string[]>, unplaced: string[] = []): string {
  const key = (line: RegExp) => prompt.split("\n").find((l) => line.test(l))?.match(/- (\w+):/)?.[1];
  return JSON.stringify({
    members: Object.entries(names).map(([person, projects]) => ({
      member: key(new RegExp(`: ${person}`)),
      projects: projects.map((p) => key(new RegExp(`: ${p}$`))),
      takes_decisions: true,
    })),
    unplaced,
  });
}

describe("cast team focus", () => {
  test("plain words map onto members and projects, and apply", async () => {
    const s = await setup();
    // The stub answers by reading the roster the prompt carries, the way the model does.
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const prompt = JSON.parse(init.body).messages[0].content[0].text ?? JSON.parse(init.body).messages[0].content;
      model.prompts.push(prompt);
      const text = replyFor(String(prompt), { "Samvit": ["Deal flow", "Intros"], "Jason": ["Desk", "Evals"] }, ["calling"]);
      return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    }) as unknown as typeof fetch;

    const words = "Samvit: deals, intros and calling; Jason: desk and evals";
    const dry: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: TOKEN, words, dry_run: true });
    expect(dry.error).toBeUndefined();
    expect(model.prompts[0]).toContain(words);
    expect(model.prompts[0]).not.toContain("Mr Bot");
    const byName = Object.fromEntries(dry.assignments.map((a: any) => [a.name, a.projects.map((p: any) => p.title)]));
    expect(byName["Samvit Ramadurgam"]).toEqual(["Deal flow", "Intros"]);
    expect(byName["Jason Benn"]).toEqual(["Desk", "Evals"]);
    expect(byName["Ashot Petrosian"]).toEqual([]);
    expect(dry.unplaced).toEqual(["calling"]);
    expect(dry.text).toBe("Samvit Ramadurgam: Deal flow, Intros; Jason Benn: Desk, Evals");
    expect((await s.focusOf(s.samvit)).projects).toEqual([]);

    const applied: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: TOKEN, words });
    expect(applied.applied).toBe(2);
    expect((await s.focusOf(s.samvit)).projects).toEqual([String(s.deals), String(s.intros)].sort());
    expect((await s.focusOf(s.jason)).projects).toEqual([String(s.desk), String(s.evals)].sort());
    expect((await s.focusOf(s.ashot)).projects).toEqual([]);

    const current: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: TOKEN });
    expect(current.current).toBe(true);
    expect(current.text).toBe("Samvit Ramadurgam: Deal flow, Intros; Jason Benn: Desk, Evals");
  });

  test("a key the model invents is dropped, and a person said not to decide is marked so", async () => {
    const s = await setup();
    model.replies.push(JSON.stringify({ members: [{ member: "m2", projects: ["p1", "p99"], takes_decisions: false }, { member: "m42", projects: ["p2"] }], unplaced: [] }));
    const r: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: TOKEN, words: "Samvit is out this month; keep him on deals" });
    expect(r.applied).toBe(1);
    const sam = await s.focusOf(s.samvit);
    expect(sam.projects).toEqual([String(s.deals)]);
    expect(sam.takes).toBe(false);
  });

  test("with no model budget the words are not sent", async () => {
    const s = await setup({ budget: false });
    const r: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: TOKEN, words: "Samvit: deals" });
    expect(r.error).toBe("The team's model budget has no room this month");
    expect(model.prompts).toEqual([]);
  });

  test("only an admin applies", async () => {
    const s = await setup();
    const SAM_TOKEN = "s".repeat(64);
    await s.t.run(async (ctx) => { await ctx.db.insert("api_tokens", { user_id: s.samvit, token_hash: await hashToken(SAM_TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any); });
    model.replies.push(JSON.stringify({ members: [{ member: "m2", projects: ["p1"] }] }));
    const r: any = await s.t.action(api.decisionAreas.focusForCli, { api_token: SAM_TOKEN, team_id: String(s.team), words: "Samvit: deals" });
    expect(r.error).toBe("Only a team admin sets who decides for which areas");
  });
});

describe("Change areas (mapAreas)", () => {
  test("previews the map for a signed-in member and changes nothing", async () => {
    const s = await setup();
    model.replies.push(JSON.stringify({ members: [{ member: "m3", projects: ["p3"] }], unplaced: [] }));
    const r: any = await s.t.withIdentity({ subject: `${s.jason}|session` }).action(api.decisionAreas.mapAreas, { team_id: s.team, words: "Jason: desk" });
    expect(r.error).toBeUndefined();
    expect(r.assignments.find((a: any) => a.user_id === String(s.jason)).projects).toEqual([{ id: String(s.desk), title: "Desk" }]);
    expect((await s.focusOf(s.jason)).projects).toEqual([]);
  });
});
