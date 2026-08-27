import { describe, expect, test } from "bun:test";
import {
  isBlockedConversation,
  isRemoteAuthBlocked,
  isSubagentConversation,
  actedBlockedConversations,
  isDeviceOnline,
  isValidProfileName,
  shouldSweepStaleFlag,
  decideAutoSwitch,
  resolveDeviceProfile,
  targetAccountEmail,
  isExhaustionCurrent,
  isUsageExhausted,
  isWindowRolled,
  worstUsagePercent,
  AUTO_SWITCH_ATTEMPT_EVIDENCE_MS,
  AUTO_SWITCH_CONTINUE_KEY,
  AUTO_SWITCH_SESSION_WINDOW_MS,
  DEVICE_ONLINE_MS,
  STALE_FLAG_AFTER_MS,
  type CcUsage,
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
