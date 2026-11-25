import { describe, expect, test } from "bun:test";
import { start, reportUrl, reportNotice, submitCallback, cancel, complete } from "./mcpLogin";
import { makeFakeDb } from "./testDb";

function fixture(user = "users_owner") {
  const device: any = { _id: "devices_host", user_id: "users_owner", device_id: "host", last_seen: Date.now() };
  const tables = { devices: [device], daemon_commands: [] as any[] };
  const ctx = { db: makeFakeDb(tables), auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } };
  return { device, tables, ctx };
}
const call = (fn: unknown, ctx: unknown, args: unknown) => (fn as any)._handler(ctx, args);
const AUTH_URL = "https://mcp.sentry.dev/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback";

describe("MCP sign-in on a machine", () => {
  test("start, URL, pasted address and outcome move one flow", async () => {
    const f = fixture();
    const { started_at, command_id } = await call(start, f.ctx, { device_id: "host", client: "claude", server: "sentry", cwd: "/w/app" });
    expect(command_id).toBeDefined();
    expect(f.device.mcp_login_flow).toMatchObject({ status: "pending", client: "claude", server: "sentry", started_at });
    await call(reportUrl, f.ctx, { device_id: "host", started_at, url: AUTH_URL });
    expect(f.device.mcp_login_flow.url).toBe(AUTH_URL);
    await call(submitCallback, f.ctx, { device_id: "host", started_at, callback: "http://localhost:1/callback?code=abc" });
    expect(f.tables.daemon_commands.map((c) => [c.command, c.target_device_id, JSON.parse(c.args)])).toEqual([
      ["mcp_login", "host", { started_at, client: "claude", server: "sentry", cwd: "/w/app" }],
      ["mcp_login", "host", { started_at, callback: "http://localhost:1/callback?code=abc" }],
    ]);
    await call(reportNotice, f.ctx, { device_id: "host", started_at, notice: "That doesn't look like a redirect URL" });
    expect(f.device.mcp_login_flow).toMatchObject({ status: "pending", notice: "That doesn't look like a redirect URL" });
    await call(complete, f.ctx, { device_id: "host", started_at, status: "confirmed" });
    expect(f.device.mcp_login_flow).toMatchObject({ status: "confirmed", server: "sentry" });
  });

  test("a pasted address that is not the loopback callback never reaches the machine", async () => {
    const f = fixture();
    const { started_at } = await call(start, f.ctx, { device_id: "host", client: "codex", server: "sentry" });
    await expect(call(submitCallback, f.ctx, { device_id: "host", started_at, callback: "https://evil.example/?code=1" })).rejects.toThrow("localhost");
    expect(f.tables.daemon_commands).toHaveLength(1);
  });

  test("writes naming a replaced or cancelled flow change nothing", async () => {
    const f = fixture();
    const first = await call(start, f.ctx, { device_id: "host", client: "claude", server: "sentry" });
    await call(cancel, f.ctx, { device_id: "host", started_at: first.started_at });
    expect(f.device.mcp_login_flow).toMatchObject({ status: "rejected", reason: "Cancelled" });
    expect(JSON.parse(f.tables.daemon_commands[1].args)).toEqual({ started_at: first.started_at, cancel: true });
    await call(complete, f.ctx, { device_id: "host", started_at: first.started_at, status: "confirmed" });
    expect(f.device.mcp_login_flow.status).toBe("rejected");
    await expect(call(submitCallback, f.ctx, { device_id: "host", started_at: first.started_at, callback: "http://localhost:1/c?code=a" })).rejects.toThrow("ended");
  });

  test("refuses another user's machine and a server name that is not one", async () => {
    await expect(call(start, fixture("users_other").ctx, { device_id: "host", client: "claude", server: "sentry" })).rejects.toThrow("not yours");
    await expect(call(start, fixture().ctx, { device_id: "host", client: "claude", server: "a b; rm" })).rejects.toThrow("name");
  });
});
