import { describe, expect, it } from "bun:test";
import { pickRoster, shouldQueryOwners } from "./useOwners";

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

// The owner mutations only accept members of the SESSION's team, so the
// picker must offer the server's roster whenever it has answered — the
// injected active-team roster can be a different team entirely (the "isn't a
// member of this session's team" toast). It survives only as warm paint
// while listOwnerCandidates loads.
describe("pickRoster — the session team's roster wins over the viewer's", () => {
  const sessionTeam = [{ _id: "samvit" }];
  const activeTeam = [{ _id: "jason" }];

  it("prefers the server roster once present", () => {
    expect(pickRoster(sessionTeam, activeTeam)).toBe(sessionTeam);
    // An empty server roster is an ANSWER (teamless session seen by a bot
    // runner, say) — it must not fall back to the wrong team's people.
    expect(pickRoster([], activeTeam)).toEqual([]);
  });

  it("falls back to the injected roster while loading or on an old server", () => {
    expect(pickRoster(undefined, activeTeam)).toBe(activeTeam);
    expect(pickRoster(undefined, undefined)).toEqual([]);
  });
});
