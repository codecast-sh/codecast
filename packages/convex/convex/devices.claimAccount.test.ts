import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { claimDeviceAccount, LEGACY_DEVICE_CLAIM_SUNSET_MS, performClaimDeviceAccount, registerDevice } from "./devices";
import { hashToken } from "./apiTokens";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const PREV = "u".repeat(31) + "p";
const NEXT = "u".repeat(31) + "n";
const TEAM = "t".repeat(32);
const NOW = 1_700_000_000_000;

function fixtures(over: { prevSeen?: number; conv?: Record<string, any> } = {}) {
  return makeFakeDb({
    users: [
      { _id: PREV, name: "Ashot" },
      { _id: NEXT, name: "Aivery" },
    ],
    team_memberships: [
      { _id: "m1", user_id: PREV, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: NEXT, team_id: TEAM, role: "member" },
    ],
    devices: [
      { _id: "d-next", user_id: NEXT, device_id: "mini", last_seen: NOW },
      { _id: "d-prev", user_id: PREV, device_id: "mini", last_seen: over.prevSeen ?? NOW - DEVICE_ONLINE_MS - 1 },
    ],
    conversations: [
      {
        _id: "conv1",
        user_id: PREV,
        owner_device_id: "mini",
        session_id: "sess-1",
        project_path: "/Users/ec2-user/.intern-data/worktrees/cs-1/outreach",
        status: "active",
        team_id: TEAM,
        is_private: false,
        ...(over.conv ?? {}),
      },
      {
        _id: "conv-other",
        user_id: PREV,
        owner_device_id: "laptop",
        session_id: "sess-2",
        status: "active",
      },
    ],
    managed_sessions: [
      { _id: "ms1", session_id: "sess-1", conversation_id: "conv1", user_id: PREV, pid: 1, last_heartbeat: NOW },
    ],
  });
}

const conv = (db: any, id = "conv1") => db._tables.conversations.find((c: any) => c._id === id);

describe("performClaimDeviceAccount", () => {
  test("sessions this device owns move to the new account without a resume", async () => {
    const db = fixtures();
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result).toEqual({ moved: 1, more: false });
    expect(conv(db).user_id).toBe(NEXT);
    expect(conv(db).author_user_id).toBe(PREV);
    expect(conv(db).owner_device_id).toBe("mini");
    expect(conv(db, "conv-other").user_id).toBe(PREV);
    expect(db._tables.managed_sessions[0].user_id).toBe(NEXT);
    expect(db._tables.daemon_commands ?? []).toEqual([]);
  });

  test("undelivered messages follow the session to the new account", async () => {
    const db = fixtures();
    db._tables.pending_messages = [
      { _id: "pm1", conversation_id: "conv1", from_user_id: PREV, owner_user_id: PREV, status: "pending" },
    ];
    await performClaimDeviceAccount({ db }, NEXT as any, { previousUserId: PREV as any, deviceId: "mini" }, NOW);
    expect(db._tables.pending_messages[0].owner_user_id).toBe(NEXT);
  });

  test("a previous login that is still heartbeating is left alone", async () => {
    const db = fixtures({ prevSeen: NOW });
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result.pending).toBe(true);
    expect(result.moved).toBe(0);
    expect(conv(db).user_id).toBe(PREV);
  });

  test("accounts that do not share a team are refused", async () => {
    const db = fixtures();
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== NEXT);
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result.error).toMatch(/share a team/);
    expect(conv(db).user_id).toBe(PREV);
  });

  test("a session private to the previous account stays with it", async () => {
    const db = fixtures({ conv: { is_private: true } });
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result).toEqual({ moved: 0, more: false, skipped: 1 });
    expect(conv(db).user_id).toBe(PREV);
    expect(db._tables.managed_sessions[0].user_id).toBe(PREV);
  });

  test("a private session the caller owns still moves", async () => {
    const db = fixtures({ conv: { is_private: true, owner_user_id: NEXT } });
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result).toEqual({ moved: 1, more: false });
    expect(conv(db).user_id).toBe(NEXT);
  });
});

describe("device functions speak for a machine: token only, bound device only", () => {
  const BOUND = "tok-bound-mini";
  const ELSEWHERE = "tok-bound-laptop";
  const PREV_TOKEN = "tok-prev-mini";
  const PREV_ELSEWHERE = "tok-prev-laptop";
  async function ctxWithTokens(authUser: string | null = null) {
    const db = fixtures();
    db._tables.api_tokens = [
      { _id: "at1", user_id: NEXT, token_hash: await hashToken(BOUND), device_id: "mini", last_used_at: NOW },
      { _id: "at2", user_id: NEXT, token_hash: await hashToken(ELSEWHERE), device_id: "laptop", last_used_at: NOW },
      { _id: "at3", user_id: PREV, token_hash: await hashToken(PREV_TOKEN), device_id: "mini", last_used_at: NOW },
      { _id: "at4", user_id: PREV, token_hash: await hashToken(PREV_ELSEWHERE), device_id: "laptop", last_used_at: NOW },
    ];
    db._tables.devices.find((d: any) => d._id === "d-next").last_seen = Date.now();
    return { db, auth: { getUserIdentity: async () => (authUser ? { subject: `${authUser}|session` } : null) } } as any;
  }

  test("a browser session cannot claim or register a device", async () => {
    const ctx = await ctxWithTokens(NEXT);
    await expect((claimDeviceAccount as any)._handler(ctx, { previous_user_id: PREV, device_id: "mini" })).rejects.toThrow("Authentication required");
    await expect((registerDevice as any)._handler(ctx, { device_id: "victim-device", label: "x", platform: "darwin" })).rejects.toThrow("Authentication required");
    expect(conv(ctx.db).user_id).toBe(PREV);
    expect(ctx.db._tables.devices).toHaveLength(2);
  });

  test("a token bound to another machine cannot claim or register this device id", async () => {
    const ctx = await ctxWithTokens();
    const claimed = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${ELSEWHERE}.laptop`, previous_user_id: PREV, device_id: "mini" });
    expect(claimed.error).toMatch(/different machine/);
    expect(conv(ctx.db).user_id).toBe(PREV);
    await expect((registerDevice as any)._handler(ctx, { api_token: `${ELSEWHERE}.laptop`, device_id: "mini", label: "x", platform: "darwin" })).rejects.toThrow("different machine");
  });

  // F31: a teammate who learned the device id and minted a token bound to it
  // still holds nothing of the previous account's, so nothing moves.
  let clock: any;
  afterEach(() => clock?.mockRestore());
  const at = (ms: number) => { clock?.mockRestore(); clock = spyOn(Date, "now").mockReturnValue(ms); };

  test("until the sunset, a daemon that predates the proof still claims (and is logged)", async () => {
    const ctx = await ctxWithTokens();
    at(LEGACY_DEVICE_CLAIM_SUNSET_MS - 1);
    ctx.db._tables.devices.find((d: any) => d._id === "d-next").last_seen = Date.now();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const claimed = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini" });
    expect(claimed).toEqual({ moved: 1, more: false });
    expect(warn.mock.calls.some((c: any[]) => String(c[0]).includes("legacy claim"))).toBe(true);
    warn.mockRestore();
  });

  test("a presented token must check out even before the sunset", async () => {
    const ctx = await ctxWithTokens();
    at(LEGACY_DEVICE_CLAIM_SUNSET_MS - 1);
    ctx.db._tables.devices.find((d: any) => d._id === "d-next").last_seen = Date.now();
    const forged = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini", previous_api_token: `${BOUND}.mini` });
    expect(forged.needs_proof).toBe(true);
    expect(conv(ctx.db).user_id).toBe(PREV);
  });

  test("after the sunset, a claim without the previous account's own token moves nothing", async () => {
    const ctx = await ctxWithTokens();
    at(LEGACY_DEVICE_CLAIM_SUNSET_MS);
    ctx.db._tables.devices.find((d: any) => d._id === "d-next").last_seen = Date.now();
    const bare = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini" });
    expect(bare.error).toMatch(/no proof/);
    expect(bare.needs_proof).toBe(true);
    const own = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini", previous_api_token: `${BOUND}.mini` });
    expect(own.error).toMatch(/no proof/);
    const otherMachine = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini", previous_api_token: `${PREV_ELSEWHERE}.laptop` });
    expect(otherMachine.error).toMatch(/no proof/);
    expect(conv(ctx.db).user_id).toBe(PREV);
  });

  test("the machine's own token claims and registers", async () => {
    const ctx = await ctxWithTokens();
    const claimed = await (claimDeviceAccount as any)._handler(ctx, { api_token: `${BOUND}.mini`, previous_user_id: PREV, device_id: "mini", previous_api_token: `${PREV_TOKEN}.mini` });
    expect(claimed).toEqual({ moved: 1, more: false });
    expect(await (registerDevice as any)._handler(ctx, { api_token: `${BOUND}.mini`, device_id: "mini", label: "Mini", platform: "darwin" })).toEqual({ device_id: "mini", created: false });
  });
});
