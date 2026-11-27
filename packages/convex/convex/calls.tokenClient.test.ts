// A phone marks its LiveKit seat `client: "phone"` (calls.mintAccessToken):
// a phone transcribes only its own mic, so another phone in the room reads
// the mark to know it must not hand its run to that seat. Web passes nothing
// and its token is unchanged.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { dmRoomKey } from "./callRooms";

setDefaultTimeout(30_000);

const saved = { ...process.env };
beforeAll(() => {
  process.env.LIVEKIT_URL = "wss://lk.test";
  process.env.LIVEKIT_API_KEY = "k";
  process.env.LIVEKIT_API_SECRET = "s".repeat(32);
});
afterAll(() => {
  for (const k of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function claims(token: string): any {
  const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

async function world(image?: string) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", active_team_id: team, ...(image ? { image } : {}) } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "member", joined_at: Date.now() } as any);
    return { ana };
  });
  return { as: t.withIdentity({ subject: `${ids.ana}|session` }), room: dmRoomKey(ids.ana) };
}

test("a phone's token carries client: phone beside the picture", async () => {
  const { as, room } = await world("https://img.test/ana.png");
  const { token } = await as.action(api.calls.mintAccessToken, { room_key: room, client: "phone" });
  expect(JSON.parse(claims(token).metadata)).toEqual({ image: "https://img.test/ana.png", client: "phone" });
});

test("a phone with no picture still says it is a phone", async () => {
  const { as, room } = await world();
  const { token } = await as.action(api.calls.mintAccessToken, { room_key: room, client: "phone" });
  expect(JSON.parse(claims(token).metadata)).toEqual({ client: "phone" });
});

test("web's token is unchanged", async () => {
  const withImage = await world("https://img.test/ana.png");
  const a = await withImage.as.action(api.calls.mintAccessToken, { room_key: withImage.room });
  expect(JSON.parse(claims(a.token).metadata)).toEqual({ image: "https://img.test/ana.png" });
  const bare = await world();
  const b = await bare.as.action(api.calls.mintAccessToken, { room_key: bare.room });
  expect(claims(b.token).metadata).toBeUndefined();
});
