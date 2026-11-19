// A huddle's stage holds what the room pinned beside the faces (callStage.ts):
// anyone seated may pin and unpin, an agent fed the room may too, and the
// call gets a board of its own that the first agent's join puts up.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { presentToken } from "@platform/auth/convex";
import { STAGE_PIN_LIMIT } from "@codecast/shared/contracts";
import { ensureCallBoard } from "./callStage";

setDefaultTimeout(30_000);

const RAW = "stage_agent_clisecret";
const backends: any[] = [];
afterEach(async () => { for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {}); });

async function world() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const out = await ctx.db.insert("users", { name: "Out" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken(RAW), name: "mac", created_at: now, last_used_at: now } as any);
    const room = `team:${team}`;
    for (const [u, name] of [[ana, "Ana"], [ben, "Ben"]] as const) {
      await ctx.db.insert("call_members", { room_key: room, team_id: team, user_id: u, user_name: name, joined_at: now, last_seen: now, muted: false, camera: false, sharing: false } as any);
    }
    const transcript = await ctx.db.insert("transcripts", { room_key: room, team_id: team, started_by: ana, status: "live", started_at: now, routes: [], last_seq: 0 } as any);
    const conv = await ctx.db.insert("conversations", { user_id: ana, title: "Agent", agent_type: "claude_code", status: "active", started_at: now, updated_at: now, message_count: 0, short_id: "jx7agnt" } as any);
    await ctx.db.insert("call_agent_feeds", { conversation_id: conv, transcript_id: transcript, room_key: room, team_id: team, added_by: ana } as any);
    const note = await ctx.db.insert("docs", { user_id: ana, team_id: team, workspace: `team:${team}`, title: "Notes", content: "# Notes", doc_type: "note", source: "human", created_at: now, updated_at: now } as any);
    const mine = await ctx.db.insert("docs", { user_id: ana, workspace: `user:${ana}`, title: "Private", content: "# Private", doc_type: "note", source: "human", created_at: now, updated_at: now } as any);
    return { team, ana, ben, out, room, transcript, conv, note, mine };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|session` });
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: presentToken(RAW), ...body }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { t, ids, as, post };
}

describe("call stage pins", () => {
  test("someone seated pins a doc; everyone seated sees it, an outsider sees nothing", async () => {
    const { t, ids, as } = await world();
    await as(ids.ben).mutation(api.callStage.pin, { room_key: ids.room, ref: `https://codecast.sh/docs/${ids.note}` });
    const seen = await as(ids.ana).query(api.callStage.listPins, { room_key: ids.room });
    expect(seen.map((p: any) => [p.ref, p.title, p.readable, p.pinned_by_name])).toEqual([[`doc:${ids.note}`, "Notes", true, "Ben"]]);
    expect(await as(ids.out).query(api.callStage.listPins, { room_key: ids.room })).toEqual([]);
    // The thread says what went up, once: pinning it again only brings it forward.
    await as(ids.ana).mutation(api.callStage.pin, { room_key: ids.room, ref: `doc:${ids.note}` });
    const lines = await t.run(async (ctx) => (await ctx.db.query("call_chat_messages").collect()).filter((m: any) => m.event === "stage_pinned"));
    expect(lines.map((m: any) => [m.text, String(m.user_id)])).toEqual([["Notes", String(ids.ben)]]);
    await expect(as(ids.out).mutation(api.callStage.pin, { room_key: ids.room, ref: `doc:${ids.note}` })).rejects.toThrow("Only someone in the huddle");
  });

  test("a doc only its owner can read shows to the others as locked, without its title", async () => {
    const { ids, as } = await world();
    await as(ids.ana).mutation(api.callStage.pin, { room_key: ids.room, ref: `doc:${ids.mine}` });
    const [forBen] = await as(ids.ben).query(api.callStage.listPins, { room_key: ids.room });
    expect([forBen.readable, forBen.title]).toEqual([false, null]);
    await expect(as(ids.ben).mutation(api.callStage.pin, { room_key: ids.room, ref: `doc:${ids.mine}` })).rejects.toThrow("No doc");
  });

  test("pinning the same thing twice is one pin; past the limit the oldest leaves", async () => {
    const { t, ids, as } = await world();
    await as(ids.ana).mutation(api.callStage.pin, { room_key: ids.room, ref: `doc:${ids.note}` });
    await as(ids.ana).mutation(api.callStage.pin, { room_key: ids.room, ref: `/docs/${ids.note}` });
    expect((await as(ids.ana).query(api.callStage.listPins, { room_key: ids.room })).length).toBe(1);
    for (let i = 0; i < STAGE_PIN_LIMIT; i++) await as(ids.ana).mutation(api.callStage.pin, { room_key: ids.room, ref: `ct-${i + 1}` });
    const refs = (await as(ids.ana).query(api.callStage.listPins, { room_key: ids.room })).map((p: any) => p.ref);
    expect(refs.length).toBe(STAGE_PIN_LIMIT);
    expect(refs).not.toContain(`doc:${ids.note}`);
    await as(ids.ben).mutation(api.callStage.unpin, { room_key: ids.room, ref: "ct-3" });
    expect((await as(ids.ana).query(api.callStage.listPins, { room_key: ids.room })).map((p: any) => p.ref)).not.toContain("ct-3");
    void t;
  });

  test("the call's board is made once, in the team, and pinned when made", async () => {
    const { t, ids, as } = await world();
    const first = await t.run(async (ctx) => ensureCallBoard(ctx as any, (await ctx.db.get(ids.transcript))!, ids.ana));
    const again = await t.run(async (ctx) => ensureCallBoard(ctx as any, (await ctx.db.get(ids.transcript))!, ids.ben));
    expect(String(again)).toBe(String(first));
    const board = await t.run(async (ctx) => ctx.db.get(first!));
    expect([board!.doc_type, String(board!.team_id)]).toEqual(["board", String(ids.team)]);
    const pins = await as(ids.ben).query(api.callStage.listPins, { room_key: ids.room });
    expect(pins.map((p: any) => [p.ref, p.doc_type, p.readable])).toEqual([[`doc:${first}`, "board", true]]);
  });

  test("an agent fed the room reads the board and pins through the CLI routes", async () => {
    const { ids, as, post } = await world();
    const board = await post("/cli/calls/board", { session: "jx7agnt" });
    expect(board.status).toBe(200);
    expect(board.body.pinned).toBe(true);
    const pin = await post("/cli/calls/pin", { session: "jx7agnt", ref: `doc:${ids.note}` });
    expect(pin.body.title).toBe("Notes");
    const pins = await as(ids.ben).query(api.callStage.listPins, { room_key: ids.room });
    const agentPin = pins.find((p: any) => p.ref === `doc:${ids.note}`);
    expect(agentPin.pinned_by_session).toBe(String(ids.conv));
    const listed = await post("/cli/calls/pins", { session: "jx7agnt" });
    expect(listed.body.pins.map((p: any) => p.board)).toEqual([true, false]);
    await post("/cli/calls/unpin", { session: "jx7agnt", ref: `doc:${ids.note}` });
    expect((await as(ids.ben).query(api.callStage.listPins, { room_key: ids.room })).length).toBe(1);
  });
});
