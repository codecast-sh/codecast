import { describe, expect, test } from "bun:test";
import { hostWakeStage, wakeElapsed, type HostWakeDevice } from "../hostWake";
import type { DaemonHealth } from "../../hooks/useDaemonHealth";

const NOW = 1_794_152_540_000;
const MIN = 60_000;
const offline: DaemonHealth = { kind: "offline", tier: "alert", offlineMs: 80 * MIN };
const ok: DaemonHealth = { kind: "ok" };
const laptop = { online: true, name: "MacBook" };

// union-line-5 on Nov 8: stopped at 14:23, a message queued at 15:38.
const host = (over: Partial<HostWakeDevice> = {}): HostWakeDevice => ({
  is_remote: true,
  platform: "linux",
  last_seen: NOW - 80 * MIN,
  cloud_host: { state: "running", managed_by: "lap", at: NOW - 82 * MIN },
  ...over,
});
const stage = (d: HostWakeDevice, h: DaemonHealth = offline, manager: typeof laptop | null = laptop) =>
  hostWakeStage(d, h, { now: NOW, manager });

describe("hostWakeStage", () => {
  test("only cloud hosts have a wake: a laptop is never asleep-and-waking", () => {
    expect(stage(host({ is_remote: false }))).toBeNull();
  });

  test("a host gone quiet with no work waiting is asleep, even when its last report still says running", () => {
    expect(stage(host())).toEqual({ stage: "asleep" });
  });

  test("a few quiet minutes on a host reported running stay the daemon's story", () => {
    expect(stage(host({ last_seen: NOW - 6 * MIN }), { kind: "quiet", quietMs: 6 * MIN })).toBeNull();
  });

  test("work queued: requested until someone starts the machine", () => {
    expect(stage(host({ wake_requested_at: NOW - 30_000 }))).toEqual({ stage: "requested", since: NOW - 30_000 });
  });

  test("the laptop's wake running, then done: starting, then connecting", () => {
    const at = NOW - 90_000;
    expect(stage(host({ wake_requested_at: at, cloud_host: { state: "stopped", managed_by: "lap", at: at + 1000, last_action: { action: "wake", status: "running", at: at + 1000 } } })))
      .toEqual({ stage: "starting", since: at });
    expect(stage(host({ wake_requested_at: at, cloud_host: { state: "running", managed_by: "lap", at: at + 60_000, last_action: { action: "wake", status: "ok", at: at + 60_000 } } })))
      .toEqual({ stage: "connecting", since: at });
  });

  test("an outcome from before the request is not this wake's", () => {
    const at = NOW - 30_000;
    const old = { action: "wake" as const, status: "failed" as const, detail: "old", at: at - 3 * 3600_000 };
    expect(stage(host({ wake_requested_at: at, cloud_host: { state: "stopped", managed_by: "lap", at: at - 3 * 3600_000, last_action: old } })).stage).toBe("requested");
  });

  test("a failed laptop wake says why, and offers Wake again only while the laptop can run it", () => {
    const at = NOW - 120_000;
    const d = host({ wake_requested_at: at, cloud_host: { state: "stopped", managed_by: "lap", at, last_action: { action: "wake", status: "failed", detail: "InsufficientInstanceCapacity", at: at + 5000 } } });
    expect(stage(d)).toEqual({ stage: "failed", since: at, error: "InsufficientInstanceCapacity", retry: true });
    expect(stage(d, offline, { online: false, name: "MacBook" })).toMatchObject({ stage: "failed", retry: false });
  });

  test("work waiting on a host whose laptop is offline: nobody can wake it", () => {
    const at = NOW - 60_000;
    expect(stage(host({ wake_requested_at: at }), offline, { online: false, name: "MacBook" }))
      .toEqual({ stage: "no_waker", since: at, waker: "MacBook" });
  });

  test("the server's own start follows cloud_wake for this request", () => {
    const at = NOW - 60_000;
    const d = (status: "pending" | "starting" | "awake" | "failed") =>
      host({ cloud_host: undefined, wake_requested_at: at, cloud_wake: { request_at: at, status, attempt: 2, ...(status === "failed" ? { last_error: "NoHeartbeat" } : {}) } });
    expect(stage(d("pending"), offline, null)).toEqual({ stage: "requested", since: at });
    expect(stage(d("starting"), offline, null)).toEqual({ stage: "starting", since: at, attempt: 2 });
    expect(stage(d("awake"), offline, null)).toEqual({ stage: "connecting", since: at });
    expect(stage(d("failed"), offline, null)).toEqual({ stage: "failed", since: at, error: "NoHeartbeat", retry: false });
  });

  test("the daemon's boot beat after a wake is connecting; the next beat ends the wake", () => {
    const woke = host({ last_seen: NOW - 10_000, cloud_host: { state: "running", managed_by: "lap", at: NOW - 30_000, last_action: { action: "wake", status: "ok", at: NOW - 30_000 } } });
    expect(stage(woke, { kind: "restarting", sinceMs: 20_000 })).toEqual({ stage: "connecting", since: NOW - 20_000 });
    expect(stage(woke, ok)).toBeNull();
  });

  test("a restart with no wake behind it (an update) is not a wake", () => {
    expect(stage(host({ last_seen: NOW - 10_000 }), { kind: "restarting", sinceMs: 20_000 })).toBeNull();
  });

  test("a stamp within the minute of the last beat may already be answered: no phantom wake", () => {
    expect(stage(host({ last_seen: NOW - 80 * MIN, wake_requested_at: NOW - 80 * MIN + 20_000 }))).toEqual({ stage: "asleep" });
  });

  test("a Wake pressed in Settings shows its progress with nothing waiting", () => {
    expect(stage(host({ cloud_host: { state: "stopped", managed_by: "lap", at: NOW - 20_000, last_action: { action: "wake", status: "running", at: NOW - 20_000 } } })))
      .toEqual({ stage: "starting", since: NOW - 20_000 });
  });
});

test("wakeElapsed reads at a glance", () => {
  expect(wakeElapsed(42_000)).toBe("42s");
  expect(wakeElapsed(3 * MIN + 5000)).toBe("3m");
  expect(wakeElapsed(65 * MIN)).toBe("1h 5m");
});
