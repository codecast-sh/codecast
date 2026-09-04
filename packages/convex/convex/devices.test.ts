import { describe, expect, test } from "bun:test";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { enqueueStartSession, planConversationOwnershipClaim, resolveOwnerDeviceView } from "./devices";
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

describe("enqueueStartSession codecast default model", () => {
  const USER = "users_1" as any;
  const CONVERSATION = "conversations_1" as any;

  const seed = (userExtra: Record<string, any>, convExtra: Record<string, any> = {}) =>
    makeFakeDb({
      users: [{ _id: USER, ...userExtra }],
      conversations: [{ _id: CONVERSATION, user_id: USER, project_path: "/work/project", ...convExtra }],
      devices: [],
      daemon_commands: [],
    });

  const commandModel = (db: any) => JSON.parse(db._tables.daemon_commands[0].args).model;

  test("no explicit model → user default rides the command and stamps the badge", async () => {
    const db = seed({ default_models: { claude: "fable" } });
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude" });
    expect(commandModel(db)).toBe("fable");
    expect(db._tables.conversations[0].model).toBe("claude-fable");
  });

  test("explicit per-session model wins over the default", async () => {
    const db = seed({ default_models: { claude: "fable" } });
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude", model: "sonnet" });
    expect(commandModel(db)).toBe("sonnet");
  });

  test("a conversation with a known model keeps its badge", async () => {
    const db = seed({ default_models: { claude: "fable" } }, { model: "claude-sonnet" });
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude" });
    expect(commandModel(db)).toBe("fable");
    expect(db._tables.conversations[0].model).toBe("claude-sonnet");
  });

  test("no default → no model on the command (agent's own default decides)", async () => {
    const db = seed({});
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude" });
    expect(commandModel(db)).toBeUndefined();
    expect(db._tables.conversations[0].model).toBeUndefined();
  });

  test("unlaunchable default (menu key) is ignored", async () => {
    const db = seed({ default_models: { claude: "menu:Sonnet (1M context)" } });
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude" });
    expect(commandModel(db)).toBeUndefined();
  });

  test("default is per client: codex default doesn't leak onto a claude launch", async () => {
    const db = seed({ default_models: { codex: "gpt-5.5" } });
    await enqueueStartSession({ db } as any, USER, { conversationId: CONVERSATION, agentType: "claude" });
    expect(commandModel(db)).toBeUndefined();
  });
});

describe("enqueueStartSession Claude account token", () => {
  const USER = "users_1" as any;
  const CONVERSATION = "conversations_1" as any;
  const DEVICE = "local-1";

  const seed = (profiles: any[]) =>
    makeFakeDb({
      users: [{ _id: USER }],
      conversations: [{
        _id: CONVERSATION,
        user_id: USER,
        project_path: "/work/project",
        owner_device_id: DEVICE,
      }],
      devices: [{
        _id: "device_1",
        user_id: USER,
        device_id: DEVICE,
        label: "Mac",
        last_seen: Date.now(),
        cc_session_tokens: false,
        cc_accounts: { active_email: "a@x.com", profiles },
      }],
      daemon_commands: [],
    });

  test("pins a new Claude session whenever the active account has a live token", async () => {
    const db = seed([{
      name: "account-a",
      email: "a@x.com",
      token: { stored_at: 1, expires_at: Date.now() + 60_000 },
    }]);

    await enqueueStartSession({ db } as any, USER, {
      conversationId: CONVERSATION,
      agentType: "claude",
    });

    expect(JSON.parse(db._tables.daemon_commands[0].args).cc_account).toBe("account-a");
    expect(db._tables.conversations[0].cc_account).toBe("account-a");
  });

  test("falls back to the keychain when the active account has no live token", async () => {
    const db = seed([{ name: "account-a", email: "a@x.com" }]);

    await enqueueStartSession({ db } as any, USER, {
      conversationId: CONVERSATION,
      agentType: "claude",
    });

    expect(JSON.parse(db._tables.daemon_commands[0].args).cc_account).toBeUndefined();
    expect(db._tables.conversations[0].cc_account).toBeUndefined();
  });
});

describe("resolveOwnerDeviceView", () => {
  // A session Mr Bot's account RUNS (conv.user_id) but Ashot OWNS. The device
  // row lives under the runner, so a lookup scoped to the viewer finds nothing
  // and reports the live owner as offline — which every caller reads as
  // "unowned" and proceeds past the guard.
  const RUNNER = "user-mrbot";
  const VIEWER = "user-ashot";
  const secondPartyDb = (lastSeen: number) =>
    makeFakeDb({
      devices: [
        { user_id: RUNNER, device_id: "ec2-mac", is_remote: true, last_seen: lastSeen },
        { user_id: VIEWER, device_id: "laptop", is_remote: false, last_seen: fresh },
      ],
    });

  test("finds the owner device under the runner, not the viewer", async () => {
    const db = secondPartyDb(fresh);
    expect(
      await resolveOwnerDeviceView(
        { db } as any,
        { user_id: RUNNER, owner_device_id: "ec2-mac" },
        NOW,
      ),
    ).toEqual({ owner_device_id: "ec2-mac", owner_is_remote: true, owner_online: true });
  });

  test("a stale owner still resolves, just offline", async () => {
    const db = secondPartyDb(stale);
    expect(
      await resolveOwnerDeviceView(
        { db } as any,
        { user_id: RUNNER, owner_device_id: "ec2-mac" },
        NOW,
      ),
    ).toEqual({ owner_device_id: "ec2-mac", owner_is_remote: true, owner_online: false });
  });

  test("an unowned conversation reports no device", async () => {
    const db = secondPartyDb(fresh);
    expect(
      await resolveOwnerDeviceView({ db } as any, { user_id: RUNNER }, NOW),
    ).toEqual({ owner_device_id: null, owner_is_remote: false, owner_online: false });
  });

  test("keeps the owner id when the device row is missing entirely", async () => {
    const db = makeFakeDb({ devices: [] });
    expect(
      await resolveOwnerDeviceView(
        { db } as any,
        { user_id: RUNNER, owner_device_id: "ec2-mac" },
        NOW,
      ),
    ).toEqual({ owner_device_id: "ec2-mac", owner_is_remote: false, owner_online: false });
  });
});
