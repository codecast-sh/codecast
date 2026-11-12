import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";
import { ensurePersonalShares, listPool, performSetAccountDevices, performSetAccountShares, poolForDevice, poolUsageOverlay, storePoolCopies, poolProfileName, SEALER_STALE_MS } from "./accountPool";
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
      { _id: "d_line", user_id: ASHOT, device_id: "line-host", is_remote: true, last_seen: NOW, provider_key_pubkey: "pk-line", line_slots: [{ origin: "git@github.com:acme/app.git" }] },
      { _id: "d_jason_line", user_id: JASON, device_id: "jason-line", is_remote: true, last_seen: NOW, provider_key_pubkey: "pk-jline", line_slots: [{ origin: "git@github.com:acme/app.git" }] },
      { _id: "d_stranger_line", user_id: STRANGER, device_id: "stranger-line", is_remote: true, last_seen: NOW, provider_key_pubkey: "pk-sline", line_slots: [{ origin: "git@github.com:acme/app.git" }] },
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
  }, { creationTime: () => NOW, strictPatch: true });
}

type Db = ReturnType<typeof makeFakeDb>;
const as = (db: Db, user: string) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });
const share = (db: Db, teams = [TEAM], email = "claude4@x.com", pools?: Record<string, string[]>) => performSetAccountShares({ db }, ASHOT as any, "ashot-laptop", email, teams, pools);
const targetsOf = async (db: Db) => (await poolFor(db, ASHOT, "ashot-laptop")).seal[0].targets.map((t: any) => t.device_id).sort();
const sealTargets = async (db: Db, shareId: string) =>
  ((await poolFor(db, ASHOT, "ashot-laptop")).seal.find((x: any) => x.share_id === shareId)?.targets ?? []).map((t: any) => t.device_id).sort();
const targetOn = async (db: Db, device: string) => (await poolFor(db, ASHOT, "ashot-laptop")).seal[0].targets.find((t: any) => t.device_id === device);
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
    // Each teammate laptop. Not the holder, not a teammate's host without the
    // line label, not a machine with no key, not one unseen for months, not a
    // stranger's. With no personal row yet, the owner's other machines draw
    // through this row too (a share from before the personal pool).
    expect(await targetsOf(db)).toEqual(["ashot-host", "jason-laptop"]);
    expect(await targetOn(db, "jason-laptop")).toMatchObject({ pubkey: "pk-jason", token_stored_at: null });
  });

  test("a line-pool share also seals to the team's line hosts, and to no other host", async () => {
    const db = fixture();
    await share(db, [TEAM], "claude4@x.com", { [TEAM]: ["line"] });
    expect(db._tables.account_shares[0].pools).toEqual(["line"]);
    // As before, plus every teammate's host that runs line work. Not a
    // teammate's host without line_slots, not a stranger's line host.
    expect(await targetsOf(db)).toEqual(["ashot-host", "jason-laptop", "jason-line", "line-host"]);
    const shareId = db._tables.account_shares[0]._id;
    expect((await store(db, shareId, ["line-host", "jason-line", "stranger-line"])).stored).toBe(2);
    expect((await poolFor(db, ASHOT, "line-host")).copies).toMatchObject([{ share_id: shareId, name: "pool-claude4" }]);
    expect((await (listPool as any)._handler(as(db, ASHOT), {}))[0].pools).toEqual(["line"]);
  });

  test("a teammate's host loses its copy when the label comes off or it stops running line work", async () => {
    const db = fixture();
    await share(db, [TEAM], "claude4@x.com", { [TEAM]: ["line"] });
    const shareId = db._tables.account_shares[0]._id;
    await store(db, shareId, ["jason-line", "jason-laptop", "line-host"]);
    db._tables.devices.find((d: any) => d.device_id === "jason-line").line_slots = [];
    expect((await poolFor(db, JASON, "jason-line")).copies).toHaveLength(0);
    // The owner's own host keeps it either way.
    db._tables.devices.find((d: any) => d.device_id === "line-host").line_slots = [];
    expect((await poolFor(db, ASHOT, "line-host")).copies).toHaveLength(1);
    db._tables.devices.find((d: any) => d.device_id === "jason-line").line_slots = [{ origin: "o" }];
    // A share written without labels keeps the ones it has (the web's pill).
    await share(db);
    expect(db._tables.account_shares[0].pools).toEqual(["line"]);
    await share(db, [TEAM], "claude4@x.com", { [TEAM]: [] });
    expect(db._tables.account_shares[0].pools).toBeUndefined();
    expect(db._tables.account_pool_copies.map((c: any) => c.device_id).sort()).toEqual(["jason-laptop", "line-host"]);
    expect((await poolFor(db, JASON, "jason-line")).copies).toHaveLength(0);
    expect(await targetsOf(db)).toEqual(["ashot-host", "jason-laptop", "line-host"]);
  });

  test("an unknown pool label is refused", async () => {
    const db = fixture();
    await expect(share(db, [TEAM], "claude4@x.com", { [TEAM]: ["batch"] })).rejects.toThrow("Unknown pool batch");
  });

  test("a sealed copy reaches only its machine, named as a pool profile, until the share closes", async () => {
    const db = fixture();
    const { } = await share(db);
    const shareId = db._tables.account_shares[0]._id;
    expect((await store(db, shareId, ["jason-laptop", "stranger"])).stored).toBe(1);
    expect((await targetOn(db, "jason-laptop")).token_stored_at).toBe(NOW - DAY);
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
    expect(await targetsOf(db)).toEqual(["ashot-host"]);
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
    expect((await targetOn(db, "jason-laptop")).token_stored_at).toBe(NOW - DAY);
    db._tables.devices.find((d: any) => d.device_id === "jason-laptop").provider_key_pubkey = "pk-jason-new";
    // Sealed to the old key: the holder sees it as missing and reseals.
    expect(await targetOn(db, "jason-laptop")).toMatchObject({ pubkey: "pk-jason-new", token_stored_at: null });
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

describe("the personal pool: every account on every one of the owner's machines", () => {
  const laptop = (db: Db) => db._tables.devices.find((d: any) => d.device_id === "ashot-laptop");
  const beat = (db: Db, device = "ashot-laptop", previous: any = undefined, lastSeen?: number, now = NOW) =>
    ensurePersonalShares({ db }, ASHOT as any, device, db._tables.devices.find((d: any) => d.device_id === device).cc_accounts, previous, lastSeen, now);

  test("an account with a live setup-token joins its owner's pool with no step, sealed to their machines alone", async () => {
    const db = fixture();
    // claude4 has a token; ashot and claude7 have only saved logins, which cannot travel.
    expect(await beat(db)).toEqual(["claude4@x.com"]);
    expect(db._tables.account_shares).toMatchObject([{ email: "claude4@x.com", holder_device_id: "ashot-laptop" }]);
    expect(db._tables.account_shares[0].team_id).toBeUndefined();
    expect(await targetsOf(db)).toEqual(["ashot-host", "line-host"]);
    const shareId = db._tables.account_shares[0]._id;
    expect((await store(db, shareId, ["ashot-host", "jason-laptop"])).stored).toBe(1);
    expect((await poolFor(db, ASHOT, "ashot-host")).copies).toMatchObject([{ share_id: shareId, name: "pool-claude4" }]);
    expect((await poolFor(db, JASON, "jason-laptop")).copies).toHaveLength(0);
    const mine = await (listPool as any)._handler(as(db, ASHOT), {});
    expect(mine).toMatchObject([{ email: "claude4@x.com", team_id: null, share_key: "claude4@x.com|personal", mine: true, machines: 1 }]);
    expect(await (listPool as any)._handler(as(db, JASON), {})).toHaveLength(0);
  });

  test("a heartbeat with the same accounts writes nothing until the hour turns, then restores a lost row", async () => {
    const db = fixture();
    const accounts = laptop(db).cc_accounts;
    const HOUR = 3600_000;
    const at = Math.floor(NOW / HOUR) * HOUR + 10 * 60_000;
    expect(await beat(db, "ashot-laptop", undefined, at - 30_000, at)).toEqual(["claude4@x.com"]);
    db._tables.account_shares = [];
    expect(await beat(db, "ashot-laptop", accounts, at - 30_000, at)).toEqual([]);
    expect(db._tables.account_shares).toHaveLength(0);
    expect(await beat(db, "ashot-laptop", accounts, at - 30_000, at + HOUR)).toEqual(["claude4@x.com"]);
    // An account that has a row gets no second one.
    await beat(db, "ashot-laptop", undefined, undefined, at + 2 * HOUR);
    expect(db._tables.account_shares).toHaveLength(1);
  });

  test("a host's pool copies never become rows of their own", async () => {
    const db = fixture();
    db._tables.devices.find((d: any) => d.device_id === "ashot-host").cc_accounts = {
      profiles: [{ name: "pool-claude4", email: "claude4@x.com", pool_share_id: "account_shares_1", setup_token: { stored_at: NOW, expires_at: NOW + 300 * DAY } }],
    };
    expect(await beat(db, "ashot-host")).toEqual([]);
    expect(db._tables.account_shares).toHaveLength(0);
  });

  test("team sharing is a separate grant: it reaches teammates and leaves the owner's machines on the personal row", async () => {
    const db = fixture();
    await beat(db);
    const personalId = db._tables.account_shares[0]._id;
    await share(db, [TEAM], "claude4@x.com", { [TEAM]: ["line"] });
    const teamId = db._tables.account_shares.find((r: any) => r.team_id === TEAM)._id;
    expect(await sealTargets(db, personalId)).toEqual(["ashot-host", "line-host"]);
    expect(await sealTargets(db, teamId)).toEqual(["jason-laptop", "jason-line"]);
    expect((await store(db, teamId, ["ashot-host"])).stored).toBe(0);
    // Taking it out of every team leaves the personal row alone.
    await share(db, []);
    expect(db._tables.account_shares.map((r: any) => r._id)).toEqual([personalId]);
  });

  test("an account narrowed to some machines leaves the others; the line pool still reaches the owner's line hosts", async () => {
    const db = fixture();
    await beat(db);
    const personalId = db._tables.account_shares[0]._id;
    await store(db, personalId, ["ashot-host", "line-host"]);
    await expect(performSetAccountDevices({ db }, ASHOT as any, "claude4@x.com", ["jason-laptop"])).rejects.toThrow("Not your machine");
    await expect(performSetAccountDevices({ db }, ASHOT as any, "claude7@x.com", null)).rejects.toThrow("not in your pool");
    await performSetAccountDevices({ db }, ASHOT as any, "Claude4@x.com", ["ashot-host"]);
    expect(db._tables.account_shares[0].device_ids).toEqual(["ashot-host"]);
    expect(await sealTargets(db, personalId)).toEqual(["ashot-host"]);
    expect(db._tables.account_pool_copies.map((c: any) => c.device_id)).toEqual(["ashot-host"]);
    expect((await poolFor(db, ASHOT, "line-host")).copies).toHaveLength(0);
    expect((await (listPool as any)._handler(as(db, ASHOT), {}))[0].device_ids).toEqual(["ashot-host"]);
    // Opting it into the line pool is its own grant: the owner's line host gets it from there.
    await share(db, [TEAM], "claude4@x.com", { [TEAM]: ["line"] });
    const teamId = db._tables.account_shares.find((r: any) => r.team_id === TEAM)._id;
    expect(await sealTargets(db, teamId)).toEqual(["jason-laptop", "jason-line", "line-host"]);
    // Only the machine holding it itself.
    await performSetAccountDevices({ db }, ASHOT as any, "claude4@x.com", []);
    expect(await sealTargets(db, personalId)).toEqual([]);
    // Back to every machine.
    await performSetAccountDevices({ db }, ASHOT as any, "claude4@x.com", null);
    expect(db._tables.account_shares.find((r: any) => r._id === personalId).device_ids).toBeUndefined();
    expect(await sealTargets(db, personalId)).toEqual(["ashot-host", "line-host"]);
  });

  test("a machine on an account shared before the personal pool keeps its copy until the personal one reaches it", async () => {
    const db = fixture();
    await share(db);
    const teamId = db._tables.account_shares[0]._id;
    await store(db, teamId, ["ashot-host"]);
    await beat(db);
    const personalId = db._tables.account_shares.find((r: any) => !r.team_id)._id;
    expect((await poolFor(db, ASHOT, "ashot-host")).copies.map((c: any) => c.share_id)).toEqual([teamId]);
    await store(db, personalId, ["ashot-host"]);
    expect((await poolFor(db, ASHOT, "ashot-host")).copies.map((c: any) => c.share_id)).toEqual([personalId]);
  });

  test("an account is not stranded on one laptop: another of the owner's machines with the token takes over sealing", async () => {
    const db = fixture();
    await beat(db);
    const shareId = db._tables.account_shares[0]._id;
    db._tables.devices.push({
      _id: "d_laptop2", user_id: ASHOT, device_id: "ashot-laptop2", last_seen: NOW, provider_key_pubkey: "pk-2",
      cc_accounts: { profiles: [{ name: "c4", email: "claude4@x.com", setup_token: { stored_at: NOW, expires_at: NOW + 360 * DAY } }] },
    });
    // While the holder is around it seals, and the other laptop (holding the account itself) gets no copy.
    expect((await poolFor(db, ASHOT, "ashot-laptop2")).seal).toHaveLength(0);
    expect(await targetsOf(db)).toEqual(["ashot-host", "line-host"]);
    laptop(db).last_seen = NOW - SEALER_STALE_MS - DAY;
    expect((await poolFor(db, ASHOT, "ashot-laptop2")).seal.map((x: any) => x.share_id)).toEqual([shareId]);
    await expect(store(db, shareId, ["ashot-host"])).rejects.toThrow("Not this machine");
    const took = await (storePoolCopies as any)._handler(as(db, ASHOT), { device_id: "ashot-laptop2", share_id: shareId, token_stored_at: NOW, copies: [{ device_id: "ashot-host", sealed: SEALED }] });
    expect(took.stored).toBe(1);
    expect(db._tables.account_shares[0].holder_device_id).toBe("ashot-laptop2");
  });
});
