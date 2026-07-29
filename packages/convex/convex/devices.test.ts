import { describe, expect, test } from "bun:test";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { enqueueStartSession, planConversationOwnershipClaim } from "./devices";
import { makeFakeDb } from "./testDb";

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

describe("enqueueStartSession execution-protocol gate", () => {
  const USER = "users_1" as any;
  const CONVERSATION = "conversations_1" as any;

  const conversation = (execution_protocol_state?: string) => ({
    _id: CONVERSATION,
    user_id: USER,
    project_path: "/work/project",
    ...(execution_protocol_state ? { execution_protocol_state } : {}),
  });

  test.each(["fenced", "legacy-quiescing"])(
    "refuses to emit a legacy start for a %s conversation",
    async (state) => {
      const db = makeFakeDb({
        conversations: [conversation(state)],
        devices: [],
        daemon_commands: [],
      });
      await expect(
        enqueueStartSession({ db } as any, USER, {
          conversationId: CONVERSATION,
          agentType: "claude",
        }),
      ).rejects.toThrow("EXECUTION_PROTOCOL_LEGACY_START_REFUSED");
      expect(db._tables.daemon_commands).toEqual([]);
    },
  );

  test("still emits for a legacy conversation", async () => {
    const db = makeFakeDb({
      conversations: [conversation()],
      devices: [],
      daemon_commands: [],
    });
    await enqueueStartSession({ db } as any, USER, {
      conversationId: CONVERSATION,
      agentType: "claude",
    });
    expect(db._tables.daemon_commands).toHaveLength(1);
    expect(db._tables.daemon_commands[0].command).toBe("start_session");
  });
});
