import { describe, expect, test } from "bun:test";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { planConversationOwnershipClaim } from "./devices";

const NOW = 1_000_000_000;
const fresh = NOW - 10_000;
const stale = NOW - DEVICE_ONLINE_MS - 1;

describe("planConversationOwnershipClaim", () => {
  test("allows unowned and same-owner claims", () => {
    expect(planConversationOwnershipClaim({
      claimantDeviceId: "local-a",
      now: NOW,
    })).toEqual({ won: true });

    expect(planConversationOwnershipClaim({
      ownerDeviceId: "local-a",
      claimantDeviceId: "local-a",
      now: NOW,
    })).toEqual({ won: true });
  });

  test("blocks stealing from a live local owner", () => {
    expect(planConversationOwnershipClaim({
      ownerDeviceId: "local-a",
      claimantDeviceId: "local-b",
      ownerDevice: { is_remote: false, last_seen: fresh },
      claimantDevice: { is_remote: false, last_seen: fresh },
      now: NOW,
    })).toEqual({ won: false, owner: "local-a" });
  });

  test("allows reclaim from an offline local owner or a remote owner", () => {
    expect(planConversationOwnershipClaim({
      ownerDeviceId: "local-a",
      claimantDeviceId: "local-b",
      ownerDevice: { is_remote: false, last_seen: stale },
      claimantDevice: { is_remote: false, last_seen: fresh },
      now: NOW,
    })).toEqual({ won: true });

    expect(planConversationOwnershipClaim({
      ownerDeviceId: "remote-a",
      claimantDeviceId: "local-b",
      ownerDevice: { is_remote: true, last_seen: fresh },
      claimantDevice: { is_remote: false, last_seen: fresh },
      now: NOW,
    })).toEqual({ won: true });
  });

  test("prevents a remote device from auto-claiming unless it already owns the conversation", () => {
    expect(planConversationOwnershipClaim({
      claimantDeviceId: "remote-a",
      claimantDevice: { is_remote: true, last_seen: fresh },
      now: NOW,
    })).toEqual({ won: false, owner: undefined });

    expect(planConversationOwnershipClaim({
      claimantDeviceId: "remote-a",
      claimantIsRemote: true,
      now: NOW,
    })).toEqual({ won: false, owner: undefined });

    expect(planConversationOwnershipClaim({
      ownerDeviceId: "local-a",
      claimantDeviceId: "remote-a",
      ownerDevice: { is_remote: false, last_seen: stale },
      claimantDevice: { is_remote: true, last_seen: fresh },
      now: NOW,
    })).toEqual({ won: false, owner: "local-a" });

    expect(planConversationOwnershipClaim({
      ownerDeviceId: "local-a",
      claimantDeviceId: "remote-a",
      ownerDevice: { is_remote: false, last_seen: stale },
      claimantIsRemote: true,
      now: NOW,
    })).toEqual({ won: false, owner: "local-a" });
  });
});
