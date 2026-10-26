// The moments suites' shared harness: synthetic data only, the model and the
// embedding stubbed at fetch. Two dots in the name keep it out of the Convex
// bundle (testModules.testkit.ts).
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { FINDING_VECTOR_DIMENSIONS } from "./momentsSchema";

export const TOKEN = "m".repeat(64);
export const T0 = Date.now();

/** A unit vector along one axis, mixed a little with another: cosine between two is easy to set. */
export function vec(axis: number, lean = 0, toward = (axis + 1) % FINDING_VECTOR_DIMENSIONS): number[] {
  const v = new Array(FINDING_VECTOR_DIMENSIONS).fill(0);
  v[axis] = Math.sqrt(1 - lean * lean);
  v[toward] = lean;
  return v;
}

export function stubs() {
  const realFetch = globalThis.fetch;
  const keys = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  // embedFail: how many embedding calls fail next (grouping could not compare a finding).
  const state = { judge: '{"deviations": []}', vectors: [] as number[][], model: [] as any[], embeds: [] as string[], embedFail: 0 };
  return {
    state,
    install() {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      globalThis.fetch = (async (url: unknown, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (String(url).includes("api.openai.com")) {
          if (state.embedFail > 0 && state.embedFail--) return new Response("overloaded", { status: 529 });
          state.embeds.push(body.input);
          return new Response(JSON.stringify({ data: [{ embedding: state.vectors.shift() ?? vec(0) }], usage: { total_tokens: 20 } }));
        }
        state.model.push(body);
        const isAttach = String(body.system ?? "").includes("list of causes");
        return new Response(JSON.stringify({ content: [{ type: "text", text: isAttach ? '{"answer":"none"}' : state.judge }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 120 } }));
      }) as unknown as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, env] of [["a", "ANTHROPIC_API_KEY"], ["o", "OPENAI_API_KEY"]] as const) {
        if (keys[k] === undefined) delete process.env[env];
        else process.env[env] = keys[k];
      }
    },
  };
}

export const JUDGE = {
  name: "comms",
  path: ".codecast/judges/comms.md",
  version: "a".repeat(40),
  moment: "conversation",
  model: "claude-haiku-5-5",
  max_tokens: 800,
  projects: ["Agent Quality"],
  mode: "live" as const,
  prompt: "Read the conversation and say where the agent broke what we expect.",
};

export async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const team = await ctx.db.insert("teams", { name: "Product", created_at: T0, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "host-1", label: "Host", platform: "darwin", last_seen: T0 } as any);
    const workspace = `team:${team}`;
    const project = await ctx.db.insert("projects", {
      user_id: user, team_id: team, workspace, short_id: "pr-1", title: "Agent Quality", status: "active", created_at: T0, updated_at: T0,
      line_profile: { finders: [{ id: "comms", source: "judge:comms", kind: ["prompt_miss"], fingerprint: "moment:<id>:<expectation>", opens_causes: true }], changed_at: T0 },
    } as any);
    await ctx.db.insert("project_expectations", {
      project_id: project, user_id: user, workspace, version: 3, prefix: "aq", next_n: 3, summary: "v3", how: "person", created_at: T0,
      items: [
        { id: "ex-aq-1", text: "Reply to a broker within one business day.", part: "Replies", status: "active", citations: [], added_in: 1, changed_in: 1 },
        { id: "ex-aq-2", text: "Never promise a call time nobody owns.", part: "Replies", status: "retired", citations: [], added_in: 1, changed_in: 2, retired_reason: "x" },
      ],
    } as any);
    const source = await ctx.db.insert("event_sources", { workspace, team_id: team, owner_user_id: user, project_id: project, short_id: "src-1", provider: "http", name: "app", promote: [], status: "active", created_at: T0, updated_at: T0 } as any);
    return { user, team, project, source, workspace };
  });
  const scope = { api_token: TOKEN, workspace: "team" as const, team_id: ids.team };
  const post = (items: any[]) => t.mutation(internal.ingest.applyBatch, { source_id: ids.source, items_json: JSON.stringify(items) });
  const due = () => t.run(async (ctx) => { for (const m of await ctx.db.query("moments").collect()) if (m.status === "waiting") await ctx.db.patch(m._id, { due_at: Date.now() - 1 }); });
  const claim = () => t.mutation(api.moments.claim, { api_token: TOKEN, device_id: "host-1" });
  const output = (subject: string, body = "Can we talk Tuesday?") => JSON.stringify({ refs: [{ label: "thread", id: subject, url: `https://app.example/t/${subject}` }], blocks: [{ type: "message", direction: "in", channel: "sms", at: T0 - 60_000, sender: "Dana", body }] });
  const complete = (moment: string, subject: string) => t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment, extractor_version: "b".repeat(40), output: output(subject) });
  return { t, ids, scope, post, due, claim, complete };
}
