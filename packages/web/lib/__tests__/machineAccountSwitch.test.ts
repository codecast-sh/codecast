import { describe, expect, test } from "bun:test";
import {
  MACHINE_SWITCH_SLOW_MS,
  MACHINE_SWITCH_TIMEOUT_MS,
  humanizeSwitchError,
  machineSwitchBlock,
  machineSwitchPendingCopy,
  profileIsCurrentLogin,
  resolveMachineSwitch,
  stripSwitchPrefix,
} from "../machineAccountSwitch";

describe("machineSwitchBlock", () => {
  const base = { isActive: false, thisProfile: "petrosianasho" };

  test("active account cannot switch to itself", () => {
    expect(machineSwitchBlock({ ...base, isActive: true })?.block).toBe("active");
  });

  test("expired login must sign in before a machine switch", () => {
    const blocked = machineSwitchBlock({ ...base, loginExpired: true });
    expect(blocked?.block).toBe("login_expired");
    expect(blocked?.label).toMatch(/sign in again/i);
  });

  test("offline and remote machines cannot switch", () => {
    expect(machineSwitchBlock({ ...base, online: false })?.block).toBe("offline");
    expect(machineSwitchBlock({ ...base, isRemote: true })?.block).toBe("remote");
  });

  test("a live saved account on an online primary can switch", () => {
    expect(machineSwitchBlock({ ...base, online: true })).toBeNull();
  });
});

describe("profileIsCurrentLogin", () => {
  test("matches the saved profile by email", () => {
    expect(profileIsCurrentLogin({ name: "jo", email: "jo@x.com" }, "jo@x.com")).toBe(true);
    expect(profileIsCurrentLogin({ name: "jo", email: "other@x.com" }, "jo@x.com")).toBe(false);
  });

  test("an email-less snapshot matches the current login's local part", () => {
    expect(profileIsCurrentLogin({ name: "joannagerkin" }, "joannagerkin@gmail.com")).toBe(true);
    expect(profileIsCurrentLogin({ name: "fresh" }, "joannagerkin@gmail.com")).toBe(false);
  });
});

describe("resolveMachineSwitch", () => {
  const pending = { profile: "petrosianasho", email: "petrosianasho@gmail.com", startedAt: 1_000 };
  const waiting = { pending, activeEmail: "ashotp@gmail.com", now: 1_000 };

  test("no pending switch is idle", () => {
    expect(resolveMachineSwitch({ pending: null, now: 0 }).phase).toBe("idle");
  });

  test("queued command is waiting until the daemon answers", () => {
    expect(resolveMachineSwitch(waiting).phase).toBe("waiting");
    expect(resolveMachineSwitch({ ...waiting, now: 1_000 + MACHINE_SWITCH_SLOW_MS }).phase).toBe("slow");
  });

  test("heartbeat moving to the target is success even before the command row", () => {
    expect(
      resolveMachineSwitch({
        ...waiting,
        activeEmail: "petrosianasho@gmail.com",
      }).phase,
    ).toBe("succeeded");
  });

  test("already on the target (email-less profile, chip labelled from the login) is success, not a wait", () => {
    expect(
      resolveMachineSwitch({
        pending: { profile: "joannagerkin", startedAt: 1_000 },
        activeEmail: "joannagerkin@gmail.com",
        now: 1_000,
      }).phase,
    ).toBe("succeeded");
  });

  test("daemon error is the failure the UI must show", () => {
    const res = resolveMachineSwitch({
      ...waiting,
      command: { executed_at: 2_000, error: 'Account switch failed: Profile "petrosianasho" holds an unusable credential (logged-out)' },
    });
    expect(res.phase).toBe("failed");
    expect(res.error).toBe("This saved login no longer works. Sign in again on this account, then switch.");
  });

  test("executed command without error is success", () => {
    expect(
      resolveMachineSwitch({
        ...waiting,
        command: { executed_at: 2_000, error: null },
      }).phase,
    ).toBe("succeeded");
  });

  test("timeout names the daemon, not a silent no-op", () => {
    const res = resolveMachineSwitch({
      ...waiting,
      now: 1_000 + MACHINE_SWITCH_TIMEOUT_MS,
    });
    expect(res.phase).toBe("failed");
    expect(res.error).toMatch(/didn't switch/);
  });
});

test("stripSwitchPrefix leaves unrelated errors intact", () => {
  expect(stripSwitchPrefix("That device's daemon is offline")).toBe("That device's daemon is offline");
});

test("humanizeSwitchError keeps a missing-profile error", () => {
  expect(humanizeSwitchError('Account switch failed: No saved profile "x" on this machine')).toContain("No saved profile");
});

test("pending copy distinguishes a slow wait", () => {
  expect(machineSwitchPendingCopy("waiting", "petrosianasho")).toBe(
    'Switching this machine to "petrosianasho"…',
  );
  expect(machineSwitchPendingCopy("slow", "petrosianasho", "ashot-mbp")).toBe(
    'Still waiting on ashot-mbp to switch to "petrosianasho"…',
  );
});
