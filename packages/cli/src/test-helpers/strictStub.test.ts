import { describe, expect, test } from "bun:test";
import { strictStub } from "./strictStub.js";

interface Store { get(k: string): string; put(k: string, v: string): void }

describe("strictStub", () => {
  test("given methods answer; any other call throws naming the stub and method", () => {
    const store = strictStub<Store>("Store", { get: (k) => `v:${k}` });
    expect(store.get("a")).toBe("v:a");
    expect(() => store.put("a", "b")).toThrow("Store.put() was called, but this test does not expect it");
  });

  test("is not a thenable, so awaiting it resolves to the stub", async () => {
    const store = strictStub<Store>("Store");
    expect(await Promise.resolve(store)).toBe(store);
  });
});
