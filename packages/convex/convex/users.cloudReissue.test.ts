import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { daemonHeartbeat } from "./users";

// A row parked while no laptop was online carries "Waiting for <laptop> to
// come online"; the beat that ends that wait is the daemon's REAL heartbeat
// (users.daemonHeartbeat upserts the device row itself — nothing calls
// devices.registerDevice), so the catch-up has to run there.
const USER = "users_1" as any;
const TOKEN = "laptop-token";
const stale = () => Date.now() - DEVICE_ONLINE_MS - 60_000;

async function fixture(opts: { laptopLastSeen: number; laptopRoots?: string[]; extraDevices?: any[] }) {
  return makeFakeDb({
    users: [{ _id: USER, cli_version: "1.0.0" }],
    api_tokens: [{ _id: "tok_1", user_id: USER, token_hash: await hashToken(TOKEN), name: "laptop", created_at: 1, last_used_at: 1 }],
    devices: [
      { _id: "dev_host", user_id: USER, device_id: "host", label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: stale() },
      { _id: "dev_laptop", user_id: USER, device_id: "laptop", label: "macOS - MacBook", platform: "darwin", is_remote: false, last_seen: opts.laptopLastSeen, local_project_roots: opts.laptopRoots ?? ["/Users/me/app"] },
      ...(opts.extraDevices ?? []),
    ],
    conversations: [{ _id: "conv_1", user_id: USER, session_id: "s", project_path: "/Users/me/app", git_root: "/Users/me/app", owner_device_id: "host", cloud_placement: "pending", cloud_placement_token: "tok", session_error: "Waiting for MacBook to come online to prepare the cloud host" }],
    daemon_commands: [],
    system_config: [],
    team_memberships: [],
  });
}

const ctx = (db: any) => ({ db, scheduler: { runAfter: async () => {} } });
const beat = (db: any, over: Record<string, unknown> = {}) => (daemonHeartbeat as any)._handler(ctx(db), {
  api_token: TOKEN, version: "1.0.0", platform: "darwin", pid: 1, device_id: "laptop", device_label: "macOS - MacBook",
  is_remote_device: false, local_project_roots: ["/Users/me/app"], ...over,
});
const spawns = (db: any) => db._tables.daemon_commands.filter((c: any) => c.command === "cloud_spawn");

describe("daemonHeartbeat re-issues stranded cloud_spawns on a local device's offline→online transition", () => {
  test("the transition beat re-issues to this laptop with the row's token and clears the waiting error", async () => {
    const db = await fixture({ laptopLastSeen: stale() });
    const reply = await beat(db);
    expect(reply.error).toBeUndefined();
    expect(spawns(db)).toHaveLength(1);
    expect(spawns(db)[0].target_device_id).toBe("laptop");
    expect(JSON.parse(spawns(db)[0].args)).toEqual({ conversation_id: "conv_1", cloud_device_id: "host", placement_token: "tok" });
    expect((await db.get("conv_1")).session_error).toBeUndefined();
    // (The same beat's reply would carry the command too; the fake db stamps
    // no _creationTime, which the poll's TTL filter reads, so not asserted.)
  });

  test("a per-beat online heartbeat does not scan, and a second transition does not double-issue a live command", async () => {
    const online = await fixture({ laptopLastSeen: Date.now() - 10_000 });
    await beat(online);
    expect(spawns(online)).toHaveLength(0);

    const db = await fixture({ laptopLastSeen: stale() });
    await beat(db);
    await db.patch("dev_laptop", { last_seen: stale() });
    await beat(db);
    expect(spawns(db)).toHaveLength(1);
  });

  test("the host's own beat and a remote box's beat never re-issue", async () => {
    const db = await fixture({ laptopLastSeen: stale() });
    await beat(db, { device_id: "host", device_label: "Linux - ip-1-2-3-4", platform: "linux", is_remote_device: true, local_project_roots: [] });
    expect(spawns(db)).toHaveLength(0);
  });

  test("a park whose `cast cloud start` already failed is left alone until a human re-picks", async () => {
    // Without this the box is woken, and the error the human is reading is
    // cleared, on every laptop that comes back online.
    const db = await fixture({ laptopLastSeen: stale() });
    await db.patch("conv_1", { cloud_placement_failed_at: Date.now() - 60_000, session_error: "cloud host preparation failed (exit 1): no space left on device" });
    await beat(db);
    expect(spawns(db)).toHaveLength(0);
    expect((await db.get("conv_1")).session_error).toContain("no space left on device");
  });

  test("an online laptop holding the checkout is preferred over the one that just came back", async () => {
    const db = await fixture({
      laptopLastSeen: stale(),
      laptopRoots: [],
      extraDevices: [{ _id: "dev_desk", user_id: USER, device_id: "desk", label: "macOS - Desk", platform: "darwin", is_remote: false, last_seen: Date.now() - 5_000, local_project_roots: ["/Users/me/app"] }],
    });
    await beat(db, { local_project_roots: [] });
    expect(spawns(db)).toHaveLength(1);
    expect(spawns(db)[0].target_device_id).toBe("desk");
  });
});
