// The vendor guard (HIPAA, plan pl-990): a regulated team's content reaches a
// vendor only once Codecast holds a BAA with it. For each vendor, a regulated
// team is refused while the vendor is uncovered and allowed once the list
// names it, and a team without regulated data is unchanged. The helper is
// tested with the list passed in; each chokepoint is tested against the real
// list, which starts empty.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { allModules } from "../testModules.testkit";
import { BAA_COVERED_VENDORS, VENDORS, vendorUncoveredMessage, type ContentVendor } from "@codecast/shared/contracts/vendorCoverage";
import { vendorRefusalFromDb } from "./vendorGuard";
import { callModelMetered, createBatch, postMessages } from "./anthropic";
import { openaiFetch } from "./openai";
import { embedText } from "./embeddings";
import { callsOffReason } from "../callRooms";
import { faceMode } from "../callFace";

setDefaultTimeout(60_000);

const CONTENT_VENDORS = (Object.keys(VENDORS) as Array<keyof typeof VENDORS>).filter((v) => VENDORS[v].receives === "content") as ContentVendor[];

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@clinic.dev" } as any);
    const features = { calls: true, agent_faces: true, agent_realtime: true };
    const clinic = await ctx.db.insert("teams", { name: "Clinic", invite_code: "CLINIC12", created_at: 1, features, policy: { regulated_data: true } } as any);
    const shop = await ctx.db.insert("teams", { name: "Shop", invite_code: "SHOP1234", created_at: 1, features } as any);
    const conv = (team: Id<"teams">, visible: boolean) =>
      ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1, message_count: 0, status: "active",
        team_id: team, is_private: !visible, ...(visible ? { team_visibility: "full" } : {}),
      } as any);
    return {
      clinic,
      shop,
      clinicConv: await conv(clinic, true),
      clinicPrivateConv: await conv(clinic, false),
      shopConv: await conv(shop, true),
    };
  });
  return { t, ...ids };
}

describe("the BAA list", () => {
  test("starts empty: a vendor joins only once its BAA is signed (ct-87100)", () => {
    expect(BAA_COVERED_VENDORS).toEqual([]);
  });
});

describe("vendorRefusalFromDb", () => {
  for (const vendor of CONTENT_VENDORS) {
    test(`${vendor}: regulated refused while uncovered, allowed once covered; others unchanged`, async () => {
      const { t, clinic, shop, clinicConv, clinicPrivateConv, shopConv } = await setup();
      await t.run(async (ctx) => {
        const line = vendorUncoveredMessage(vendor, "Clinic");
        expect(await vendorRefusalFromDb(ctx, { workspace: `team:${clinic}` }, vendor, [])).toBe(line);
        expect(await vendorRefusalFromDb(ctx, { conversationId: clinicConv }, vendor, [])).toBe(line);
        // A private session filed under the regulated team holds its data too.
        expect(await vendorRefusalFromDb(ctx, { conversationId: clinicPrivateConv }, vendor, [])).toBe(line);
        expect(await vendorRefusalFromDb(ctx, { workspace: `team:${clinic}` }, vendor, [vendor])).toBeNull();
        expect(await vendorRefusalFromDb(ctx, { conversationId: clinicConv }, vendor, [vendor])).toBeNull();
        expect(await vendorRefusalFromDb(ctx, { workspace: `team:${shop}` }, vendor, [])).toBeNull();
        expect(await vendorRefusalFromDb(ctx, { conversationId: shopConv }, vendor, [])).toBeNull();
        expect(await vendorRefusalFromDb(ctx, {}, vendor, [])).toBeNull();
      });
    });
  }

  test("the action path (vendorCoverage:refusalFor) answers the same", async () => {
    const { t, clinicConv, shopConv } = await setup();
    expect(await t.query(internal.vendorCoverage.refusalFor, { conversation_id: clinicConv, vendor: "anthropic" })).toBe(vendorUncoveredMessage("anthropic", "Clinic"));
    expect(await t.query(internal.vendorCoverage.refusalFor, { conversation_id: shopConv, vendor: "anthropic" })).toBeNull();
    expect(await t.query(internal.vendorCoverage.refusalFor, { row: { table: "conversations", id: clinicConv }, vendor: "openai" })).toBe(vendorUncoveredMessage("openai", "Clinic"));
  });
});

// The chokepoints, with the vendors' network replaced: each must not send a
// regulated team's content, and must send everyone else's as before.
describe("chokepoints", () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let sent: string[] = [];
  beforeEach(() => {
    sent = [];
    Object.assign(process.env, { ANTHROPIC_API_KEY: "test", OPENAI_API_KEY: "test", FACE_WORKER_SECRET: "s", LIVEKIT_URL: "wss://lk.test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "x" });
    globalThis.fetch = (async (url: any) => {
      sent.push(String(url));
      const body = String(url).includes("embeddings")
        ? { data: [{ embedding: new Array(1536).fill(0) }], usage: { total_tokens: 1 } }
        : { id: "b1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = env;
  });

  test("anthropic: callModelMetered, postMessages and createBatch", async () => {
    const { t, clinicConv, shopConv, clinic } = await setup();
    await t.run(async (ctx) => {
      const refused = await callModelMetered({ prompt: "hi", max_tokens: 10, label: "t", gate: { ctx, scope: { conversationId: clinicConv } } });
      expect(refused).toEqual({ reply: null, usage: null, error: vendorUncoveredMessage("anthropic", "Clinic") });
      expect(await postMessages({ model: "m", prompt: "hi", max_tokens: 1 }, { gate: { ctx, scope: { conversationId: clinicConv } } })).toBeNull();
      await expect(createBatch({ ctx, scope: { workspace: `team:${clinic}` } }, [{ custom_id: "a", req: { model: "m", prompt: "hi", max_tokens: 1 } }])).rejects.toThrow("no BAA with Anthropic");
      expect(sent).toEqual([]);
      const allowed = await callModelMetered({ prompt: "hi", max_tokens: 10, label: "t", gate: { ctx, scope: { conversationId: shopConv } } });
      expect(allowed.reply?.text).toBe("ok");
      expect(sent).toEqual(["https://api.anthropic.com/v1/messages"]);
    });
  });

  test("openai: openaiFetch and embeddings", async () => {
    const { t, clinic, shop } = await setup();
    await t.run(async (ctx) => {
      expect(await openaiFetch({ ctx, scope: { workspace: `team:${clinic}` } }, "/v1/chat/completions", { method: "POST" })).toBeNull();
      expect(await embedText({ ctx, scope: { workspace: `team:${clinic}` } }, "a finding")).toBeNull();
      expect(sent).toEqual([]);
      expect((await embedText({ ctx, scope: { workspace: `team:${shop}` } }, "a finding"))?.vector.length).toBe(1536);
      expect(sent).toEqual(["https://api.openai.com/v1/embeddings"]);
    });
  });

  test("livekit: a regulated team holds no calls", async () => {
    const { t, clinic, shop } = await setup();
    await t.run(async (ctx) => {
      expect(await callsOffReason(ctx, clinic)).toBe(vendorUncoveredMessage("livekit", "Clinic"));
      expect(await callsOffReason(ctx, shop)).toBeNull();
    });
  });

  test("tavus: no agent faces for a regulated team", async () => {
    const { t, clinic, shop } = await setup();
    await t.run(async (ctx) => {
      expect(await faceMode(ctx, clinic)).toBe("off");
      expect(await faceMode(ctx, shop)).toBe("realtime");
    });
  });
});
