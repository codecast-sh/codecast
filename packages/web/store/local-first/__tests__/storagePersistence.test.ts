import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDurableOfflineWriteCapability,
  DurableOfflineWritesUnavailableError,
  getStoragePersistenceStatus,
  requestPersistentStorage,
  resetStoragePersistenceForTests,
} from "../storagePersistence";

afterEach(resetStoragePersistenceForTests);

describe("persistent-storage durability posture", () => {
  test("requests persistence once and records a grant", async () => {
    let requests = 0;
    const storage = {
      persisted: async () => false,
      persist: async () => {
        requests++;
        return true;
      },
    };
    expect(await requestPersistentStorage(storage)).toBe("granted");
    expect(await requestPersistentStorage(storage)).toBe("granted");
    expect(requests).toBe(1);
    expect(getStoragePersistenceStatus()).toBe("granted");
  });

  test("a denied browser explicitly rejects offline durable writes", async () => {
    await requestPersistentStorage({
      persisted: async () => false,
      persist: async () => false,
    });
    expect(() => assertDurableOfflineWriteCapability(false))
      .toThrow(DurableOfflineWritesUnavailableError);
    expect(() => assertDurableOfflineWriteCapability(true)).not.toThrow();
  });

  test("unsupported storage is a visible reduced capability", async () => {
    expect(await requestPersistentStorage(undefined)).toBe("unsupported");
    expect(() => assertDurableOfflineWriteCapability(false))
      .toThrow(DurableOfflineWritesUnavailableError);
  });
});
