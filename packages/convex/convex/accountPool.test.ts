import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";
import { listPool, performSetAccountShares, poolForDevice, poolUsageOverlay, storePoolCopies, poolProfileName } from "./accountPool";
import { fallbackProfiles } from "./ccAccountsShared";
import { rollUpUsage } from "./messages";
import { fold } from "./usageDays";

// The pool reuses device sharing's rules (sessionLaunch.test.ts): a share is a
// whole-set write by its owner, counts only while both people are on the team,
// and closing it is immediate.

const ASHOT = "users_ashot";
const JASON = "users_jason";
const STRANGER = "users_stranger";
const TEAM = "teams_ours";
const NOW = Date.now();
const DAY = 24 * 3600_000;
const SEALED = { provider: "claude-pool", epk: "e", iv: "i", ct: "c" };

const usage = (pct: number) => ({ fetched_at: NOW, session: { percent: pct, resets_at: NOW + 3600_000 }, weekly: { percent: pct, resets_at: NOW + 3 * DAY } });

function fixture() {
  return makeFakeDb({
    users: [{ _id: ASHOT, name: "Ashot" }, { _id: JASON, name: "Jason" }, { _id: STRANGER, name: "Stranger" }],
    team_memberships: [
      { _id: "m1", user_id: ASHOT, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: JASON, team_id: TEAM, role: "member" },
    ],
    devices: [
      {
        _id: "d_laptop", user_id: ASHOT, device_id: "ashot-laptop", last_seen: NOW, provider_key_pubkey: "pk-ashot",
        cc_accounts: {
          active_email: "ashot@x.com",
          profiles: [
            { name: "ashot", email: "ashot@x.com", usage: usage(40) },
            { name: "claude4", email: "Claude4@x.com", tier: "max_20x", usage: usage(12), setup_token: { stored_at: NOW - DAY, expires_at: NOW + 300 * DAY } },
            { name: "claude7", email: "claude7@x.com", usage: usage(5) },
          ],
        },
      },
      { _id: "d_host", user_id: ASHOT, device_id: "ashot-host", is_remote: true, last_seen: NOW, provider_key_pubkey: "pk-host" },
      {
        _id: "d_jason", user_id: JASON, device_id: "jason-laptop", last_seen: NOW, provider_key_pubkey: "pk-jason",
        cc_accounts: { active_email: "jason@x.com", profiles: [{ name: "jason", email: "jason@x.com", usage: usage(100) }] },
      },
      { _id: "d_jason_old", user_id: JASON, device_id: "jason-old", last_seen: NOW - 90 * DAY, provider_key_pubkey: "pk-old" },
      { _id: "d_jason_nokey", user_id: JASON, device_id: "jason-nokey", last_seen: NOW },
      { _id: "d_stranger", user_id: STRANGER, device_id: "stranger", last_seen: NOW, provider_key_pubkey: "pk-s" },
    ],
    account_shares: [],
    account_pool_copies: [],
    account_usage_daily: [],
    usage_pending: [],
    user_usage_daily: [],
    conversations: [],
    daemon_commands: [],
  });
}

type Db = ReturnType<typeof makeFakeDb>;
const as = (db: Db, user: string) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
const share = (db: Db, teams = [TEAM], email = "claude4@x.com") => performSetAccountShares({ db }, ASHOT as any, "ashot-laptop", email, teams);
const poolFor = (db: Db, user: string, device: string) => (poolForDevice as any)._handler(as(db, user), { device_id: device });
const store = (db: Db, shareId: string, devices: string[]) =>
  (storePoolCopies as any)._handler(as(db, ASHOT), { device_id: "ashot-laptop", share_id: shareId, token_stored_at: NOW - DAY, copies: devices.map((device_id) => ({ device_id, sealed: SEALED })) });

describe("sharing an account into the team's pool", () => {
  test("only a saved account with a live setup-token, only with a team you are on, and the write is idempotent", async () => {
    const db = fixture();
    await expect(share(db, [TEAM], "claude7@x.com")).rejects.toThrow("no live setup-token");
    await expect(share(db, [TEAM], "nobody@x.com")).rejects.toThrow("not a saved account");
    await expect(share(db, ["teams_other"])).rejects.toThrow("team you are on");
    await expect(performSetAccountShares({ db }, JASON as any, "ashot-laptop", "claude4@x.com", [TEAM])).rejects.toThrow("Unknown device");
    await share(db);
    await share(db);
    expect(db._tables.account_shares).toMatchObject([{ user_id: ASHOT, email: "claude4@x.com", holder_device_id: "ashot-laptop", team_id: TEAM }]);
  });

  test("the web writes it through dispatch like a device share", async () => {
    const db = fixture();
    await (dispatch as any)._handler(as(db, ASHOT), { action: "setAccountShares", args: ["ashot-laptop", "claude4@x.com", [TEAM]] });
    expect(db._tables.account_shares).toHaveLength(1);
  });

  test("the holder seals for each teammate machine that can receive a secret, and nothing else", async () => {
    const db = fixture();
    await share(db);
    const pool = await poolFor(db, ASHOT, "ashot-laptop");
    expect(pool.seal).toHaveLength(1);
    // Not the holder, not a cloud host (it runs its laptop's fleet store), not a
    // machine with no key, not one unseen for months, not a stranger's.
    expect(pool.seal[0].targets.map((t: any) => t.device_id)).toEqual(["jason-laptop"]);
    expect(pool.seal[0].targets[0]).toMatchObject({ pubkey: "pk-jason", token_stored_at: null });
  });

  test("a sealed copy reaches only its machine, named as a pool profile, until the share closes", async () => {
    const db = fixture();
    const { } = await share(db);
    const shareId = db._tables.account_shares[0]._id;
    expect((await store(db, shareId, ["jason-laptop", "stranger"])).stored).toBe(1);
    expect((await poolFor(db, ASHOT, "ashot-laptop")).seal[0].targets[0].token_stored_at).toBe(NOW - DAY);
    const jason = await poolFor(db, JASON, "jason-laptop");
    expect(jason.copies).toMatchObject([{ share_id: shareId, email: "claude4@x.com", name: "pool-claude4", contributor_name: "Ashot", tier: "max_20x", sealed: SEALED }]);
    expect((await poolFor(db, STRANGER, "stranger")).copies).toHaveLength(0);
    await share(db, []);
    expect(db._tables.account_shares).toHaveLength(0);
    expect(db._tables.account_pool_copies).toHaveLength(0);
    expect((await poolFor(db, JASON, "jason-laptop")).copies).toHaveLength(0);
  });

  test("leaving the team takes your accounts out, and takes the pool off your machines", async () => {
    const db = fixture();
    await share(db);
    await store(db, db._tables.account_shares[0]._id, ["jason-laptop"]);
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== JASON);
    expect((await poolFor(db, JASON, "jason-laptop")).copies).toHaveLength(0);
    db._tables.team_memberships.push({ _id: "m3", user_id: JASON, team_id: TEAM, role: "member" });
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== ASHOT);
    expect((await poolFor(db, JASON, "jason-laptop")).copies).toHaveLength(0);
    expect((await poolFor(db, ASHOT, "ashot-laptop")).seal).toHaveLength(0);
  });

  test("only the holder stores copies", async () => {
    const db = fixture();
    await share(db);
    const shareId = db._tables.account_shares[0]._id;
    await expect((storePoolCopies as any)._handler(as(db, JASON), { device_id: "jason-laptop", share_id: shareId, token_stored_at: NOW, copies: [] })).rejects.toThrow("Not this machine");
  });

  test("a pool copy carries the holder's meter, so auto-switch ranks own and pool accounts as one list", async () => {
    const db = fixture();
    await share(db);
    const shareId = db._tables.account_shares[0]._id;
    const jasonProfiles = [
      { name: "jason", email: "jason@x.com", usage: usage(100) },
      { name: "pool-claude4", email: "claude4@x.com", pool_share_id: shareId, setup_token: { stored_at: NOW, expires_at: NOW + 300 * DAY } },
      { name: "pool-gone", email: "gone@x.com", pool_share_id: "account_shares_gone" },
    ];
    const overlaid = await poolUsageOverlay({ db }, JASON as any, jasonProfiles);
    expect(overlaid.map((p) => p.name)).toEqual(["jason", "pool-claude4"]);
    expect(overlaid[1].usage?.session?.percent).toBe(12);
    expect(fallbackProfiles(overlaid, "jason@x.com", NOW).map((p) => p.name)).toEqual(["pool-claude4"]);
    await share(db, []);
    expect(await poolUsageOverlay({ db }, JASON as any, jasonProfiles)).toHaveLength(1);
  });

  test("tokens are stamped with the account the machine ran on, and every member sees who spent each pool account", async () => {
    const db = fixture();
    await share(db);
    const jasonLaptop = db._tables.devices.find((d: any) => d.device_id === "jason-laptop");
    jasonLaptop.cc_accounts = { ...jasonLaptop.cc_accounts, launch_profile: "pool-claude4", fleet_store: true, profiles: [...jasonLaptop.cc_accounts.profiles, { name: "pool-claude4", email: "claude4@x.com", pool_share_id: db._tables.account_shares[0]._id }] };
    const conv = { _id: "conversations_j", user_id: JASON, owner_device_id: "jason-laptop", _creationTime: NOW - DAY };
    db._tables.conversations.push(conv);
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { async runAfter(_d: number, _f: any, args: any) { scheduled.push(args); } } };
    const turn = { usage: { input_tokens: 100, output_tokens: 900 }, api_message_id: "m1", inserted: true, model: "claude-opus-5-5", timestamp: NOW - 60_000 };
    await rollUpUsage(ctx, conv, [turn], {}, NOW);
    expect(db._tables.usage_pending).toMatchObject([{ conversation_id: "conversations_j", account: "claude4@x.com" }]);
    // The machine moves back to its own account mid-session: the next turns are its.
    jasonLaptop.cc_accounts = { ...jasonLaptop.cc_accounts, launch_profile: undefined, fleet_store: undefined };
    await rollUpUsage(ctx, conv, [{ ...turn, api_message_id: "m2" }], {}, NOW);
    expect(db._tables.usage_pending.map((p: any) => p.account).sort()).toEqual(["claude4@x.com", "jason@x.com"]);
    await (fold as any)._handler({ db }, scheduled[0]);
    expect(db._tables.account_usage_daily).toMatchObject(expect.arrayContaining([
      expect.objectContaining({ email: "claude4@x.com", user_id: JASON, tokens: 1000 }),
      expect.objectContaining({ email: "jason@x.com", user_id: JASON, tokens: 1000 }),
    ]));
    db._tables.account_usage_daily.push({ _id: "aud_s", email: "claude4@x.com", user_id: STRANGER, day_start: db._tables.account_usage_daily[0].day_start, tokens: 5, updated_at: NOW });
    const rows = await (listPool as any)._handler(as(db, JASON), {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "claude4@x.com", contributor_name: "Ashot", mine: false, profile_name: "claude4", usage: { session: { percent: 12 } } });
    // Only team members appear in the split.
    expect(rows[0].split).toEqual([{ user_id: JASON, name: "Jason", tokens: 1000 }]);
  });

  test("a machine that regenerates its key gets a fresh copy", async () => {
    const db = fixture();
    await share(db);
    await store(db, db._tables.account_shares[0]._id, ["jason-laptop"]);
    expect((await poolFor(db, ASHOT, "ashot-laptop")).seal[0].targets[0].token_stored_at).toBe(NOW - DAY);
    db._tables.devices.find((d: any) => d.device_id === "jason-laptop").provider_key_pubkey = "pk-jason-new";
    // Sealed to the old key: the holder sees it as missing and reseals.
    expect((await poolFor(db, ASHOT, "ashot-laptop")).seal[0].targets[0]).toMatchObject({ pubkey: "pk-jason-new", token_stored_at: null });
  });

  test("a Codex session's tokens are never counted against a Claude account", async () => {
    const db = fixture();
    const jasonLaptop = db._tables.devices.find((d: any) => d.device_id === "jason-laptop");
    jasonLaptop.codex_accounts = { active_email: "claude4@x.com", profiles: [] };
    const conv = { _id: "conversations_c", user_id: JASON, owner_device_id: "jason-laptop", agent_type: "codex", _creationTime: NOW - DAY };
    db._tables.conversations.push(conv);
    const ctx = { db, scheduler: { async runAfter() {} } };
    await rollUpUsage(ctx, conv, [{ usage: { input_tokens: 10, output_tokens: 10 }, api_message_id: "c1", inserted: true, model: "gpt-5", timestamp: NOW - 60_000 }], {}, NOW);
    expect(db._tables.usage_pending[0].account).toBeUndefined();
  });

  test("the web's optimistic stub and the server row share one key", async () => {
    const db = fixture();
    await share(db);
    const rows = await (listPool as any)._handler(as(db, ASHOT), {});
    expect(rows[0].share_key).toBe(`claude4@x.com|${TEAM}`);
  });

  test("pool profile names stay valid profile names", () => {
    expect(poolProfileName("Claude4+test@almostcandid.com")).toBe("pool-claude4test");
    expect(poolProfileName("@x.com")).toBe("pool-account");
    expect(poolProfileName(`${"a".repeat(60)}@x.com`).length).toBeLessThanOrEqual(41);
  });
});
