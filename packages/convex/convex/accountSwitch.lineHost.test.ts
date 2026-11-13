import { describe, expect, test } from "bun:test";
import { autoSwitchCheck, switchAheadCheck } from "./accountSwitch";
import { makeFakeDb } from "./testDb";
import { continueTargetPin, parkedOnActiveAccount, runsOwnFleet, runsPushedLogin } from "./ccAccountsShared";

// A line host drawing on its team's line pool runs its own fleet store. Its
// account must stay visible to recovery and movable by it (the 2026-10-24
// jx75sbx host sat on a spent week because recovery could neither see nor
// move its account), so recovery runs a pass for the host itself, on its
// own accounts, and the laptop's pass leaves the host's parks to it.

const HOUR = 3_600_000;

function fixture(o: { laptop?: Record<string, unknown>; host?: Record<string, unknown> } = {}) {
  const now = Date.now();
  const usage = (pct: number) => ({ fetched_at: now - 1_000, session: { percent: pct, resets_at: now + HOUR }, weekly: { percent: pct, resets_at: now + 24 * HOUR } });
  const laptop = {
    _id: "devices_laptop",
    user_id: "users_owner",
    device_id: "mac",
    last_seen: now,
    cc_auto_switch: false,
    cc_recovery_ask: true,
    cc_accounts: {
      active_email: "own@x.com",
      fleet_store: true,
      launch_profile: "own",
      profiles: [
        { name: "own", email: "own@x.com", usage: usage(100) },
        { name: "a", email: "a@x.com", usage: usage(100), setup_token: { stored_at: now, expires_at: now + 300 * 24 * HOUR } },
        { name: "b", email: "b@x.com", usage: usage(10), setup_token: { stored_at: now, expires_at: now + 300 * 24 * HOUR } },
      ],
    },
    cc_auto_switch_state: {} as any,
    ...o.laptop,
  };
  const host = {
    _id: "devices_host",
    user_id: "users_owner",
    device_id: "line-host",
    is_remote: true,
    last_seen: now,
    line_slots: [{ origin: "git@github.com:acme/app.git" }],
    cc_accounts: {
      fleet_store: true,
      launch_profile: "pool-a",
      profiles: [
        { name: "pool-a", email: "a@x.com", pool_share_id: "account_shares_a", setup_token: { stored_at: now, expires_at: now + 300 * 24 * HOUR } },
        { name: "pool-b", email: "b@x.com", pool_share_id: "account_shares_b", setup_token: { stored_at: now, expires_at: now + 300 * 24 * HOUR } },
      ],
    },
    cc_auto_switch_state: {} as any,
    ...o.host,
  };
  const share = (id: string, email: string) => ({ _id: id, user_id: "users_owner", provider: "claude", email, holder_device_id: "mac", team_id: "teams_acme", pools: ["line"], shared_at: now });
  const parked = {
    _id: "conversations_station",
    user_id: "users_owner",
    session_id: "s-station",
    agent_type: "claude_code",
    owner_device_id: "line-host",
    pending_api_error: true,
    pending_api_error_kind: "limit",
    pending_api_error_at: now - 30_000,
    updated_at: now - 30_000,
  };
  const tables: Record<string, any[]> = {
    users: [{ _id: "users_owner", name: "Owner" }],
    team_memberships: [{ _id: "m1", user_id: "users_owner", team_id: "teams_acme", role: "admin" }],
    account_shares: [share("account_shares_a", "a@x.com"), share("account_shares_b", "b@x.com")],
    notifications: [],
    devices: [laptop, host],
    conversations: [parked],
    daemon_commands: [],
    pending_messages: [],
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const scheduler = {
    async runAt(_at: number, _fn: any, args: any) { scheduled.push(args); },
    async runAfter(_ms: number, _fn: any, args: any) { scheduled.push(args); },
  };
  const run = (deviceId?: string) => (autoSwitchCheck as any)._handler({ db, scheduler }, { user_id: "users_owner", ...(deviceId ? { device_id: deviceId } : {}) });
  const ahead = (deviceId?: string) => (switchAheadCheck as any)._handler({ db, scheduler }, { user_id: "users_owner", ...(deviceId ? { device_id: deviceId } : {}) });
  return { now, laptop, host, tables, scheduled, run, ahead };
}

describe("a line host on its own fleet store", () => {
  test("is a machine of its own to recovery, unlike a host on the pushed login", () => {
    const f = fixture();
    expect(runsOwnFleet(f.host)).toBe(true);
    expect(runsPushedLogin(f.host)).toBe(false);
    const pushed = { is_remote: true, cc_accounts: { profiles: [] } };
    expect(runsOwnFleet(pushed)).toBe(false);
    expect(runsPushedLogin(pushed)).toBe(true);
    // On its fleet store nothing is pinned, and a park is its fleet account's.
    expect(continueTargetPin(f.host as any, f.now)).toBeUndefined();
    expect(parkedOnActiveAccount({ cc_account: null }, f.host as any, f.now)).toBe(true);
  });

  test("a park on a spent pool account moves the host to the pool account with room", async () => {
    const f = fixture();
    const res = await f.run("line-host");
    expect(res).toMatchObject({ acted: "switch", profile: "pool-b" });
    expect(f.tables.daemon_commands).toHaveLength(1);
    const cmd = f.tables.daemon_commands[0];
    expect(cmd.target_device_id).toBe("line-host");
    const args = JSON.parse(cmd.args);
    // The host switches under its own profile name; the station follows the
    // store and gets its continue, with no restart.
    expect(args.profile).toBe("pool-b");
    expect(args.follow_ids).toEqual(["conversations_station"]);
    expect(args.conversation_ids).toEqual([]);
    // The host's bookkeeping lives on the host, not on the laptop.
    expect(f.host.cc_auto_switch_state.last_action).toBe("switch:pool-b");
    expect(f.laptop.cc_auto_switch_state.last_action).toBeUndefined();
  });

  test("the person's pass leaves the host's parks to the host's own pass", async () => {
    const f = fixture();
    const res = await f.run();
    expect(res.acted).toBe("nothing_blocked");
    expect(f.tables.daemon_commands).toHaveLength(0);
    expect(f.scheduled).toContainEqual({ user_id: "users_owner", device_id: "line-host" });
  });

  test("runs while the laptop sleeps, and not at all when the person turned recovery off", async () => {
    const asleep = fixture({ laptop: { last_seen: Date.now() - 24 * HOUR } });
    expect(await asleep.run("line-host")).toMatchObject({ acted: "switch", profile: "pool-b" });
    const off = fixture({ laptop: { cc_recovery_ask: false, cc_auto_switch: false } });
    expect(await off.run("line-host")).toEqual({ acted: "off" });
    expect(off.tables.daemon_commands).toHaveLength(0);
  });

  test("a host on the pushed login gets no pass of its own; its parks stay the laptop's", async () => {
    const f = fixture({ host: { cc_accounts: { profiles: [] } } });
    expect(await f.run("line-host")).toEqual({ acted: "off" });
    await f.run();
    expect(f.scheduled.some((a) => a.device_id)).toBe(false);
  });

  test("ranking skips an account Cloudflare refuses from the line hosts, and can still leave it", async () => {
    const cam = "r.cameron.musgrave@gmail.com";
    const meter = (pct: number) => ({ fetched_at: Date.now() - 1_000, session: { percent: pct, resets_at: Date.now() + HOUR }, weekly: { percent: pct, resets_at: Date.now() + 24 * HOUR } });
    const withCam = (camPercent: number) => {
      const f = fixture();
      f.tables.account_shares.push({ _id: "account_shares_cam", user_id: "users_owner", provider: "claude", email: cam, holder_device_id: "mac", team_id: "teams_acme", pools: ["line"], shared_at: f.now });
      f.host.cc_accounts.profiles.push({ name: "pool-cam", email: cam, pool_share_id: "account_shares_cam", usage: meter(camPercent), setup_token: { stored_at: f.now, expires_at: f.now + 300 * 24 * HOUR } });
      f.laptop.cc_accounts.profiles.push({ name: "cam", email: cam, usage: meter(camPercent), setup_token: { stored_at: f.now, expires_at: f.now + 300 * 24 * HOUR } });
      f.laptop.cc_accounts.profiles[1].usage = meter(100);
      f.laptop.cc_accounts.profiles[2].usage = meter(40);
      return f;
    };
    // Cam's meter is the best headroom on the host. The host still moves to the next account.
    const parked = withCam(1);
    expect(await parked.run("line-host")).toMatchObject({ acted: "switch", profile: "pool-b" });
    const ahead = withCam(1);
    ahead.laptop.cc_accounts.profiles[1].usage = meter(97);
    expect(await ahead.ahead("line-host")).toMatchObject({ acted: "switch", profile: "pool-b" });
    // Already on it, and near a limit: the host leaves. The refusal only blocks arriving.
    const leaving = withCam(97);
    leaving.host.cc_accounts.launch_profile = "pool-cam";
    expect(await leaving.ahead("line-host")).toMatchObject({ acted: "switch", profile: "pool-b" });
  });

  test("switches ahead on the host's own meters, read from each account's holder", async () => {
    const f = fixture({ host: { cc_accounts: { fleet_store: true, launch_profile: "pool-a", profiles: [
      { name: "pool-a", email: "a@x.com", pool_share_id: "account_shares_a" },
      { name: "pool-b", email: "b@x.com", pool_share_id: "account_shares_b" },
    ] } } });
    f.laptop.cc_accounts.profiles[1].usage = { fetched_at: f.now - 1_000, session: { percent: 97, resets_at: f.now + HOUR }, weekly: { percent: 50, resets_at: f.now + 24 * HOUR } };
    expect(await f.ahead("line-host")).toMatchObject({ acted: "switch", profile: "pool-b" });
    expect(f.tables.daemon_commands[0].target_device_id).toBe("line-host");
  });
});
