// Dictation: the switch is the person's own, and the mint refuses with one
// line (signed out, off, a regulated team without a BAA, no key) or asks
// OpenAI for a client-turn gpt-live-transcribe session.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { LIVE_TRANSCRIBE_MODEL } from "@codecast/shared/contracts";
import { vendorUncoveredMessage } from "@codecast/shared/contracts/vendorCoverage";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
let posted: Array<{ url: string; body: any }>;
let respond: (body: any) => Response;

const ok = () => new Response(JSON.stringify({ value: "ek_test" }), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  posted = [];
  respond = ok;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    posted.push({ url: String(url), body });
    return respond(body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

async function setup(opts: { enabled?: boolean; regulated?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ann = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev", ...(opts.enabled ? { dictation_enabled: true } : {}) } as any);
    const bob = await ctx.db.insert("users", { name: "Bob", email: "bob@x.dev" } as any);
    if (opts.regulated) {
      const team = await ctx.db.insert("teams", { name: "Clinic", invite_code: "CLINIC12", created_at: 1, policy: { regulated_data: true } } as any);
      await ctx.db.insert("team_memberships", { user_id: ann, team_id: team, role: "admin", joined_at: 1 } as any);
      await ctx.db.patch(ann, { active_team_id: team } as any);
    }
    return { ann, bob };
  });
  return { t, ids, as: (id: string) => t.withIdentity({ subject: `${id}|session` }) };
}

describe("setDictationEnabled", () => {
  test("writes the switch on the caller's row only", async () => {
    const { t, ids, as } = await setup();
    await as(ids.ann).mutation(api.dictation.setDictationEnabled, { enabled: true });
    let rows = await t.run(async (ctx) => [await ctx.db.get(ids.ann), await ctx.db.get(ids.bob)]);
    expect(rows[0]!.dictation_enabled).toBe(true);
    expect(rows[1]!.dictation_enabled).toBeUndefined();
    await as(ids.ann).mutation(api.dictation.setDictationEnabled, { enabled: false });
    rows = await t.run(async (ctx) => [await ctx.db.get(ids.ann), await ctx.db.get(ids.bob)]);
    expect(rows[0]!.dictation_enabled).toBe(false);
    expect(rows[1]!.dictation_enabled).toBeUndefined();
  });

  test("refuses a signed-out caller", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.dictation.setDictationEnabled, { enabled: true })).rejects.toThrow("Not authenticated");
  });
});

describe("mintDictationToken", () => {
  test("refuses a signed-out caller", async () => {
    const { t } = await setup({ enabled: true });
    expect(await t.action(api.dictation.mintDictationToken, {})).toEqual({ error: "Not signed in" });
    expect(posted).toHaveLength(0);
  });

  test("refuses while the switch is off", async () => {
    const { ids, as } = await setup();
    expect(await as(ids.ann).action(api.dictation.mintDictationToken, {})).toEqual({ error: "Dictation is off" });
    expect(posted).toHaveLength(0);
  });

  test("refuses in a regulated team with no OpenAI BAA, with the guard's own words", async () => {
    const { ids, as } = await setup({ enabled: true, regulated: true });
    expect(await as(ids.ann).action(api.dictation.mintDictationToken, {})).toEqual({ error: vendorUncoveredMessage("openai", "Clinic") });
    expect(posted).toHaveLength(0);
  });

  test("refuses when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const { ids, as } = await setup({ enabled: true });
    expect(await as(ids.ann).action(api.dictation.mintDictationToken, {})).toEqual({ error: "Transcription is not configured" });
    expect(posted).toHaveLength(0);
  });

  test("mints a client-turn gpt-live-transcribe session with the folded languages", async () => {
    const { ids, as } = await setup({ enabled: true });
    const res = await as(ids.ann).action(api.dictation.mintDictationToken, { languages: ["en-US", "es", "en"] });
    expect(res).toEqual({ client_secret: "ek_test", model: LIVE_TRANSCRIBE_MODEL, languages: ["en", "es"] });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const input = posted[0]!.body.session.audio.input;
    expect(input.transcription).toEqual({ model: LIVE_TRANSCRIBE_MODEL, languages: ["en", "es"] });
    expect(input.turn_detection ?? null).toBeNull();
  });

  test("retries with no languages when the first mint is refused", async () => {
    respond = (body) =>
      body.session.audio.input.transcription.languages
        ? new Response(JSON.stringify({ error: { message: "bad language" } }), { status: 400 })
        : ok();
    const { ids, as } = await setup({ enabled: true });
    const res = await as(ids.ann).action(api.dictation.mintDictationToken, { languages: ["ja"] });
    expect(res).toEqual({ client_secret: "ek_test", model: LIVE_TRANSCRIBE_MODEL, languages: [] });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body.session.audio.input.transcription).toEqual({ model: LIVE_TRANSCRIBE_MODEL });
  });
});
