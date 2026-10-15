import { describe, expect, test } from "bun:test";
import { requestLoginFlow, submitLoginCode, requestMintToken } from "./accountSwitch";
import { DEVICE_ONLINE_MS, LOGIN_FLOW_STALE_MS } from "./ccAccountsShared";
import { makeFakeDb } from "./testDb";

// A busy daemon lands its beats 60-100s apart, so its row reads "offline" for
// stretches while it is running the very sign-in the person is trying to
// relaunch or finish (Mac mini on team@union.app, 2026-10-15).
function fixture(lastSeenAgo: number) {
  const now = Date.now();
  const device: any = { _id: "devices_mini", user_id: "users_owner", device_id: "mini", last_seen: now - lastSeenAgo,
    cc_accounts: { active_email: "claude5@example.com", profiles: [{ name: "work", email: "work@example.com" }] } };
  const tables = { devices: [device], daemon_commands: [] as any[] };
  const ctx = { db: makeFakeDb(tables), auth: { getUserIdentity: async () => ({ subject: "users_owner|session" }) } };
  return { device, tables, ctx };
}

describe("sign-in flows on a daemon whose beats run late", () => {
  test("relaunch and code paste reach a device just past the online window", async () => {
    const f = fixture(DEVICE_ONLINE_MS + 30_000);
    await (requestLoginFlow as any)._handler(f.ctx, { device_id: "mini", force: true });
    expect(f.device.cc_login_flow).toMatchObject({ status: "pending", email: "claude5@example.com" });
    const started_at = f.device.cc_login_flow.started_at;
    await (submitLoginCode as any)._handler(f.ctx, { device_id: "mini", started_at, code: "abc#state" });
    expect(f.tables.daemon_commands.map((c) => JSON.parse(c.args))).toEqual([{ email: "claude5@example.com", force: true }, { login_code: "abc#state" }]);
    await (requestMintToken as any)._handler(f.ctx, { device_id: "mini", profile: "work" });
    expect(f.device.cc_mint_flow).toMatchObject({ status: "pending", profile: "work" });
  });

  test("a daemon unseen for a whole flow lifetime is still offline", async () => {
    const f = fixture(LOGIN_FLOW_STALE_MS + 1_000);
    await expect((requestLoginFlow as any)._handler(f.ctx, { device_id: "mini" })).rejects.toThrow("offline");
    await expect((requestMintToken as any)._handler(f.ctx, { device_id: "mini", profile: "work" })).rejects.toThrow("offline");
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("another user's device is never a target", async () => {
    const f = fixture(0);
    f.ctx.auth.getUserIdentity = async () => ({ subject: "users_other|session" });
    await expect((requestLoginFlow as any)._handler(f.ctx, { device_id: "mini" })).rejects.toThrow("offline");
  });
});
