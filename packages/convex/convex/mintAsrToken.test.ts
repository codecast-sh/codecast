// What mintAsrToken asks OpenAI for. A client that commits its own turns
// (client_turns) gets gpt-live-transcribe with the room's languages and no
// turn detection; a build from before that gets the legacy session, which
// completes lines on server VAD.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { LEGACY_TRANSCRIBE_MODEL, LIVE_TRANSCRIBE_MODEL } from "@codecast/shared/contracts";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
let posted: Array<{ url: string; body: any }>;

beforeEach(() => {
  posted = [];
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (url: any, init: any) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ value: "ek_test" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

async function recording() {
  const t = convexTest(schema, allModules);
  const room_key = `rec:${crypto.randomUUID()}`;
  const owner = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "T", invite_code: "TEAM1234", created_at: 1, features: { calls: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("transcripts", {
      room_key, team_id: team, started_by: owner, status: "live", started_at: Date.now(), routes: [], last_seq: 0,
    } as any);
    return owner;
  });
  return { as: t.withIdentity({ subject: `${owner}|session` }), room_key };
}

describe("mintAsrToken", () => {
  test("a client that commits its own turns gets the live model with languages and no turn detection", async () => {
    const { as, room_key } = await recording();
    const res: any = await as.action(api.transcripts.mintAsrToken, { room_key, languages: ["en", "es"], client_turns: true });
    expect(res).toEqual({ client_secret: "ek_test", model: LIVE_TRANSCRIBE_MODEL, languages: ["en", "es"] });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const input = posted[0]!.body.session.audio.input;
    expect(input.transcription).toEqual({ model: LIVE_TRANSCRIBE_MODEL, languages: ["en", "es"] });
    expect(input.turn_detection ?? null).toBeNull();
  });

  test("a build without client_turns gets the legacy model on server VAD, no languages", async () => {
    const { as, room_key } = await recording();
    const res: any = await as.action(api.transcripts.mintAsrToken, { room_key, languages: ["en"] });
    expect(res).toEqual({ client_secret: "ek_test", model: LEGACY_TRANSCRIBE_MODEL, languages: [] });
    expect(posted).toHaveLength(1);
    const input = posted[0]!.body.session.audio.input;
    expect(input.transcription).toEqual({ model: LEGACY_TRANSCRIBE_MODEL });
    expect(input.turn_detection.type).toBe("server_vad");
  });
});
