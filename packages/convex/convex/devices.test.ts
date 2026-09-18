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

describe("enqueueStartSession cloud placement chokepoint", () => {
  const USER = "users_1" as any;
  const BOT = "users_bot" as any;
  const CONVERSATION = "conversations_1" as any;
  const host = (user = USER) => ({ _id: `dev_host_${user}`, user_id: user, device_id: `host-${user}`, label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: stale, local_project_roots: ["/home/ubuntu/work/app"] });
  const laptop = (user = USER) => ({ _id: `dev_laptop_${user}`, user_id: user, device_id: `laptop-${user}`, label: "mac", platform: "darwin", is_remote: false, last_seen: fresh, local_project_roots: ["/Users/me/src/app"] });
  const row = (over: Record<string, any> = {}) => ({ _id: CONVERSATION, user_id: USER, session_id: "sess", project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", owner_device_id: `laptop-${USER}`, ...over });
  const db = (conv: any, devices = [host(), laptop()], users: any[] = [{ _id: USER }]) =>
    makeFakeDb({ users, conversations: [conv], devices, daemon_commands: [] });
  const commands = (d: any) => d._tables.daemon_commands.map((c: any) => c.command);

  test("a pending row gets no start_session and its owner stays untouched", async () => {
    const d = db(row({ owner_device_id: `host-${USER}`, cloud_placement: "pending", cloud_placement_token: "t" }));
    expect(await enqueueStartSession({ db: d } as any, USER, { conversationId: CONVERSATION, agentType: "claude", model: "opus" })).toBeNull();
    expect(d._tables.daemon_commands).toEqual([]);
    expect((await d.get(CONVERSATION)).owner_device_id).toBe(`host-${USER}`);
  });

  test("caller=runner + own cloud host + a laptop folder → parked with a cloud_spawn, no start", async () => {
    const d = db(row());
    const id = await enqueueStartSession({ db: d } as any, USER, {
      conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${USER}`, callerUserId: USER,
    });
    expect(id).toBeTruthy();
    expect(commands(d)).toEqual(["cloud_spawn", "release_session"]);
    expect(await d.get(CONVERSATION)).toMatchObject({ owner_device_id: `host-${USER}`, cloud_placement: "pending" });
  });

  test("a row already holding a worktree starts plainly at the host", async () => {
    const d = db(row({ owner_device_id: `host-${USER}`, project_path: "/home/ubuntu/work/app/.codecast/worktrees/x", git_root: "/home/ubuntu/work/app/.codecast/worktrees/x", worktree_path: "/home/ubuntu/work/app/.codecast/worktrees/x" }));
    await enqueueStartSession({ db: d } as any, USER, { conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${USER}`, callerUserId: USER });
    expect(commands(d)).toEqual(["start_session"]);
    expect(d._tables.daemon_commands[0].target_device_id).toBe(`host-${USER}`);
  });

  test("no callerUserId (a relaunch path) keeps the plain start", async () => {
    const d = db(row());
    await enqueueStartSession({ db: d } as any, USER, { conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${USER}` });
    expect(commands(d)).toEqual(["start_session"]);
    expect((await d.get(CONVERSATION)).cloud_placement).toBeUndefined();
  });

  test("a start into the host's own checkout is refused while another session holds it", async () => {
    const held = { _id: "conv_holder", user_id: USER, session_id: "held", short_id: "holder1", title: "shared", owner_device_id: `host-${USER}`, project_path: "/home/ubuntu/work/app", cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/app", status: "active" };
    const native = row({ owner_device_id: `host-${USER}`, project_path: "/home/ubuntu/work/app", git_root: "/home/ubuntu/work/app" });
    const d = makeFakeDb({ users: [{ _id: USER }], conversations: [native, held], devices: [host(), laptop()], daemon_commands: [] });
    expect(await enqueueStartSession({ db: d } as any, USER, { conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${USER}`, callerUserId: USER })).toBeNull();
    expect(commands(d)).toEqual([]);
    expect((await d.get(CONVERSATION)).session_error).toContain("is in use by session holder1");
    // The same start with nobody else in the checkout runs plainly.
    const free = makeFakeDb({ users: [{ _id: USER }], conversations: [native], devices: [host(), laptop()], daemon_commands: [] });
    await enqueueStartSession({ db: free } as any, USER, { conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${USER}`, callerUserId: USER });
    expect(commands(free)).toEqual(["start_session"]);
  });

  test("a bot runner never parks", async () => {
    const d = db(row({ user_id: BOT, owner_device_id: `laptop-${BOT}` }), [host(BOT), laptop(BOT)], [{ _id: BOT, is_bot: true }]);
    await enqueueStartSession({ db: d } as any, BOT, { conversationId: CONVERSATION, agentType: "claude", targetDeviceId: `host-${BOT}`, callerUserId: BOT });
    expect(commands(d)).toEqual(["start_session"]);
  });
});

// The laptop offline→online re-issue of stranded cloud_spawns lives in
// users.daemonHeartbeat (the beat the daemon actually sends) — see
// users.cloudReissue.test.ts. registerDevice is the bare upsert.

describe("moves onto an occupied shared checkout are refused (ct-49428)", () => {
  const USER = "users_1" as any;
  const ROOT = "/home/ubuntu/work/app";
  const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } });
  const holder = (over: Record<string, any> = {}) => ({
    _id: "conv_holder", user_id: USER, session_id: "held", short_id: "holder1", title: "shared", owner_device_id: "box",
    project_path: ROOT, cloud_workspace: "shared", cloud_checkout_path: ROOT, status: "active", ...over,
  });
  const mover = () => ({ _id: "conv_move", user_id: USER, session_id: "moving", short_id: "mover01", owner_device_id: "laptop", project_path: "/Users/me/app", agent_type: "claude_code" });
  const db = (rows: any[]) => makeFakeDb({
    users: [{ _id: USER }],
    devices: [
      { _id: "dev_host", user_id: USER, device_id: "box", label: "Linux - ip-1-2-3-4", platform: "linux", is_remote: true, last_seen: Date.now() },
      { _id: "dev_laptop", user_id: USER, device_id: "laptop", label: "macOS - MacBook-Pro", platform: "darwin", is_remote: false, last_seen: Date.now() },
    ],
    conversations: rows,
    daemon_commands: [],
  });

  test("performMoveSessionToDevice refuses an exact-path occupant on the destination and allows once it is killed", async () => {
    const { performMoveSessionToDevice } = await import("./devices");
    const busy = db([holder(), mover()]);
    await expect(performMoveSessionToDevice(ctx(busy), USER, { conversation_id: "conv_move" as any, owner_device_id: "box", project_path: ROOT }))
      .rejects.toThrow(/is in use by session holder1/);
    expect((await busy.get("conv_move")).owner_device_id).toBe("laptop");
    expect(busy._tables.daemon_commands).toEqual([]);

    const freed = db([holder({ inbox_killed_at: 1 }), mover()]);
    const r = await performMoveSessionToDevice(ctx(freed), USER, { conversation_id: "conv_move" as any, owner_device_id: "box", project_path: ROOT });
    expect(r.ok).toBe(true);
    expect((await freed.get("conv_move")).owner_device_id).toBe("box");
    // A worktree under the root is not the root.
    const beside = db([holder(), mover()]);
    await performMoveSessionToDevice(ctx(beside), USER, { conversation_id: "conv_move" as any, owner_device_id: "box", project_path: `${ROOT}/.codecast/worktrees/x` });
    expect((await beside.get("conv_move")).owner_device_id).toBe("box");
  });

  test("`cast remote back` onto a laptop folder other sessions share is not a checkout move", async () => {
    const { performMoveSessionToDevice } = await import("./devices");
    const LOCAL = "/Users/me/src/app";
    const sibling = { _id: "conv_other", user_id: USER, session_id: "other", short_id: "other01", title: "other", owner_device_id: "laptop", project_path: LOCAL, status: "active" };
    const back = { ...mover(), owner_device_id: "box", project_path: ROOT };
    const store = db([sibling, back]);
    const r = await performMoveSessionToDevice(ctx(store), USER, { conversation_id: "conv_move" as any, owner_device_id: "laptop", project_path: LOCAL });
    expect(r.ok).toBe(true);
    expect((await store.get("conv_move")).owner_device_id).toBe("laptop");
    expect(store._tables.daemon_commands.map((c: any) => c.command)).toEqual(["resume_session", "release_session"]);
  });

  test("moveToRemote refuses on a basename occupant before any command is queued", async () => {
    const { moveToRemote } = await import("./devices");
    const busy = db([holder(), mover()]);
    await expect((moveToRemote as any)._handler(ctx(busy), { conversation_id: "conv_move", to_device_id: "box" })).rejects.toThrow(/is in use by session holder1/);
    expect(busy._tables.daemon_commands).toEqual([]);
    const free = db([holder({ status: "completed" }), mover()]);
    const r = await (moveToRemote as any)._handler(ctx(free), { conversation_id: "conv_move", to_device_id: "box" });
    expect(r.dest).toBe("box");
    expect(free._tables.daemon_commands.map((c: any) => c.command)).toEqual(["move_to_device"]);
  });
});
