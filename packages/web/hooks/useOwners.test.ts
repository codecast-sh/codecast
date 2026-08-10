import { describe, expect, it } from "bun:test";
import { shouldQueryOwners } from "./useOwners";

// listOwners requires auth on the server: it throws for an anonymous caller,
// and a thrown Convex query error crashes the subscribing view. A logged-out
// guest opening a share link mounts ConversationView, whose AssignedToYouBanner
// runs useOwners — so the subscription must be skipped until a current user
// exists. These pin that gate.
const convexId = "a".repeat(32);
const user = { _id: "u1" };

describe("shouldQueryOwners — guests never subscribe to listOwners", () => {
  it("skips without a current user (guest share-link view)", () => {
    expect(shouldQueryOwners(convexId, undefined)).toBe(false);
    expect(shouldQueryOwners(convexId, null)).toBe(false);
    // Control: the same id with a user queries — the auth gate is doing the
    // work, not the id check.
    expect(shouldQueryOwners(convexId, user)).toBe(true);
  });

  it("still skips optimistic stubs and blank ids even when authed", () => {
    expect(shouldQueryOwners("", user)).toBe(false);
    expect(shouldQueryOwners(crypto.randomUUID(), user)).toBe(false);
    expect(shouldQueryOwners("jx7c6zk", user)).toBe(false);
  });
});
