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

// updateSessionId repoints conversations.session_id at the live session uuid.
// It used to swallow failures (`catch {}`), which stranded conversations on
// their spawn-time stub id: every session-bound `cast` write then failed
// "Conversation not found" with zero trace (union-mobile fleet, 2026-08-29).
// The contract now is: reject on failure so the daemon can queue a durable
// retry (pushSessionIdBinding).
describe("updateSessionId error contract", () => {
  it("rejects on mutation failure instead of swallowing", async () => {
    const sync = makeSync();
    (sync as any).client = {
      mutation: async () => { throw new Error("fetch failed"); },
    };
    await expect(sync.updateSessionId("conv-1", "uuid-1")).rejects.toThrow("fetch failed");
  });

  it("resolves when the mutation succeeds", async () => {
    const sync = makeSync();
    let sent: any = null;
    (sync as any).client = {
      mutation: async (_name: string, args: any) => { sent = args; return { updated: true }; },
    };
    await sync.updateSessionId("conv-1", "uuid-1", "/p", "/g");
    expect(sent).toMatchObject({ conversation_id: "conv-1", session_id: "uuid-1", project_path: "/p", git_root: "/g" });
  });
});
