import { describe, expect, test } from "bun:test";
import {
  EMPTY_WATERMARK,
  MAX_REMEMBERED_KEYS,
  MAX_REPLAYED,
  type CatchUpStorage,
  type MissedNotification,
  loadWatermark,
  notificationKey,
  planCatchUp,
  readPushStamp,
  recordDelivered,
  saveWatermark,
  watermarkStorageKey,
} from "./notificationCatchUp";

const HOST = "convex.codecast.sh";
const OTHER_HOST = "localhost:3210";
const USER = "users_1";

function memoryStorage(): CatchUpStorage & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async getItem(key) {
      return rows.get(key) ?? null;
    },
    async setItem(key, value) {
      rows.set(key, value);
    },
  };
}

function missed(seq: number, epoch = "e1"): MissedNotification {
  return { key: `${epoch}.${seq}`, seq, epoch, title: `n${seq}`, body: "b" };
}

// A device that has already been stamped once — the ordinary case. A device
// with no epoch at all is the fresh install, tested on its own below.
const KNOWN = { seq: 0, epoch: "e1", seen: [] };

describe("watermark persistence", () => {
  test("round-trips per host and user", async () => {
    const storage = memoryStorage();
    await saveWatermark(storage, HOST, USER, { seq: 7, epoch: "e1", seen: ["a"] });
    expect(await loadWatermark(storage, HOST, USER)).toEqual({ seq: 7, epoch: "e1", seen: ["a"] });
    // A seq from another backend's counter must never answer for this one.
    expect(await loadWatermark(storage, OTHER_HOST, USER)).toEqual(EMPTY_WATERMARK);
    expect(await loadWatermark(storage, HOST, "users_2")).toEqual(EMPTY_WATERMARK);
    expect(storage.rows.has(watermarkStorageKey(HOST, USER))).toBe(true);
  });

  test("a corrupt watermark reads as never caught up instead of throwing", async () => {
    const storage = memoryStorage();
    storage.rows.set(watermarkStorageKey(HOST, USER), "{not json");
    expect(await loadWatermark(storage, HOST, USER)).toEqual(EMPTY_WATERMARK);
  });

  test("a live push advances the watermark and is remembered", async () => {
    const storage = memoryStorage();
    const next = recordDelivered(HOST, EMPTY_WATERMARK, { key: "e1.4", seq: 4, epoch: "e1" });
    await saveWatermark(storage, HOST, USER, next);
    expect(await loadWatermark(storage, HOST, USER)).toEqual({
      seq: 4,
      epoch: "e1",
      seen: [notificationKey(HOST, "e1.4")],
    });
  });

  test("a live push under a new epoch takes its seq rather than keeping the old one", () => {
    const next = recordDelivered(HOST, { seq: 57, epoch: "e0", seen: [] }, {
      key: "e1.3",
      seq: 3,
      epoch: "e1",
    });
    expect(next).toEqual({ seq: 3, epoch: "e1", seen: [notificationKey(HOST, "e1.3")] });
  });
});

describe("planCatchUp double-fire guard", () => {
  test("an entry already delivered live is not replayed", () => {
    const live = recordDelivered(HOST, EMPTY_WATERMARK, { key: "e1.2", seq: 2, epoch: "e1" });
    const plan = planCatchUp({
      host: HOST,
      watermark: live,
      missed: [missed(2), missed(3)],
      epoch: "e1",
    });
    expect(plan.present.map((e) => e.seq)).toEqual([3]);
    expect(plan.watermark.seq).toBe(3);
  });

  test("an entry iOS is still showing is not replayed", () => {
    const plan = planCatchUp({
      host: HOST,
      watermark: KNOWN,
      missed: [missed(1), missed(2)],
      epoch: "e1",
      presentedKeys: [notificationKey(HOST, "e1.1")],
    });
    expect(plan.present.map((e) => e.seq)).toEqual([2]);
    // Both are accounted for, so a second pass shows nothing at all.
    const again = planCatchUp({
      host: HOST,
      watermark: plan.watermark,
      missed: [missed(1), missed(2)],
      epoch: "e1",
    });
    expect(again.present).toEqual([]);
  });

  test("the same catch-up answer twice presents nothing the second time", () => {
    const first = planCatchUp({ host: HOST, watermark: KNOWN, missed: [missed(1)], epoch: "e1" });
    expect(first.present.map((e) => e.seq)).toEqual([1]);
    const second = planCatchUp({ host: HOST, watermark: first.watermark, missed: [missed(1)], epoch: "e1" });
    expect(second.present).toEqual([]);
  });

  test("the same key from another backend is a different notification", () => {
    const live = recordDelivered(OTHER_HOST, EMPTY_WATERMARK, { key: "e1.1", seq: 1, epoch: "e1" });
    const plan = planCatchUp({ host: HOST, watermark: live, missed: [missed(1)], epoch: "e1" });
    expect(plan.present.map((e) => e.seq)).toEqual([1]);
  });
});

describe("planCatchUp watermark arithmetic", () => {
  test("a whole-ring answer under a new epoch adopts the server's head", () => {
    const plan = planCatchUp({
      host: HOST,
      watermark: { seq: 57, epoch: "dead", seen: [] },
      missed: [missed(1, "e2"), missed(2, "e2"), missed(3, "e2")],
      epoch: "e2",
    });
    expect(plan.watermark).toMatchObject({ seq: 3, epoch: "e2" });
    expect(plan.present.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("a device with no epoch adopts the counter without bannering anything", () => {
    // A fresh install did not miss these notifications; it was not there for
    // them. It must not open with a stack of banners about the past.
    const plan = planCatchUp({
      host: HOST,
      watermark: EMPTY_WATERMARK,
      missed: [missed(1), missed(2), missed(3)],
      epoch: "e1",
    });
    expect(plan.present).toEqual([]);
    expect(plan.watermark).toMatchObject({ seq: 3, epoch: "e1" });
    expect(plan.watermark.seen.length).toBe(3);
  });

  test("a stored seq past the server's head heals to the head", () => {
    // The backend answers a watermark it never issued with the whole ring, and
    // the phone must come back down to the real counter instead of staying
    // parked above it forever.
    const plan = planCatchUp({
      host: HOST,
      watermark: { seq: 99, epoch: "e1", seen: [] },
      missed: [missed(1), missed(2)],
      epoch: "e1",
    });
    expect(plan.watermark.seq).toBe(2);
  });

  test("an empty answer keeps the watermark and adopts the live epoch", () => {
    const plan = planCatchUp({
      host: HOST,
      watermark: { seq: 9, epoch: "e1", seen: [] },
      missed: [],
      epoch: "e1",
    });
    expect(plan).toEqual({ present: [], watermark: { seq: 9, epoch: "e1", seen: [] } });
  });

  test("a long backlog banners only the newest few but accounts for all of them", () => {
    const backlog = Array.from({ length: 40 }, (_, i) => missed(i + 1));
    const plan = planCatchUp({ host: HOST, watermark: KNOWN, missed: backlog, epoch: "e1" });
    expect(plan.present.length).toBe(MAX_REPLAYED);
    expect(plan.present.map((e) => e.seq)).toEqual([36, 37, 38, 39, 40]);
    expect(plan.watermark.seq).toBe(40);
    const again = planCatchUp({ host: HOST, watermark: plan.watermark, missed: backlog, epoch: "e1" });
    expect(again.present).toEqual([]);
  });

  test("remembered keys stay capped at the server ring's size", () => {
    const backlog = Array.from({ length: MAX_REMEMBERED_KEYS + 30 }, (_, i) => missed(i + 1));
    const plan = planCatchUp({ host: HOST, watermark: KNOWN, missed: backlog, epoch: "e1" });
    expect(plan.watermark.seen.length).toBe(MAX_REMEMBERED_KEYS);
    expect(plan.watermark.seen[plan.watermark.seen.length - 1]).toBe(
      notificationKey(HOST, `e1.${MAX_REMEMBERED_KEYS + 30}`),
    );
  });
});

describe("readPushStamp", () => {
  test("reads a stamped payload and rejects an unstamped one", () => {
    expect(
      readPushStamp({ conversationId: "c1", notificationKey: "e1.2", notificationSeq: 2, notificationEpoch: "e1" }),
    ).toEqual({ key: "e1.2", seq: 2, epoch: "e1" });
    // A push from a backend that predates the stamp still routes; it just
    // cannot advance the watermark.
    expect(readPushStamp({ conversationId: "c1" })).toBeNull();
    expect(readPushStamp(undefined)).toBeNull();
  });
});
