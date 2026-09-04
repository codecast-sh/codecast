import { describe, expect, test } from "bun:test";
import { insertSwitchCommands } from "./accountSwitch";
import { makeFakeDb } from "./testDb";
import {
  isBlockedConversation,
  isRemoteAuthBlocked,
  isSubagentConversation,
  actedBlockedConversations,
  isDeviceOnline,
  isValidProfileName,
  shouldSweepStaleFlag,
  decideAutoSwitch,
  splitAuthParks,
  AUTO_SWITCH_AUTH_RESTART_KEY,
  resolveDeviceProfile,
  targetAccountEmail,
  continueTargetPin,
  continueNeedsRestart,
  parkedOnActiveAccount,
  resumePinFor,
  isExhaustionCurrent,
  isUsageExhausted,
  fallbackProfiles,
  isWindowRolled,
  worstUsagePercent,
  AUTO_SWITCH_ATTEMPT_EVIDENCE_MS,
  AUTO_SWITCH_CONTINUE_KEY,
  AUTO_SWITCH_PROBE_GRACE_MS,
  AUTO_SWITCH_PROBE_RETRY_MS,
  AUTO_SWITCH_SESSION_WINDOW_MS,
  DEVICE_ONLINE_MS,
  STALE_FLAG_AFTER_MS,
  type CcUsage,
  pickThrottleContinueBatch,
  THROTTLE_CONTINUE_DELAY_MS,
  THROTTLE_CONTINUE_BATCH,
} from "./ccAccountsShared";

describe("isBlockedConversation", () => {
  const base = { pending_api_error: true, pending_api_error_kind: "limit", agent_type: "claude_code" };

  test("selects claude conversations parked on a limit, auth, or connection banner", () => {
    expect(isBlockedConversation(base)).toBe(true);
    expect(isBlockedConversation({ ...base, pending_api_error_kind: "auth" })).toBe(true);
    // A dropped connection ("Connection closed mid-response") parks the turn
    // at the prompt — a plain continue resumes it, same as limit.
    expect(isBlockedConversation({ ...base, pending_api_error_kind: "connection" })).toBe(true);
  });

  test("never revives what the user dismissed", () => {
    expect(isBlockedConversation({ ...base, inbox_dismissed_at: 123 })).toBe(false);
  });

  test("transient provider errors are not blocked sessions", () => {
    // A statusful 529/500 banner (kind "error") self-retries — counting it
    // threw a mid-conversation 500 into the "blocked on usage limits" banner.
    expect(isBlockedConversation({ ...base, pending_api_error_kind: "error" })).toBe(false);
    // Pre-kind rows (flag without a kind) are also out: unknown ≠ revivable.
    expect(isBlockedConversation({ ...base, pending_api_error_kind: undefined })).toBe(false);
  });

  test("ignores healthy conversations and other agents", () => {
    expect(isBlockedConversation({ ...base, pending_api_error: false })).toBe(false);
    expect(isBlockedConversation({ agent_type: "claude_code" })).toBe(false);
    // The account swap only affects claude's credential — codex/cursor banners
    // are someone else's login problem.
    expect(isBlockedConversation({ ...base, agent_type: "codex" })).toBe(false);
  });
});

describe("isRemoteAuthBlocked", () => {
  const remotes = new Set(["mac-1"]);

  test("selects auth-parked conversations owned by a remote device", () => {
    expect(isRemoteAuthBlocked({ pending_api_error_kind: "auth", owner_device_id: "mac-1" }, remotes)).toBe(true);
  });

  test("limit-kind, local owners, and unowned conversations are out of scope", () => {
    // Limit banners aren't fixed by a credential push — the account is fine.
    expect(isRemoteAuthBlocked({ pending_api_error_kind: "limit", owner_device_id: "mac-1" }, remotes)).toBe(false);
    // A local owner can /login itself; the push changes nothing for it.
    expect(isRemoteAuthBlocked({ pending_api_error_kind: "auth", owner_device_id: "laptop-1" }, remotes)).toBe(false);
    expect(isRemoteAuthBlocked({ pending_api_error_kind: "auth" }, remotes)).toBe(false);
    expect(isRemoteAuthBlocked({ pending_api_error_kind: "auth", owner_device_id: "mac-1" }, new Set())).toBe(false);
  });
});

describe("isDeviceOnline", () => {
  test("live within the heartbeat window, dead past it", () => {
    const now = 1_000_000_000;
    expect(isDeviceOnline({ last_seen: now - 30_000 }, now)).toBe(true);
    expect(isDeviceOnline({ last_seen: now - DEVICE_ONLINE_MS - 1 }, now)).toBe(false);
  });
});

describe("isValidProfileName", () => {
  test("mirrors the CLI rules", () => {
    expect(isValidProfileName("footage")).toBe(true);
    expect(isValidProfileName("work-2.bak_1")).toBe(true);
    for (const bad of ["", "-lead", "has space", "a/b", "a;b", "x".repeat(50)]) {
      expect(isValidProfileName(bad)).toBe(false);
    }
  });
});

describe("isSubagentConversation", () => {
  test("flags explicit subagents and parent-linked workers", () => {
    expect(isSubagentConversation({ is_subagent: true })).toBe(true);
    expect(isSubagentConversation({ parent_conversation_id: "jx7parent" })).toBe(true);
  });

  test("a plain top-level conversation is not a subagent", () => {
    expect(isSubagentConversation({})).toBe(false);
    expect(isSubagentConversation({ is_subagent: false, parent_conversation_id: undefined })).toBe(false);
  });
});

describe("shouldSweepStaleFlag", () => {
  const now = 1_000_000_000_000;

  test("sweeps flagged conversations older than the revive window", () => {
    expect(
      shouldSweepStaleFlag({ pending_api_error: true, updated_at: now - STALE_FLAG_AFTER_MS - 1 }, now),
    ).toBe(true);
  });

  test("leaves fresh incidents and unflagged conversations alone", () => {
    // Inside the window = still the current incident; the banner should act on it.
    expect(
      shouldSweepStaleFlag({ pending_api_error: true, updated_at: now - STALE_FLAG_AFTER_MS + 60_000 }, now),
    ).toBe(false);
    expect(shouldSweepStaleFlag({ pending_api_error: false, updated_at: 0 }, now)).toBe(false);
  });
});

describe("usage predicates", () => {
  const now = 1_000_000;
  const usage = (session: number, weekly: number, scoped?: number): CcUsage => ({
    fetched_at: now - 60_000,
    session: { percent: session, resets_at: now + 3600_000 },
    weekly: { percent: weekly, resets_at: now + 86_400_000 },
    ...(scoped != null ? { weekly_scoped: { percent: scoped, resets_at: now + 86_400_000, label: "Fable" } } : {}),
  });

  test("worstUsagePercent takes the max across windows, null without data", () => {
    expect(worstUsagePercent(usage(28, 27, 42), now)).toBe(42);
    expect(worstUsagePercent(usage(90, 10), now)).toBe(90);
    expect(worstUsagePercent(undefined, now)).toBeNull();
    expect(worstUsagePercent({ fetched_at: 1 }, now)).toBeNull();
  });

  test("worstUsagePercent reads a rolled window as 0, not as its old percent", () => {
    // A 17h-old snapshot of a 5h session window: the window it measured ended
    // long ago, so the meter must clear instead of staying pegged.
    const stale: CcUsage = {
      fetched_at: now - 17 * 3600_000,
      session: { percent: 100, resets_at: now - 12 * 3600_000 },
      weekly: { percent: 21, resets_at: now + 86_400_000 },
    };
    expect(worstUsagePercent(stale, now)).toBe(21);
    // Every window rolled — the account reads empty, not "no data".
    expect(worstUsagePercent({ fetched_at: 1, session: { percent: 100, resets_at: now - 1 } }, now)).toBe(0);
    // A window with no known reset time can't be proven rolled.
    expect(worstUsagePercent({ fetched_at: 1, session: { percent: 100 } }, now)).toBe(100);
  });

  test("isExhaustionCurrent expires a stamp the windows have outlived", () => {
    const pegged = [{ usage: usage(100, 30) }];
    const rolled = [{ usage: { fetched_at: 1, session: { percent: 100, resets_at: now - 1 } } }];
    // Fresh stamp stands alone — a single-account machine can be spent with no
    // snapshot to prove it.
    expect(isExhaustionCurrent(now - 60_000, [{}], now)).toBe(true);
    // Old stamp, some account still pegged with a reset ahead — still true.
    expect(isExhaustionCurrent(now - 20 * 3600_000, pegged, now)).toBe(true);
    // Old stamp, every pegged window has rolled — the claim expired.
    expect(isExhaustionCurrent(now - 20 * 3600_000, rolled, now)).toBe(false);
    expect(isExhaustionCurrent(undefined, pegged, now)).toBe(false);
  });

  test("isWindowRolled needs a reset time that has actually passed", () => {
    expect(isWindowRolled({ resets_at: now - 1 }, now)).toBe(true);
    expect(isWindowRolled({ resets_at: now + 1 }, now)).toBe(false);
    expect(isWindowRolled({}, now)).toBe(false);
    expect(isWindowRolled(undefined, now)).toBe(false);
  });

  test("isUsageExhausted requires a pegged window whose reset is still ahead", () => {
    expect(isUsageExhausted(usage(100, 20), now)).toBe(true);
    expect(isUsageExhausted(usage(99, 20), now)).toBe(false);
    expect(isUsageExhausted(undefined, now)).toBe(false);
    // Pegged but the reset already passed — the snapshot is stale, the window rolled.
    const rolled: CcUsage = { fetched_at: 1, session: { percent: 100, resets_at: now - 1 } };
    expect(isUsageExhausted(rolled, now)).toBe(false);
    // Pegged with no reset time known — treat as exhausted (can't prove it rolled).
    const noReset: CcUsage = { fetched_at: 1, weekly: { percent: 100 } };
    expect(isUsageExhausted(noReset, now)).toBe(true);
  });

  // 2026-09-03: ashot@union sat at session 100% with usage credits on — Claude
  // Code kept working on credits ("Now using usage credits") while the loop
  // counted the account as spent.
  test("isUsageExhausted: usage credits cover a pegged window until the credit budget is spent", () => {
    const onCredits: CcUsage = { ...usage(100, 20), extra: { percent: 81, enabled: true } };
    expect(isUsageExhausted(onCredits, now)).toBe(false);
    const creditsSpent: CcUsage = { ...usage(100, 20), extra: { percent: 100, enabled: true } };
    expect(isUsageExhausted(creditsSpent, now)).toBe(true);
    const creditsOff: CcUsage = { ...usage(100, 20), extra: { percent: 0, enabled: false } };
    expect(isUsageExhausted(creditsOff, now)).toBe(true);
  });

  test("fallbackProfiles: credits rank after plan headroom; a dead login is never a target", () => {
    const ranked = fallbackProfiles(
      [
        { name: "active", email: "a@x.com", usage: usage(10, 20) },
        { name: "credits", email: "c@x.com", usage: { ...usage(100, 20), extra: { percent: 50, enabled: true } } },
        { name: "room", email: "r@x.com", usage: usage(40, 20) },
        { name: "dead", email: "d@x.com", usage: usage(0, 20), login_expired_at: now - 3600_000 },
        { name: "unknown", email: "u@x.com" },
      ],
      "a@x.com",
      now,
    );
    expect(ranked.map((p) => p.name)).toEqual(["room", "credits", "unknown"]);
  });
});

describe("splitAuthParks", () => {
  const now = 10_000_000_000;
  const activeSince = now - 10 * 60_000; // the machine switched logins 10 minutes ago
  const device = (opts: { expiredAt?: number } = {}): {
    cc_accounts: {
      active_email: string;
      active_since: number;
      profiles: Array<{
        name: string;
        email: string;
        usage: { fetched_at: number };
        login_expired_at?: number;
      }>;
    };
  } => ({
    cc_accounts: {
      active_email: "b@x.com",
      active_since: activeSince,
      profiles: [
        { name: "a", email: "a@x.com", usage: { fetched_at: now } },
        { name: "b", email: "b@x.com", usage: { fetched_at: now }, ...(opts.expiredAt ? { login_expired_at: opts.expiredAt } : {}) },
      ],
    },
  });
  const park = (id: string, at: number) => ({ _id: id, updated_at: at, pending_api_error_at: at });

  // 2026-09-03: five manual switches in ten minutes; a session launched under
  // the login before last parked on "Not logged in" AFTER the latest switch.
  // The park is about the credential that process was bound to, not about the
  // login the machine holds now — a restart on the current login cures it.
  test("a park with no restart attempted on this login restarts on it", () => {
    const parks = [park("c1", activeSince + 60_000), park("c2", activeSince - 60_000)];
    expect(splitAuthParks(parks, device(), [])).toEqual({ restart: parks, dead: [] });
  });

  test("the daemon reporting the active login expired makes every park a switch", () => {
    const parks = [park("c1", now - 60_000)];
    expect(splitAuthParks(parks, device({ expiredAt: now - 30_000 }), [])).toEqual({ restart: [], dead: parks });
  });

  test("an expiry stamped before the login was activated is stale evidence", () => {
    const parks = [park("c1", now - 60_000)];
    expect(splitAuthParks(parks, device({ expiredAt: activeSince - 60_000 }), [])).toEqual({
      restart: parks,
      dead: [],
    });
  });

  test("a park that recurs after a restart on this login proves it dead, for the whole set", () => {
    const restartAt = now - 3 * 60_000;
    const attempts = [{ profile: `${AUTO_SWITCH_AUTH_RESTART_KEY}:c1`, at: restartAt }];
    const parks = [park("c1", restartAt + 90_000), park("c2", restartAt - 60_000)];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: [], dead: parks });
  });

  test("a park older than the last restart is in flight: neither restarted again nor proof", () => {
    const restartAt = now - 60_000;
    const attempts = [{ profile: `${AUTO_SWITCH_AUTH_RESTART_KEY}:c1`, at: restartAt }];
    const parks = [park("c1", restartAt - 30_000)];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: [], dead: [] });
  });

  test("a restart attempted under the previous login says nothing about this one", () => {
    const attempts = [{ profile: `${AUTO_SWITCH_AUTH_RESTART_KEY}:c1`, at: activeSince - 60_000 }];
    const parks = [park("c1", activeSince - 30_000)];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: parks, dead: [] });
  });

  test("only auth-restart attempts count; continues and switches are other keys", () => {
    const attempts = [
      { profile: "__continue__", at: now - 60_000 },
      { profile: "a", at: now - 60_000 },
    ];
    const parks = [park("c1", now - 2 * 60_000)];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: parks, dead: [] });
  });

  test("no inventory cannot prove a usable login for a restart", () => {
    const parks = [park("c1", now - 60_000)];
    expect(splitAuthParks(parks, undefined, [])).toEqual({ restart: [], dead: [] });
  });

  test("a later park in another conversation is not a failed restart", () => {
    const attempts = [{ profile: `${AUTO_SWITCH_AUTH_RESTART_KEY}:c1`, at: now - 60_000 }];
    const parks = [park("c2", now - 30_000)];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: parks, dead: [] });
  });

  test("updating an old row without a banner timestamp cannot prove a new auth failure", () => {
    const attempts = [{ profile: `${AUTO_SWITCH_AUTH_RESTART_KEY}:c1`, at: now - 60_000 }];
    const parks = [{ _id: "c1", updated_at: now }];
    expect(splitAuthParks(parks, device(), attempts)).toEqual({ restart: [], dead: [] });
  });

  test("a login whose only usage proof predates its activation is not ready", () => {
    const d = device();
    d.cc_accounts.profiles[1].usage = { fetched_at: activeSince - 1 };
    expect(splitAuthParks([park("c1", now - 60_000)], d, [])).toEqual({ restart: [], dead: [] });
  });

});

describe("decideAutoSwitch", () => {
  const now = 10_000_000_000;
  const parkedAt = now - 5 * 60_000; // sessions parked 5 minutes ago
  const mkUsage = (worst: number, opts: { sessionResetAt?: number } = {}): CcUsage => ({
    fetched_at: now - 60_000,
    session: { percent: worst, resets_at: opts.sessionResetAt ?? now + 3600_000 },
    weekly: { percent: Math.min(worst, 60), resets_at: now + 86_400_000 },
  });

  test("switches to the profile with the most headroom", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(100) },
        { name: "b", email: "b@x.com", usage: mkUsage(70) },
        { name: "c", email: "c@x.com", usage: mkUsage(20) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "switch", profile: "c" });
  });

  test("never switches onto a saved login the daemon could not refresh", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(100) },
        { name: "b", email: "b@x.com", usage: mkUsage(70) },
        { name: "c", email: "c@x.com", usage: mkUsage(20), login_expired_at: now - 60_000 },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "switch", profile: "b" });
  });

  // 2026-09-02: the user switched to a 2%-used account; the loop held only a
  // 2-day-old snapshot of it (pegged) and moved the machine to a 96% account.
  test("a snapshot older than the activation is not evidence — wait for the post-switch probe", () => {
    const activeSince = now - 30_000; // account changed 30s ago
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince,
      profiles: [
        { name: "a", email: "a@x.com", usage: { ...mkUsage(100), fetched_at: now - 2 * 86_400_000 } },
        { name: "b", email: "b@x.com", usage: mkUsage(96) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "wait", retry_at: now + AUTO_SWITCH_PROBE_RETRY_MS });
    // No snapshot at all is the same case.
    const blank = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince,
      profiles: [
        { name: "a", email: "a@x.com" },
        { name: "b", email: "b@x.com", usage: mkUsage(96) },
      ],
      attempts: [],
    });
    expect(blank.action).toBe("wait");
  });

  test("past the probe grace a stale snapshot is used as it stands", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince: now - AUTO_SWITCH_PROBE_GRACE_MS - 1,
      profiles: [
        { name: "a", email: "a@x.com", usage: { ...mkUsage(100), fetched_at: now - 2 * 86_400_000 } },
        { name: "b", email: "b@x.com", usage: mkUsage(96) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "switch", profile: "b" });
  });

  // Second failure the same night: the fresh probe (2%) landed, but the newest
  // parks were re-parks on the account just switched AWAY from, so the
  // "5 minutes after the park" bar discarded it and the loop switched again.
  test("parks older than the activation belong to the previous account: a probe since activation continues", () => {
    const activeSince = parkedAt + 60_000; // account changed after the newest park
    const fetchedAt = activeSince + 10_000; // well inside the old 5-minute bar
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince,
      profiles: [
        { name: "a", email: "a@x.com", usage: { ...mkUsage(2), fetched_at: fetchedAt } },
        { name: "b", email: "b@x.com", usage: mkUsage(96) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "continue" });
    // Same probe age, but the parks came AFTER the activation (this account's
    // own parks): the settled bar still applies, and a 96% sibling is the pick.
    const ownParks = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince: parkedAt - 60_000,
      profiles: [
        { name: "a", email: "a@x.com", usage: { ...mkUsage(2), fetched_at: parkedAt + 70_000 } },
        { name: "b", email: "b@x.com", usage: mkUsage(96) },
      ],
      attempts: [],
    });
    expect(ownParks).toEqual({ action: "switch", profile: "b" });
  });

  test("a dead login never waits — a switch is the only cure", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      activeSince: now - 30_000,
      activeDead: true,
      profiles: [
        { name: "a", email: "a@x.com" },
        { name: "b", email: "b@x.com", usage: mkUsage(20) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "switch", profile: "b" });
  });

  test("known headroom beats unknown usage; unknown still beats nothing", () => {
    const known = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com" },
        { name: "mystery", email: "b@x.com" },
        { name: "fresh", email: "c@x.com", usage: mkUsage(30) },
      ],
      attempts: [],
    });
    expect(known).toEqual({ action: "switch", profile: "fresh" });

    const unknownOnly = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com" },
        { name: "mystery", email: "b@x.com" },
      ],
      attempts: [],
    });
    expect(unknownOnly).toEqual({ action: "switch", profile: "mystery" });
  });

  test("never picks the active account or an exhausted one", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(10) }, // active — excluded despite headroom
        { name: "b", email: "b@x.com", usage: mkUsage(100) }, // pegged
      ],
      attempts: [],
    });
    expect(d.action).toBe("exhausted");
  });

  test("skips a profile already tried this window, retries it after the window rolls", () => {
    const profiles = [
      { name: "a", email: "a@x.com", usage: mkUsage(100) },
      { name: "b", email: "b@x.com" }, // no usage data — eligibility rides on attempts
    ];
    // Tried b 30 minutes before the newest park → sessions parked again on it → spent.
    const spent = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles,
      attempts: [{ profile: "b", at: parkedAt - 30 * 60_000 }],
    });
    expect(spent.action).toBe("exhausted");

    // Same attempt, but its 5h window has rolled — b is a candidate again.
    const rolled = decideAutoSwitch({
      now: now + AUTO_SWITCH_SESSION_WINDOW_MS,
      parkedAt: now + AUTO_SWITCH_SESSION_WINDOW_MS - 60_000,
      activeEmail: "a@x.com",
      profiles,
      attempts: [{ profile: "b", at: parkedAt - 30 * 60_000 }],
    });
    expect(rolled).toEqual({ action: "switch", profile: "b" });
  });

  test("a usage snapshot fetched after the attempt settled overrules the blackout", () => {
    // 2026-07-17 incident, exact production state. Auto-switch tried union at
    // 01:50Z; sessions still recovering from the switch stamped fresh park
    // banners within minutes, which burned union's attempt even though union
    // was never spent (its own 5h window ended at 11%). Hours later, with
    // personal genuinely pegged and fresh's scoped window at 100%, the
    // attempt blackout hid union's headroom and the verdict came back
    // "every account is spent".
    const d = decideAutoSwitch({
      now: Date.parse("2026-07-17T06:35:00Z"),
      parkedAt: Date.parse("2026-07-17T06:20:00Z"),
      activeEmail: "fresh@x.com",
      profiles: [
        {
          name: "fresh",
          email: "fresh@x.com",
          usage: {
            fetched_at: 1784269994894, // 06:33Z
            session: { percent: 19, resets_at: 1784278799916 },
            weekly: { percent: 55, resets_at: 1784703599916 },
            weekly_scoped: { percent: 100, resets_at: 1784703599917, label: "Fable" },
          },
        },
        {
          name: "personal",
          email: "personal@x.com",
          usage: {
            fetched_at: 1784269994894,
            session: { percent: 100, resets_at: 1784271000112 },
            weekly: { percent: 46, resets_at: 1784671200113 },
            weekly_scoped: { percent: 81, resets_at: 1784671200113, label: "Fable" },
            extra: { percent: 100, enabled: false },
          },
        },
        {
          name: "union",
          email: "union@x.com",
          usage: {
            fetched_at: 1784269994894,
            session: { percent: 11, resets_at: 1784270999787 },
            weekly: { percent: 4, resets_at: 1784782799787 },
            weekly_scoped: { percent: 8, resets_at: 1784782799787, label: "Fable" },
            extra: { percent: 100, enabled: false },
          },
        },
      ],
      attempts: [
        { profile: "union", at: 1784253048509 }, // 01:50:48Z
        { profile: "personal", at: 1784253233513 }, // 01:53:53Z
        { profile: "fresh", at: 1784260922168 }, // 04:02:02Z
      ],
    });
    expect(d).toEqual({ action: "switch", profile: "union" });
  });

  test("only a snapshot newer than the attempt plus the settle margin counts as evidence", () => {
    const att = parkedAt - 30 * 60_000;
    const attempts = [{ profile: "b", at: att }];
    const withSnapshotAt = (fetchedAt: number) =>
      decideAutoSwitch({
        now,
        parkedAt,
        activeEmail: "a@x.com",
        profiles: [
          { name: "a", email: "a@x.com", usage: mkUsage(100) },
          { name: "b", email: "b@x.com", usage: { ...mkUsage(10), fetched_at: fetchedAt } },
        ],
        attempts,
      });
    // Fetched before the attempt — says nothing about what the attempt hit.
    expect(withSnapshotAt(att - 60_000).action).toBe("exhausted");
    // Fetched inside the settle margin — could have been probed mid-burn.
    expect(withSnapshotAt(att + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS - 1_000).action).toBe("exhausted");
    // Fetched after the attempt settled, showing headroom — eligible again.
    expect(withSnapshotAt(att + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS + 1_000)).toEqual({
      action: "switch",
      profile: "b",
    });
  });

  test("waits on a switch that is still in flight (attempt newer than the park)", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(100) },
        { name: "b", email: "b@x.com", usage: mkUsage(10) },
      ],
      attempts: [{ profile: "b", at: parkedAt + 60_000 }],
    });
    expect(d.action).toBe("exhausted");
  });

  test("prefers a free same-account continue when the session window rolled after the park", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        // Session window reset between the park and now; weekly has headroom.
        { name: "a", email: "a@x.com", usage: mkUsage(100, { sessionResetAt: parkedAt + 60_000 }) },
        { name: "b", email: "b@x.com", usage: mkUsage(10) },
      ],
      attempts: [],
    });
    expect(d).toEqual({ action: "continue" });
  });

  test("activeDead (auth park) suppresses continue and forces a switch", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        // Would qualify for a free continue — but the login is dead, so a
        // continue would just re-park on the auth banner.
        { name: "a", email: "a@x.com", usage: mkUsage(100, { sessionResetAt: parkedAt + 60_000 }) },
        { name: "b", email: "b@x.com", usage: mkUsage(10) },
      ],
      attempts: [],
      activeDead: true,
    });
    expect(d).toEqual({ action: "switch", profile: "b" });
  });

  test("activeDead with no other account is exhausted, not continue", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [{ name: "a", email: "a@x.com", usage: mkUsage(10) }],
      attempts: [],
      activeDead: true,
    });
    expect(d.action).toBe("exhausted");
  });

  test("does not re-try a continue that already failed for this park", () => {
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(100, { sessionResetAt: parkedAt + 60_000 }) },
        { name: "b", email: "b@x.com", usage: mkUsage(10) },
      ],
      attempts: [{ profile: AUTO_SWITCH_CONTINUE_KEY, at: parkedAt + 120_000 }],
    });
    // Continue was already attempted after this park — fall through to a switch.
    expect(d).toEqual({ action: "switch", profile: "b" });
  });

  test("a settled probe showing headroom proves the window rolled even after the snapshot re-probed to 0%", () => {
    // After a reset the usage endpoint reports the session window as
    // {percent: 0} with NO resets_at, so the rolled-since-park proof is gone
    // the moment the daemon's 5-minute probe refreshes the snapshot. The
    // probe itself is then the evidence — but only once it post-dates the
    // park by the settle margin (a probe seconds after the park can still be
    // mid-burn and read 97%).
    const rolledSnapshot = (fetchedAt: number): CcUsage => ({
      fetched_at: fetchedAt,
      session: { percent: 0 },
      weekly: { percent: 40, resets_at: now + 86_400_000 },
    });
    const at = (fetchedAt: number) =>
      decideAutoSwitch({
        now,
        parkedAt,
        activeEmail: "a@x.com",
        profiles: [{ name: "a", email: "a@x.com", usage: rolledSnapshot(fetchedAt) }],
        attempts: [],
        allowSwitch: false,
      });
    expect(at(parkedAt - 60_000).action).toBe("exhausted");
    expect(at(parkedAt + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS - 1_000).action).toBe("exhausted");
    expect(at(parkedAt + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS + 1_000)).toEqual({ action: "continue" });
    // A settled probe that still shows a pegged window is not headroom.
    const stillPegged = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        {
          name: "a",
          email: "a@x.com",
          usage: { ...mkUsage(100), fetched_at: parkedAt + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS + 1_000 },
        },
      ],
      attempts: [],
      allowSwitch: false,
    });
    expect(stillPegged.action).toBe("exhausted");
  });

  test("allowSwitch:false never switches — it waits on the active account's own resets", () => {
    const resetSoon = now + 30 * 60_000;
    const input = {
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        { name: "a", email: "a@x.com", usage: mkUsage(100, { sessionResetAt: resetSoon }) },
        { name: "b", email: "b@x.com", usage: mkUsage(10, { sessionResetAt: now + 10 * 60_000 }) },
      ],
      attempts: [],
    };
    // Same fleet, switching allowed: b is the obvious pick.
    expect(decideAutoSwitch(input)).toEqual({ action: "switch", profile: "b" });
    // Switching off: exhausted, and the wake-up tracks the ACTIVE account's
    // reset (b's earlier reset can't help a session that will never move).
    const d = decideAutoSwitch({ ...input, allowSwitch: false });
    expect(d.action).toBe("exhausted");
    if (d.action === "exhausted") expect(d.retry_at).toBe(resetSoon + 2 * 60_000);
    // Once the active window rolls, the free continue still wins.
    expect(
      decideAutoSwitch({
        ...input,
        allowSwitch: false,
        now: resetSoon + 60_000,
        parkedAt: resetSoon - 60_000,
      }),
    ).toEqual({ action: "continue" });
  });

  test("exhausted carries the earliest future reset (plus settle margin)", () => {
    const resetSoon = now + 30 * 60_000;
    const d = decideAutoSwitch({
      now,
      parkedAt,
      activeEmail: "a@x.com",
      profiles: [
        {
          name: "a",
          email: "a@x.com",
          usage: {
            fetched_at: now,
            session: { percent: 100, resets_at: resetSoon },
            weekly: { percent: 100, resets_at: now + 86_400_000 },
          },
        },
      ],
      attempts: [],
    });
    expect(d.action).toBe("exhausted");
    if (d.action === "exhausted") expect(d.retry_at).toBe(resetSoon + 2 * 60_000);
  });

  test("exhausted with no usage data falls back to an hourly retry", () => {
    const d = decideAutoSwitch({ now, parkedAt, activeEmail: undefined, profiles: [], attempts: [] });
    expect(d.action).toBe("exhausted");
    if (d.action === "exhausted") expect(d.retry_at).toBe(now + 60 * 60_000 + 2 * 60_000);
  });
});

describe("pickThrottleContinueBatch", () => {
  const row = (id: string, kind: string, parkedAgoMs: number, now: number) => ({
    _id: id,
    pending_api_error_kind: kind,
    pending_api_error_at: now - parkedAgoMs,
  });

  test("continues only throttle parks past the delay, oldest first, capped at the batch", () => {
    const now = 1_000_000_000;
    const rows = [
      row("fresh", "throttle", 10_000, now),
      row("limit", "limit", 10 * 60_000, now),
      row("a", "throttle", 90_000, now),
      row("b", "throttle", 5 * 60_000, now),
      row("c", "throttle", 3 * 60_000, now),
      row("d", "throttle", 2 * 60_000, now),
    ];
    const pick = pickThrottleContinueBatch(rows, now);
    expect(pick.batch.map((r) => r._id)).toEqual(["b", "c", "d"]);
    expect(pick.remaining).toBe(1);
    expect(pick.waiting).toBe(1);
    expect(pick.nextDueAt).toBe(now - 10_000 + THROTTLE_CONTINUE_DELAY_MS);
    expect(THROTTLE_CONTINUE_BATCH).toBe(3);
  });

  test("nothing due yet books the moment the oldest waiting park becomes due", () => {
    const now = 5_000_000;
    const pick = pickThrottleContinueBatch([row("x", "throttle", 20_000, now), row("y", "throttle", 40_000, now)], now);
    expect(pick.batch).toEqual([]);
    expect(pick.waiting).toBe(2);
    expect(pick.nextDueAt).toBe(now - 40_000 + THROTTLE_CONTINUE_DELAY_MS);
  });

  test("no throttle parks at all is a no-op", () => {
    const pick = pickThrottleContinueBatch([row("l", "limit", 10 * 60_000, 1)], 1);
    expect(pick.batch).toEqual([]);
    expect(pick.nextDueAt).toBeNull();
  });
});

describe("actedBlockedConversations", () => {
  const top = { _id: "top", is_subagent: false };
  const worker = { _id: "worker", parent_conversation_id: "top" };
  const flagged = { _id: "flagged", is_subagent: true };

  test("skips subagent workers by default, top-level rows first on opt-in", () => {
    expect(actedBlockedConversations([worker, top, flagged], false)).toEqual([top]);
    expect(actedBlockedConversations([worker, top, flagged], true)).toEqual([top, worker, flagged]);
  });

  test("a blocked set made only of workers yields nothing without the opt-in", () => {
    // The 2026-08-20 incident: after one revive round the only blocked rows
    // were in-process workflow agents; auto-including them resumed 53 copies.
    expect(actedBlockedConversations([worker, flagged], false)).toEqual([]);
    expect(actedBlockedConversations([], true)).toEqual([]);
  });
});

describe("per-device account resolution", () => {
  const macA = {
    profiles: [
      { name: "personal", email: "a@x.com" },
      { name: "work", email: "w@x.com" },
    ],
  };
  const macB = { profiles: [{ name: "main", email: "w@x.com" }] };
  const oldDaemon = { profiles: [{ name: "work" }] };

  test("resolves by email to the device's own name, never the caller's alias", () => {
    expect(resolveDeviceProfile(macA, { email: "w@x.com" })).toBe("work");
    expect(resolveDeviceProfile(macB, { email: "w@x.com" })).toBe("main");
    expect(resolveDeviceProfile(macB, { profile: "work", email: "w@x.com" })).toBe("main");
  });

  test("a device without the account is unresolvable, not a foreign name", () => {
    expect(resolveDeviceProfile(macB, { email: "a@x.com" })).toBeUndefined();
    expect(resolveDeviceProfile(macB, { profile: "personal" })).toBeUndefined();
    expect(resolveDeviceProfile(undefined, { email: "a@x.com" })).toBeUndefined();
  });

  test("falls back to exact name for inventories with no emails", () => {
    expect(resolveDeviceProfile(oldDaemon, { profile: "work", email: "w@x.com" })).toBe("work");
    expect(resolveDeviceProfile(oldDaemon, { profile: "personal" })).toBeUndefined();
  });

  test("targetAccountEmail lifts a pinned-device name to an identity", () => {
    expect(targetAccountEmail(macA, { profile: "work" })).toBe("w@x.com");
    expect(targetAccountEmail(macA, { email: "z@x.com", profile: "work" })).toBe("z@x.com");
    expect(targetAccountEmail(oldDaemon, { profile: "work" })).toBeUndefined();
    expect(targetAccountEmail(macA, {})).toBeUndefined();
  });
});

// "Continue on this account" must reach a session bound to another account by
// restarting it, never by a message: the setup-token in its env was read at
// process start (2026-09-02: 36 sessions pinned to a capped account answered
// every plain continue with the same limit banner while the machine's login
// had 85% headroom).
describe("continueNeedsRestart", () => {
  const now = 1_000_000;
  const live = { expires_at: now + 1 };
  const pinned = {
    is_remote: false,
    cc_accounts: {
      active_email: "a@x.com",
      profiles: [
        { name: "ashot", email: "a@x.com", token: live },
        { name: "other", email: "o@x.com", token: live },
      ],
    },
  };
  const keychainOnly = {
    ...pinned,
    cc_accounts: { active_email: "a@x.com", profiles: [{ name: "ashot", email: "a@x.com" }, { name: "other", email: "o@x.com", token: live }] },
  };

  test("the target pin is the active login's token, none without one, never on a remote", () => {
    const retiredFlagDevice = { ...pinned, cc_session_tokens: false };
    expect(continueTargetPin(pinned, now)).toBe("ashot");
    expect(continueTargetPin(keychainOnly, now)).toBeUndefined();
    expect(continueTargetPin(retiredFlagDevice, now)).toBe("ashot");
    expect(continueTargetPin({ ...pinned, is_remote: true }, now)).toBeUndefined();
    expect(continueTargetPin(undefined, now)).toBeUndefined();
  });

  test("a session pinned to another account's token restarts", () => {
    const retiredFlagDevice = { ...pinned, cc_session_tokens: false };
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "other" }, pinned, now)).toBe(true);
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "other" }, keychainOnly, now)).toBe(true);
    // The retired flag cannot disable token routing.
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "other" }, retiredFlagDevice, now)).toBe(true);
  });

  test("a session already on this account gets a plain message", () => {
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "ashot" }, pinned, now)).toBe(false);
    expect(continueNeedsRestart({ pending_api_error_kind: "limit" }, pinned, now)).toBe(false);
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: null }, keychainOnly, now)).toBe(false);
    expect(continueNeedsRestart({ pending_api_error_kind: "connection", cc_account: "ashot" }, pinned, now)).toBe(false);
  });

  test("signed-out sessions always restart; remote pins are ignored", () => {
    expect(continueNeedsRestart({ pending_api_error_kind: "auth" }, pinned, now)).toBe(true);
    expect(continueNeedsRestart({ pending_api_error_kind: "auth" }, undefined, now)).toBe(true);
    expect(continueNeedsRestart({ pending_api_error_kind: "limit", cc_account: "other" }, { ...pinned, is_remote: true }, now)).toBe(false);
  });
});

describe("parks on another account's pin", () => {
  const now = 10_000_000_000;
  const parkedAt = now - 60_000; // parked a minute ago — no settled probe yet
  const live = { expires_at: now + 1 };
  const device = {
    is_remote: false,
    cc_accounts: {
      active_email: "a@x.com",
      profiles: [
        { name: "ashot", email: "a@x.com" },
        { name: "spent", email: "s@x.com", token: live },
      ],
    },
  };
  const headroom: CcUsage = {
    fetched_at: parkedAt + 30_000, // seconds after the park: fails the settled-probe bar
    session: { percent: 63, resets_at: now + 3 * 3600_000 },
    weekly: { percent: 33, resets_at: now + 6 * 86_400_000 },
  };
  const base = {
    now,
    parkedAt,
    activeEmail: "a@x.com",
    activeSince: now - 86_400_000,
    profiles: [{ name: "ashot", email: "a@x.com", usage: headroom }, { name: "spent", email: "s@x.com" }],
    attempts: [],
    allowSwitch: false,
  };

  test("parkedOnActiveAccount: unpinned and own-identity pins ran on the active login; other, unknown and identity-less pins did not", () => {
    expect(parkedOnActiveAccount({}, device)).toBe(true);
    expect(parkedOnActiveAccount({ cc_account: null }, device)).toBe(true);
    expect(parkedOnActiveAccount({ cc_account: "ashot" }, device)).toBe(true);
    expect(parkedOnActiveAccount({ cc_account: "spent" }, device)).toBe(false);
    expect(parkedOnActiveAccount({ cc_account: "gone" }, device)).toBe(false);
    expect(parkedOnActiveAccount({ cc_account: "ashot" }, { ...device, cc_accounts: { profiles: [{ name: "ashot" }] } })).toBe(false);
    // Remotes run the pushed credential; a stale pin there is inert.
    expect(parkedOnActiveAccount({ cc_account: "spent" }, { ...device, is_remote: true })).toBe(true);
    expect(parkedOnActiveAccount({ cc_account: "spent" }, undefined)).toBe(false);
  });

  test("a park that only implicates another account's pin continues at once — no wait on the active windows", () => {
    // Read as the active account's own park nothing proves headroom yet, so
    // the loop books the active session reset hours away (the 2026-09-03 wait).
    expect(decideAutoSwitch(base).action).toBe("exhausted");
    expect(decideAutoSwitch({ ...base, activeParkedAt: parkedAt }).action).toBe("exhausted");
    // Read as the pinned account's park: the restart that corrects the pin
    // un-parks it, and the active meters show headroom.
    expect(decideAutoSwitch({ ...base, activeParkedAt: null })).toEqual({ action: "continue" });
  });

  test("a spent active account still gates: foreign parks wait on its reset like every other", () => {
    const pegged: CcUsage = {
      fetched_at: now - 60_000,
      session: { percent: 100, resets_at: now + 3600_000 },
      weekly: { percent: 40, resets_at: now + 86_400_000 },
    };
    const d = decideAutoSwitch({
      ...base,
      activeParkedAt: null,
      profiles: [{ name: "ashot", email: "a@x.com", usage: pegged }],
    });
    expect(d).toEqual({ action: "exhausted", retry_at: now + 3600_000 + 2 * 60_000 });
  });

  test("mixed parks: the active account's own park still needs its evidence, then one continue covers both", () => {
    const mixed = { ...base, activeParkedAt: parkedAt - 10_000 };
    expect(decideAutoSwitch(mixed).action).toBe("exhausted");
    const settled = { ...headroom, fetched_at: parkedAt + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS };
    expect(
      decideAutoSwitch({ ...mixed, profiles: [{ name: "ashot", email: "a@x.com", usage: settled }] }),
    ).toEqual({ action: "continue" });
  });

  test("a continue already tried for this park is not repeated", () => {
    const d = decideAutoSwitch({
      ...base,
      activeParkedAt: null,
      attempts: [{ profile: AUTO_SWITCH_CONTINUE_KEY, at: parkedAt + 1000 }],
    });
    expect(d.action).toBe("exhausted");
  });

  test("a snapshot older than the activation still waits for the post-switch probe", () => {
    const d = decideAutoSwitch({
      ...base,
      activeParkedAt: null,
      activeSince: now - 60_000,
      profiles: [{ name: "ashot", email: "a@x.com", usage: { ...headroom, fetched_at: now - 10 * 60_000 } }],
    });
    expect(d.action).toBe("wait");
  });
});

describe("resumePinFor", () => {
  const now = 1_000_000;
  const live = { expires_at: now + 1 };
  const keychainOnly = {
    is_remote: false,
    cc_accounts: {
      active_email: "a@x.com",
      profiles: [
        { name: "ashot", email: "a@x.com" },
        { name: "spent", email: "s@x.com", token: live },
      ],
    },
  };
  const tokened = {
    ...keychainOnly,
    cc_accounts: {
      active_email: "a@x.com",
      profiles: [
        { name: "ashot", email: "a@x.com", token: live },
        { name: "spent", email: "s@x.com", token: live },
      ],
    },
  };
  const limitParked = { pending_api_error: true, pending_api_error_kind: "limit", cc_account: "spent" };

  test("a limit- or auth-parked session pinned to another account resumes under this device's continue pin", () => {
    expect(resumePinFor(limitParked, keychainOnly, now)).toBeUndefined();
    expect(resumePinFor(limitParked, tokened, now)).toBe("ashot");
    expect(resumePinFor({ ...limitParked, pending_api_error_kind: "auth" }, tokened, now)).toBe("ashot");
    expect(resumePinFor({ ...limitParked, cc_account: "gone" }, keychainOnly, now)).toBeUndefined();
  });

  test("existing pins survive while legacy unpinned sessions adopt the current token", () => {
    expect(resumePinFor({ cc_account: "spent" }, keychainOnly, now)).toBe("spent");
    expect(resumePinFor({ ...limitParked, pending_api_error: false }, keychainOnly, now)).toBe("spent");
    expect(resumePinFor({ ...limitParked, pending_api_error_kind: "connection" }, keychainOnly, now)).toBe("spent");
    expect(resumePinFor({ ...limitParked, cc_account: "ashot" }, tokened, now)).toBe("ashot");
    expect(resumePinFor({ ...limitParked, cc_account: undefined }, tokened, now)).toBe("ashot");
    expect(resumePinFor({}, tokened, now)).toBe("ashot");
    expect(resumePinFor({}, keychainOnly, now)).toBeUndefined();
    expect(resumePinFor(limitParked, { ...keychainOnly, is_remote: true }, now)).toBe("spent");
  });
});

describe("account switch restart command", () => {
  const now = 1_000_000;
  const userId = "user_1" as any;
  const conversationId = "conversation_1" as any;
  const device = {
    _id: "device_1",
    user_id: userId,
    device_id: "local-1",
    label: "Mac",
    last_seen: now,
    cc_session_tokens: false,
    cc_accounts: {
      active_email: "old@x.com",
      profiles: [
        { name: "old", email: "old@x.com", token: { stored_at: 1, expires_at: now + 1 } },
        { name: "next", email: "next@x.com", token: { stored_at: 1, expires_at: now + 1 } },
      ],
    },
  } as any;

  test("re-pins and restarts the blocked Claude process under the selected token", async () => {
    const conversation = {
      _id: conversationId,
      session_id: "session-1",
      owner_device_id: device.device_id,
      cc_account: "old",
    } as any;
    const db = makeFakeDb({
      conversations: [conversation],
      devices: [device],
      daemon_commands: [],
    });

    const result = await insertSwitchCommands({ db }, userId, {
      profile: "next",
      blocked: [conversation],
      online: [device],
      primary: device,
      continueBlocked: true,
      now,
    });

    expect(result.restarted).toBe(1);
    expect(db._tables.conversations[0].cc_account).toBe("next");
    const command = db._tables.daemon_commands[0];
    const args = JSON.parse(command.args);
    expect(args.profile).toBe("next");
    expect(args.conversation_ids).toEqual([conversationId]);
    expect(args.session_ids).toEqual({ [conversationId]: "session-1" });
    expect(args.continue_blocked).toBe(true);
  });
});
