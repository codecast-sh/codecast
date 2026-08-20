import { describe, it, expect } from "bun:test";
import { SyncService, AuthExpiredError } from "./syncService.js";

const makeSync = () =>
  new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });

describe("SyncService.guarded", () => {
  it("maps an auth-shaped error to AuthExpiredError", async () => {
    const sync = makeSync();
    await expect(
      (sync as any).guarded(async () => {
        throw new Error("Invalid token: expired credentials");
      })
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("rethrows a non-auth error unchanged", async () => {
    const sync = makeSync();
    const boom = new Error("boom");
    await expect((sync as any).guarded(async () => { throw boom; })).rejects.toBe(boom);
  });

  it("does not treat transient server errors as auth errors", async () => {
    const sync = makeSync();
    const transient = new Error("invalid token (Request ID: abc123)");
    await expect((sync as any).guarded(async () => { throw transient; })).rejects.toBe(transient);
  });

  it("passes the resolved value through", async () => {
    const sync = makeSync();
    expect(await (sync as any).guarded(async () => 42)).toBe(42);
  });

  it("catches synchronous throws from the wrapped fn", async () => {
    const sync = makeSync();
    await expect(
      (sync as any).guarded(() => { throw new Error("token expired"); })
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe("fallback sites keep their fallback but re-raise auth expiry", () => {
  it("getPlanSnippet returns null on a non-auth error", async () => {
    const sync = makeSync();
    (sync as any).client = {
      query: async () => { throw new Error("network flake"); },
    };
    expect(await sync.getPlanSnippet("pl-1")).toBeNull();
  });

  it("getPlanSnippet throws AuthExpiredError on an auth error", async () => {
    const sync = makeSync();
    (sync as any).client = {
      query: async () => { throw new Error("authentication failed"); },
    };
    await expect(sync.getPlanSnippet("pl-1")).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("findLocalCheckouts returns [] on a non-auth error", async () => {
    const sync = makeSync();
    (sync as any).client = {
      query: async () => { throw new Error("network flake"); },
    };
    expect(await sync.findLocalCheckouts("git@github.com:a/b.git")).toEqual([]);
  });
});
