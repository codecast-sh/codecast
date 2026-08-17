import { describe, expect, test } from "bun:test";
import { authRenderDecision, localBootTrust, shouldClearMemoryFor } from "./authTrust";

const id = { principalId: "userA", subject: "userA|sess1" };

describe("localBootTrust", () => {
  test("token matching the persisted verified principal is trusted before any network", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userA",
        isAuthenticated: false,
        currentUserLoaded: false,
        currentUserId: null,
      }),
    ).toBe("userA|sess1");
  });

  test("no anchor yet (fresh install / legacy upgrade / still reading) earns nothing", () => {
    for (const bootPrincipal of [null, undefined]) {
      expect(
        localBootTrust({
          accessIdentity: id,
          bootPrincipal,
          isAuthenticated: false,
          currentUserLoaded: false,
          currentUserId: null,
        }),
      ).toBeNull();
    }
  });

  test("token for another principal than the cache owner earns nothing", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userB",
        isAuthenticated: false,
        currentUserLoaded: false,
        currentUserId: null,
      }),
    ).toBeNull();
  });

  test("server resolving the token to a different user revokes local trust", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userA",
        isAuthenticated: true,
        currentUserLoaded: true,
        currentUserId: "userB",
      }),
    ).toBeNull();
  });

  test("server resolving to NO user (deleted account) revokes local trust", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userA",
        isAuthenticated: true,
        currentUserLoaded: true,
        currentUserId: null,
      }),
    ).toBeNull();
  });

  test("server confirming the same principal keeps trust", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userA",
        isAuthenticated: true,
        currentUserLoaded: true,
        currentUserId: "userA",
      }),
    ).toBe("userA|sess1");
  });

  test("offline (verification never resolves) keeps trust", () => {
    expect(
      localBootTrust({
        accessIdentity: id,
        bootPrincipal: "userA",
        isAuthenticated: true,
        currentUserLoaded: false,
        currentUserId: null,
      }),
    ).toBe("userA|sess1");
  });

  test("no token parses to no trust", () => {
    expect(
      localBootTrust({
        accessIdentity: null,
        bootPrincipal: "userA",
        isAuthenticated: false,
        currentUserLoaded: false,
        currentUserId: null,
      }),
    ).toBeNull();
  });
});

describe("shouldClearMemoryFor", () => {
  test("boot with the same principal must NOT wipe the hydrated cache", () => {
    expect(shouldClearMemoryFor("userA", "userA")).toBe(false);
  });

  test("a different principal becoming trusted wipes the old owner's memory", () => {
    expect(shouldClearMemoryFor("userA", "userB")).toBe(true);
  });

  test("fresh install (no owner) wipes before the first owner installs", () => {
    expect(shouldClearMemoryFor(null, "userA")).toBe(true);
  });

  test("no trusted principal never wipes (sign-out clears explicitly)", () => {
    expect(shouldClearMemoryFor("userA", null)).toBe(false);
  });

  test("owner not read yet defers (render is gated on that read)", () => {
    expect(shouldClearMemoryFor(undefined, "userA")).toBe(false);
  });
});

describe("authRenderDecision", () => {
  test("trusted at boot renders children even while auth is still loading", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: true,
        trustedSubject: "userA|sess1",
        outboxFailureSubject: null,
        isLoading: true,
        isAuthenticated: false,
      }),
    ).toBe("children");
  });

  test("anchor still reading renders blank", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: false,
        trustedSubject: null,
        outboxFailureSubject: null,
        isLoading: true,
        isAuthenticated: false,
      }),
    ).toBe("blank");
  });

  test("untrusted token verifying renders blank (no foreign-cache flash)", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: true,
        trustedSubject: null,
        outboxFailureSubject: null,
        isLoading: false,
        isAuthenticated: true,
      }),
    ).toBe("blank");
  });

  test("signed-out resolution renders children so the login flow can show", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: true,
        trustedSubject: null,
        outboxFailureSubject: null,
        isLoading: false,
        isAuthenticated: false,
      }),
    ).toBe("children");
  });

  test("outbox failure for the trusted subject shows the storage screen", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: true,
        trustedSubject: "userA|sess1",
        outboxFailureSubject: "userA|sess1",
        isLoading: false,
        isAuthenticated: true,
      }),
    ).toBe("storage-failure");
  });

  test("a stale failure from another subject does not block the current one", () => {
    expect(
      authRenderDecision({
        bootPrincipalLoaded: true,
        trustedSubject: "userA|sess2",
        outboxFailureSubject: "userA|sess1",
        isLoading: false,
        isAuthenticated: true,
      }),
    ).toBe("children");
  });
});
