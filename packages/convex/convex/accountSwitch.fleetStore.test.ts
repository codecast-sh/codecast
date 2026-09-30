import { describe, expect, test } from "bun:test";
import { insertSwitchCommands } from "./accountSwitch";
import { makeFakeDb } from "./testDb";
import {
  activeTokenProfile,
  continueNeedsRestart,
  decideSwitchAhead,
  fleetAccount,
  parkedOnActiveAccount,
  resumePinFor,
  AUTO_SWITCH_ATTEMPT_EVIDENCE_MS,
  SWITCH_AHEAD_COOLDOWN_MS,
} from "./ccAccountsShared";

// A machine whose sessions run on the fleet store (cli/ccAccounts.ts): the
// store carries launch_profile and every running session follows a switch.
const now = 10_000_000;
const usage = (session: number, weekly = 10, fetched_at = now - 1000) => ({
  fetched_at,
  session: { percent: session, resets_at: now + 3_600_000 },
  weekly: { percent: weekly, resets_at: now + 86_400_000 },
});
const accounts = {
  active_email: "keychain@x.com",
  launch_profile: "fleet",
  fleet_store: true,
  active_since: now - 3_600_000,
  profiles: [
    { name: "keychain", email: "keychain@x.com", usage: usage(5) },
    { name: "fleet", email: "fleet@x.com", usage: usage(96) },
    { name: "roomy", email: "roomy@x.com", usage: usage(20), setup_token: { stored_at: 1, expires_at: now + 1e10 } },
    { name: "tight", email: "tight@x.com", usage: usage(94) },
  ],
};
const device = { device_id: "mac", cc_accounts: accounts } as any;

describe("fleet store: the store is the account, nothing is pinned", () => {
  test("the fleet account is the store's profile and needs no restart", () => {
    expect(fleetAccount(accounts, now)).toEqual({ email: "fleet@x.com", profile: "fleet", viaToken: false });
    expect(activeTokenProfile(accounts, now)).toBeUndefined();
  });

  test("an unpinned park is the fleet's own and a continue reaches it; an old pin restarts onto the store", () => {
    expect(continueNeedsRestart({ pending_api_error_kind: "limit" }, device, now)).toBe(false);
    expect(parkedOnActiveAccount({}, device, now)).toBe(true);
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "roomy" }, device, now)).toBe(true);
    // An automatic pin is dropped at resume, so the session lands on the store.
    expect(resumePinFor({ cc_account: "roomy", cc_account_auto: true }, device, now)).toBeUndefined();
    // A person's --account pin stays.
    expect(resumePinFor({ cc_account: "roomy" }, device, now)).toBe("roomy");
  });
});

describe("decideSwitchAhead", () => {
  const base = { now, fleetEmail: "fleet@x.com", fleetSince: accounts.active_since, profiles: accounts.profiles, attempts: [] };

  test("leaves a near-limit account for the one with the most room", () => {
    expect(decideSwitchAhead(base)).toEqual({ profile: "keychain" });
  });

  test("stays while the fleet account has room", () => {
    const profiles = accounts.profiles.map((p) => (p.name === "fleet" ? { ...p, usage: usage(80) } : p));
    expect(decideSwitchAhead({ ...base, profiles })).toBeNull();
  });

  test("a weekly window near its limit counts too", () => {
    const profiles = accounts.profiles.map((p) => (p.name === "fleet" ? { ...p, usage: usage(10, 98) } : p));
    expect(decideSwitchAhead({ ...base, profiles })?.profile).toBe("keychain");
  });

  test("ignores a reading taken before the fleet last moved", () => {
    const profiles = accounts.profiles.map((p) => (p.name === "fleet" ? { ...p, usage: usage(99, 10, now - 10_000) } : p));
    expect(decideSwitchAhead({ ...base, profiles, fleetSince: now - 5_000 })).toBeNull();
  });

  test("never moves onto another near-limit account or one barely better", () => {
    const profiles = accounts.profiles.filter((p) => p.name === "fleet" || p.name === "tight");
    expect(decideSwitchAhead({ ...base, profiles })).toBeNull();
  });

  test("waits out the cooldown and skips an account tried this window without fresh evidence", () => {
    expect(decideSwitchAhead({ ...base, lastActionAt: now - SWITCH_AHEAD_COOLDOWN_MS + 1000 })).toBeNull();
    const attempts = [{ profile: "keychain", at: now - AUTO_SWITCH_ATTEMPT_EVIDENCE_MS / 2 }];
    expect(decideSwitchAhead({ ...base, attempts })).toEqual({ profile: "roomy" });
  });
});

describe("a switch on the fleet store restarts only what the store cannot move", () => {
  test("followers get a continue after the swap, an old pin restarts without a new pin", async () => {
    const userId = "user_1" as any;
    const dev = { _id: "device_1", user_id: userId, device_id: "mac", label: "Mac", last_seen: now, cc_accounts: accounts } as any;
    const follower = { _id: "c_follow", session_id: "s1", owner_device_id: "mac", pending_api_error_kind: "limit" } as any;
    const pinned = { _id: "c_pinned", session_id: "s2", owner_device_id: "mac", pending_api_error_kind: "limit", cc_account: "tight", cc_account_auto: true } as any;
    const db = makeFakeDb({ conversations: [follower, pinned], devices: [dev], daemon_commands: [] });
    const result = await insertSwitchCommands({ db }, userId, {
      profile: "roomy",
      blocked: [follower, pinned],
      online: [dev],
      primary: dev,
      continueBlocked: true,
      now,
    });
    expect(result.restarted).toBe(1);
    const args = JSON.parse(db._tables.daemon_commands[0].args);
    expect(args.profile).toBe("roomy");
    expect(args.conversation_ids).toEqual(["c_pinned"]);
    expect(args.follow_ids).toEqual(["c_follow"]);
    expect(db._tables.conversations.find((c: any) => c._id === "c_pinned").cc_account).toBeUndefined();
  });
});
