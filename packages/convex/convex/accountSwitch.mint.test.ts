import { describe, expect, test } from "bun:test";
import { cancelMintToken, reportMintFlow, requestMintToken, submitMintCode } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

function fixture() {
  const device: any = { _id: "devices_mac", user_id: "users_owner", device_id: "mini", last_seen: Date.now(),
    cc_accounts: { profiles: [{ name: "work", email: "work@example.com" }, { name: "home", email: "home@example.com" }] } };
  const tables = { devices: [device], daemon_commands: [] as any[] };
  const ctx = { db: makeFakeDb(tables), auth: { getUserIdentity: async () => ({ subject: "users_owner|session" }) } };
  const start = (profile = "work", force = false) => (requestMintToken as any)._handler(ctx, { device_id: "mini", profile, force });
  const report = (started_at: number | undefined, status = "confirmed", profile = "work") => (reportMintFlow as any)._handler(ctx, { device_id: "mini", profile, started_at, status });
  const cancel = (started_at: number) => (cancelMintToken as any)._handler(ctx, { device_id: "mini", started_at });
  return { device, tables, ctx, start, report, cancel };
}

describe("token mint lifecycle", () => {
  test("duplicate start joins; a different account replaces the attempt", async () => {
    const f = fixture();
    const first = await f.start();
    expect(await f.start()).toMatchObject({ already_pending: true, started_at: first.started_at });
    expect(f.tables.daemon_commands).toHaveLength(1);
    const second = await f.start("home");
    expect(second.started_at).toBeGreaterThan(first.started_at);
    expect(JSON.parse(f.tables.daemon_commands.at(-1).args)).toMatchObject({ mint: "home", force: true, mint_started_at: second.started_at });
    await f.report(first.started_at);
    expect(f.device.cc_mint_flow).toMatchObject({ profile: "home", status: "pending" });
  });

  test("cancel clears waiting even offline, and late reports cannot revive it", async () => {
    const f = fixture();
    const first = await f.start();
    f.device.last_seen = 0;
    await f.cancel(first.started_at);
    expect(f.device.cc_mint_flow.status).toBe("cancelled");
    expect(JSON.parse(f.tables.daemon_commands.at(-1).args)).toEqual({ cancel_mint: true, mint_started_at: first.started_at });
    await f.report(first.started_at, "pending");
    await f.report(undefined);
    expect(f.device.cc_mint_flow.status).toBe("cancelled");
  });

  test("late cancellation and reports leave a replacement untouched", async () => {
    const f = fixture();
    const first = await f.start();
    const second = await f.start("work", true);
    await f.cancel(first.started_at);
    await f.report(first.started_at, "rejected");
    expect(f.device.cc_mint_flow).toMatchObject({ started_at: second.started_at, status: "pending" });
    await f.report(second.started_at);
    expect(f.device.cc_mint_flow.status).toBe("confirmed");
  });

  test("a token attributed to another profile still completes the initiating dialog", async () => {
    const f = fixture();
    const first = await f.start();
    await f.report(first.started_at, "confirmed", "home");
    expect(f.device.cc_mint_flow).toMatchObject({ profile: "work", status: "confirmed" });
  });

  test("manual code is encrypted and can only reach the matching live attempt", async () => {
    const f = fixture();
    const first = await f.start();
    const payload = { provider: "claude-mint-code", epk: "public", iv: "nonce", ct: "ciphertext" };
    const submit = () => (submitMintCode as any)._handler(f.ctx, { device_id: "mini", started_at: first.started_at, payload });
    await submit();
    expect(JSON.parse(f.tables.daemon_commands.at(-1).args)).toEqual({ mint_code: payload, mint_started_at: first.started_at });
    await f.cancel(first.started_at);
    await expect(submit()).rejects.toThrow("This mint has ended");
  });

  test("another user cannot cancel or submit to this machine", async () => {
    const f = fixture();
    const first = await f.start();
    f.ctx.auth.getUserIdentity = async () => ({ subject: "users_other|session" });
    await expect(f.cancel(first.started_at)).rejects.toThrow("Unknown device");
    await expect((submitMintCode as any)._handler(f.ctx, { device_id: "mini", started_at: first.started_at,
      payload: { provider: "claude-mint-code", epk: "x", iv: "x", ct: "x" } })).rejects.toThrow("offline");
    expect(f.device.cc_mint_flow.status).toBe("pending");
  });
});
