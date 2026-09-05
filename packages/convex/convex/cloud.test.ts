import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { requestRemoteWake, wakeDevicesFor } from "./cloud";
import { resolveOfflineOwnerTakeover } from "./pendingMessages";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const now = 1_000_000_000;
const online = now - 10_000;
const asleep = now - DEVICE_ONLINE_MS - 60_000;

describe("wakeDevicesFor — which sleeping hosts a local daemon should boot", () => {
  test("a remote that is offline with a stamp newer than its last beat", () => {
    expect(wakeDevicesFor([
      { device_id: "box", label: "Cloud Linux", last_seen: asleep, is_remote: true, wake_requested_at: now - 1000 },
    ], now)).toEqual([{ device_id: "box", label: "Cloud Linux" }]);
  });
  test("an answered stamp (older than the last beat), an online remote, or a local device never wakes", () => {
    expect(wakeDevicesFor([
      { device_id: "box", last_seen: asleep, is_remote: true, wake_requested_at: asleep - 5 },
      { device_id: "awake", last_seen: online, is_remote: true, wake_requested_at: now },
      { device_id: "laptop", last_seen: asleep, is_remote: false, wake_requested_at: now },
    ], now)).toEqual([]);
  });
});

describe("requestRemoteWake — stamping the device when work queues for a sleeping host", () => {
  const user = "user1" as any;
  function db(devices: any[]) {
    return makeFakeDb({ devices, conversations: [] });
  }
  test("stamps an offline remote owner once", async () => {
    const d = db([{ _id: "dev1", user_id: user, device_id: "box", is_remote: true, last_seen: asleep }]);
    const conv = { user_id: user, owner_device_id: "box" };
    expect(await requestRemoteWake({ db: d } as any, conv)).toBe(true);
    const row = await d.get("dev1");
    expect(typeof row.wake_requested_at).toBe("number");
    const stampedAt = row.wake_requested_at;
    expect(await requestRemoteWake({ db: d } as any, conv)).toBe(true);
    expect((await d.get("dev1")).wake_requested_at).toBe(stampedAt);
  });
  test("a just-stopped remote retains wake intent until its heartbeat expires", async () => {
    const d = db([
      { _id: "dev1", user_id: user, device_id: "box", is_remote: true, last_seen: Date.now() },
      { _id: "dev2", user_id: user, device_id: "laptop", is_remote: false, last_seen: asleep },
    ]);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user, owner_device_id: "box" })).toBe(true);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user, owner_device_id: "laptop" })).toBe(false);
    expect(await requestRemoteWake({ db: d } as any, { user_id: user })).toBe(false);
    const remote = await d.get("dev1");
    expect(wakeDevicesFor([remote], remote.last_seen + DEVICE_ONLINE_MS)).toEqual([{ device_id: "box", label: null }]);
    expect((await d.get("dev2")).wake_requested_at).toBeUndefined();
  });
});

describe("resolveOfflineOwnerTakeover — a sleeping cloud host is not a dead laptop", () => {
  const user = "user1" as any;
  test("a local claimant may take over an offline LOCAL owner, never an offline REMOTE one", async () => {
    const d = makeFakeDb({
      devices: [
        { _id: "a", user_id: user, device_id: "laptop", is_remote: false, last_seen: now },
        { _id: "b", user_id: user, device_id: "old-laptop", is_remote: false, last_seen: asleep },
        { _id: "c", user_id: user, device_id: "box", is_remote: true, last_seen: asleep },
      ],
    });
    expect(await resolveOfflineOwnerTakeover({ db: d } as any, user, "laptop", "old-laptop", now)).toBe(true);
    expect(await resolveOfflineOwnerTakeover({ db: d } as any, user, "laptop", "box", now)).toBe(false);
  });
});
