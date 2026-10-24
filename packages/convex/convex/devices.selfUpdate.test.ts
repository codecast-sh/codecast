// Settings > Daemon's Update button as desired state on the device row
// (lib/deviceUpdate.ts): the press writes a request, each beat hands it to the
// daemon, the daemon's run lands on the row, and the row clears itself when
// the machine runs the version asked for.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { daemonHeartbeat } from "./users";
import { requestDeviceUpdate } from "./devices";
import { selfUpdateBeatPatch, updateRequestFor } from "./lib/deviceUpdate";

const USER = "users_1" as any;
const TOKEN = "laptop-token";

async function fixture(device: Record<string, unknown> = {}) {
  return makeFakeDb({
    users: [{ _id: USER, cli_version: "1.0.0" }],
    api_tokens: [{ _id: "tok_1", user_id: USER, token_hash: await hashToken(TOKEN), name: "laptop", created_at: 1, last_used_at: 1 }],
    devices: [{ _id: "dev_1", user_id: USER, device_id: "laptop", label: "MacBook", platform: "darwin", last_seen: Date.now(), cli_version: "1.0.0", update_available: "1.1.0", ...device }],
    daemon_commands: [],
    system_config: [],
    team_memberships: [],
  });
}
const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => {} } });
const press = (db: any) => (requestDeviceUpdate as any)._handler(ctx(db), { api_token: TOKEN, device_id: "laptop" });
const beat = (db: any, over: Record<string, unknown> = {}) =>
  (daemonHeartbeat as any)._handler(ctx(db), {
    api_token: TOKEN, version: "1.0.0", platform: "darwin", pid: 1, device_id: "laptop", can_self_update: true, distribution: "installer", ...over,
  });
const row = (db: any) => db._tables.devices[0];

describe("requestDeviceUpdate", () => {
  test("writes the request on the row; a daemon that reads it gets no command", async () => {
    const db = await fixture({ can_self_update: true });
    await press(db);
    expect(row(db)).toMatchObject({ update_state: "requested", update_requested_version: "1.1.0" });
    expect(db._tables.daemon_commands).toHaveLength(0);
  });

  test("an older daemon (no can_self_update reported) also gets force_update", async () => {
    const db = await fixture();
    await press(db);
    expect(db._tables.daemon_commands.map((c: any) => c.command)).toEqual(["force_update"]);
  });

  test("an install that cannot replace its binary is refused with the reason", async () => {
    const db = await fixture({ can_self_update: false, distribution: "source" });
    await expect(press(db)).rejects.toThrow(/runs from source/);
    expect(row(db).update_state).toBeUndefined();
  });
});

describe("the request through heartbeats", () => {
  test("beat carries the request, the run's failure lands on the row, a later press supersedes it, and the matching version clears it", async () => {
    const db = await fixture({ can_self_update: true });
    await press(db);
    const at = row(db).update_requested_at;
    const r1 = await beat(db);
    expect(r1.update_request).toEqual({ version: "1.1.0", at });

    await beat(db, { update_status: { state: "installing", at } });
    expect(row(db).update_state).toBe("installing");
    const r2 = await beat(db, { update_status: { state: "failed", error: "download_curl_22", at } });
    expect(row(db)).toMatchObject({ update_state: "failed", update_error: "download_curl_22" });
    expect(r2.update_request).toBeUndefined();

    // Pressed again: the stale failure the daemon still reports must not win.
    await new Promise((r) => setTimeout(r, 2));
    await press(db);
    await beat(db, { update_status: { state: "failed", error: "download_curl_22", at } });
    expect(row(db).update_state).toBe("requested");

    await beat(db, { version: "1.1.0" });
    expect(row(db).update_state).toBeUndefined();
    expect(row(db).update_requested_at).toBeUndefined();
  });

  test("reports can_self_update and distribution on the row", async () => {
    const db = await fixture();
    await beat(db, { can_self_update: false, distribution: "source" });
    expect(row(db)).toMatchObject({ can_self_update: false, distribution: "source" });
  });
});

describe("selfUpdateBeatPatch", () => {
  test("a daemon whose own check finds nothing newer clears a 'latest' request", () => {
    const patch = selfUpdateBeatPatch({ update_requested_at: 5, update_state: "requested" }, { version: "1.0.0", update_available: "" });
    expect(patch).toMatchObject({ update_state: undefined, update_requested_at: undefined });
    expect("update_state" in patch).toBe(true);
  });

  test("no request: nothing to hand to the daemon", () => {
    expect(updateRequestFor({})).toBeUndefined();
    expect(updateRequestFor({ update_requested_at: 5, update_state: "installing" })).toBeUndefined();
  });
});
