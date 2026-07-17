import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performReassignToDevice, performReparentSessionToDevice } from "./devices";

// Cross-user device reparent: an OWNER pulls a session run by a TEAMMATE onto
// their OWN machine. Account follows device (user_id -> caller), the immutable
// author is pinned (author_user_id), owners are untouched.
const JASON = "u".repeat(31) + "j"; // original runner/author
const ME = "u".repeat(31) + "m"; // owner + caller
const STRANGER = "u".repeat(31) + "s";

function fixtures(convOverrides: Record<string, any> = {}, ownerRows: any[] = [{ _id: "so1", conversation_id: "conv1", user_id: ME }]) {
  return makeFakeDb({
    users: [
      { _id: JASON, name: "Jason", email: "jason@x.ai" },
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: STRANGER, name: "Stranger", email: "s@x.ai" },
    ],
    devices: [
      { _id: "d1", user_id: ME, device_id: "mydev", label: "My-MacBook" },
      { _id: "d2", user_id: JASON, device_id: "jasondev", label: "Jason-MacBook" },
    ],
    conversations: [
      {
        _id: "conv1",
        session_id: "sess1",
        user_id: JASON,
        owner_user_id: ME,
        owner_device_id: "jasondev",
        project_path: "/Users/jason/repo",
        status: "active",
        ...convOverrides,
      },
    ],
    session_owners: ownerRows,
  });
}

const conv = (db: any) => db._tables.conversations.find((c: any) => c._id === "conv1");
const commands = (db: any) => db._tables.daemon_commands ?? db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);

describe("performReparentSessionToDevice", () => {
  test("owner pulls a teammate's session onto their own device — account follows device, author pinned", async () => {
    const db = fixtures();
    const result = await performReparentSessionToDevice({ db }, ME as any, {
      session_id: "sess1",
      device_id: "mydev",
    });

    expect(result.cross_user).toBe(true);
    expect(conv(db).user_id).toBe(ME); // now runs + bills under the caller
    expect(conv(db).author_user_id).toBe(JASON); // immutable author pinned to the pre-move runner
    expect(conv(db).owner_device_id).toBe("mydev");
    // Resume enqueued in the CALLER's queue, targeted at the caller's device.
    const cmds = commands(db);
    expect(cmds.length).toBe(1);
    expect(cmds[0].user_id).toBe(ME);
    expect(cmds[0].command).toBe("resume_session");
    expect(cmds[0].target_device_id).toBe("mydev");
    expect(JSON.parse(cmds[0].args).reparented).toBe(true);
  });

  test("the managed-session row is handed over: stale source-account rows are dropped", async () => {
    const db = fixtures();
    db._tables.managed_sessions = [
      // Source machine's row — its daemon keeps heartbeating this after the
      // move, which hid tmux/liveness from the new runner and blocked the
      // destination daemon's register behind the cross-user reclaim guard.
      { _id: "ms1", session_id: "sess1", conversation_id: "conv1", user_id: JASON, pid: 1, tmux_session: "cc-old", last_heartbeat: Date.now() },
      // A second stale row keyed only by conversation (fork/resume drift).
      { _id: "ms2", session_id: "sess1-old", conversation_id: "conv1", user_id: JASON, pid: 2, last_heartbeat: 0 },
      // Unrelated row survives.
      { _id: "ms3", session_id: "other", conversation_id: "convX", user_id: JASON, pid: 3, last_heartbeat: 0 },
    ];
    await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
    expect(db._tables.managed_sessions.map((r: any) => r._id)).toEqual(["ms3"]);
  });

  test("owners are untouched by a device reparent (axes are independent)", async () => {
    const db = fixtures();
    await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([ME]);
  });

  test("author pin is set once — a later cross-account move never overwrites it", async () => {
    const ORIG = "u".repeat(31) + "o";
    const db = fixtures({ author_user_id: ORIG });
    await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
    expect(conv(db).author_user_id).toBe(ORIG); // not overwritten to JASON
  });

  test("same-user reparent (runner onto their own device) does not change account or pin an author", async () => {
    const db = fixtures({ user_id: ME }); // I already run it
    const result = await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
    expect(result.cross_user).toBe(false);
    expect(conv(db).user_id).toBe(ME);
    expect(conv(db).author_user_id).toBeUndefined();
    expect(conv(db).owner_device_id).toBe("mydev");
  });

  test("a user who neither runs nor owns the session may not reparent it", async () => {
    const db = fixtures({}, []); // no owner rows
    db._tables.conversations[0].owner_user_id = undefined;
    // give STRANGER a device so the failure is the AUTH check, not the device check
    db._tables.devices.push({ _id: "d3", user_id: STRANGER, device_id: "strangerdev", label: "S" });
    await expect(
      performReparentSessionToDevice({ db }, STRANGER as any, { session_id: "sess1", device_id: "strangerdev" }),
    ).rejects.toThrow(/run or own/);
  });

  test("you may only reparent onto your OWN device, not the source machine's", async () => {
    const db = fixtures();
    await expect(
      performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "jasondev" }),
    ).rejects.toThrow(/Unknown device/);
    // nothing moved
    expect(conv(db).user_id).toBe(JASON);
    expect(conv(db).owner_device_id).toBe("jasondev");
  });

  // The destination composes the agent's reorientation notice from what it can
  // verify locally, but it cannot see the machine the session left — and across
  // an account boundary it has no access to it at all. These facts are the ones
  // only the server knows, so they ride the resume command.
  describe("reorientation facts on the resume command", () => {
    const argsOf = (db: any) => JSON.parse(commands(db)[0].args);

    test("a cross-account pull names both users and the machine it came from", async () => {
      const db = fixtures();
      await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
      const a = argsOf(db);
      expect(a.cross_user).toBe(true);
      expect(a.from_user).toBe("Jason");
      expect(a.to_user).toBe("Me");
      expect(a.from_device).toBe("Jason-MacBook");
      expect(a.device_changed).toBe(true);
    });

    test("a same-user pull carries no account facts — nothing changed hands", async () => {
      const db = fixtures({ user_id: ME });
      await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
      const a = argsOf(db);
      expect(a.cross_user).toBeUndefined();
      expect(a.from_user).toBeUndefined();
      expect(a.to_user).toBeUndefined();
      // The machine still changed, so the move itself is still reported.
      expect(a.device_changed).toBe(true);
    });

    test("pulling onto the device it already runs on reports no machine change", async () => {
      const db = fixtures({ user_id: ME, owner_device_id: "mydev" });
      await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
      const a = argsOf(db);
      expect(a.device_changed).toBe(false);
      expect(a.from_device).toBeUndefined();
    });

    test("falls back to email when a user has no display name", async () => {
      const db = fixtures();
      db._tables.users.find((u: any) => u._id === JASON).name = undefined;
      await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
      expect(argsOf(db).from_user).toBe("jason@x.ai");
    });

    test("an unknown source device omits the label rather than inventing one", async () => {
      const db = fixtures({ owner_device_id: "vanished" });
      await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
      const a = argsOf(db);
      expect(a.device_changed).toBe(true);
      expect(a.from_device).toBeUndefined();
    });
  });
});

// The web/mobile "Run on this device" control calls reassignToDevice for every
// session in the inbox — including ones the caller owns but a teammate runs.
// Those must take the cross-user reparent path instead of failing with "not
// your conversation" (the bug this covers).
describe("performReassignToDevice", () => {
  test("same-user move keeps the plain restamp path — no reparented flag, no account change", async () => {
    const db = fixtures({ user_id: ME });
    const result = await performReassignToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      device_id: "mydev",
    });
    expect(result.cross_user).toBeUndefined();
    expect(conv(db).user_id).toBe(ME);
    expect(conv(db).owner_device_id).toBe("mydev");
    const cmds = commands(db);
    expect(cmds.length).toBe(1);
    expect(JSON.parse(cmds[0].args).reparented).toBeUndefined();
  });

  test("owner-but-not-runner move delegates to the cross-user reparent", async () => {
    const db = fixtures();
    const result = await performReassignToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      device_id: "mydev",
    });
    expect(result.cross_user).toBe(true);
    expect(conv(db).user_id).toBe(ME); // account followed the device
    expect(conv(db).author_user_id).toBe(JASON);
    expect(conv(db).owner_device_id).toBe("mydev");
    expect(JSON.parse(commands(db)[0].args).reparented).toBe(true);
  });

  test("a stranger (neither runner nor owner) is still rejected", async () => {
    const db = fixtures({}, []);
    db._tables.conversations[0].owner_user_id = undefined;
    db._tables.devices.push({ _id: "d3", user_id: STRANGER, device_id: "strangerdev", label: "S" });
    await expect(
      performReassignToDevice({ db }, STRANGER as any, {
        conversation_id: "conv1" as any,
        device_id: "strangerdev",
      }),
    ).rejects.toThrow(/run or own/);
  });
});

// The resume command must carry the conversation's real agent client so the
// daemon resumes with the right binary. Before the fromConvexAgentType fix, a
// cursor conversation's agent_type collapsed to "claude" here and the daemon
// built `claude --resume` instead of `cursor-agent --resume`.
describe("resume command carries the agent client", () => {
  const agentTypeOf = (db: any) => JSON.parse(commands(db)[0].args).agent_type;

  test("a cursor conversation resumes as cursor, not claude", async () => {
    const db = fixtures({ user_id: ME, agent_type: "cursor" });
    await performReassignToDevice({ db }, ME as any, { conversation_id: "conv1" as any, device_id: "mydev" });
    expect(agentTypeOf(db)).toBe("cursor");
  });

  test("codex and gemini pass through unchanged", async () => {
    const codexDb = fixtures({ user_id: ME, agent_type: "codex" });
    await performReassignToDevice({ db: codexDb }, ME as any, { conversation_id: "conv1" as any, device_id: "mydev" });
    expect(agentTypeOf(codexDb)).toBe("codex");

    const geminiDb = fixtures({ user_id: ME, agent_type: "gemini" });
    await performReassignToDevice({ db: geminiDb }, ME as any, { conversation_id: "conv1" as any, device_id: "mydev" });
    expect(agentTypeOf(geminiDb)).toBe("gemini");
  });

  test("claude_code and cowork resume as claude", async () => {
    const claudeDb = fixtures({ user_id: ME, agent_type: "claude_code" });
    await performReassignToDevice({ db: claudeDb }, ME as any, { conversation_id: "conv1" as any, device_id: "mydev" });
    expect(agentTypeOf(claudeDb)).toBe("claude");

    const coworkDb = fixtures({ user_id: ME, agent_type: "cowork" });
    await performReassignToDevice({ db: coworkDb }, ME as any, { conversation_id: "conv1" as any, device_id: "mydev" });
    expect(agentTypeOf(coworkDb)).toBe("claude");
  });

  test("the cross-user reparent path carries cursor through too", async () => {
    const db = fixtures({ agent_type: "cursor" });
    await performReparentSessionToDevice({ db }, ME as any, { session_id: "sess1", device_id: "mydev" });
    expect(agentTypeOf(db)).toBe("cursor");
  });
});
