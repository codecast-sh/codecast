import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performMoveSessionToDevice, moveToRemote } from "./devices";
import { MACHINE_SWITCH_NOTICE_PREFIX } from "@codecast/shared/contracts";

// The CLI transfer flip (`cast remote move` / `back`). The files are already on
// the destination; this re-homes ownership, resumes there, and — the part that
// was missing — releases the machine that ran it before, so a cloud box does
// not keep a claude alive (and itself awake) after the session has left.
const ME = "u".repeat(31) + "m";
const LAPTOP = "laptopdev";
const BOX = "boxdev";

function fixtures(convOverrides: Record<string, any> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    devices: [
      { _id: "d1", user_id: ME, device_id: LAPTOP, label: "My-MacBook", platform: "darwin", last_seen: Date.now() },
      { _id: "d2", user_id: ME, device_id: BOX, label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true, last_seen: Date.now() },
    ],
    conversations: [
      {
        _id: "conv1",
        session_id: "sess1",
        user_id: ME,
        owner_device_id: LAPTOP,
        project_path: "/Users/me/src/repo",
        status: "active",
        ...convOverrides,
      },
    ],
  });
}

const conv = (db: any) => db._tables.conversations.find((c: any) => c._id === "conv1");
const commands = (db: any) => db._tables.daemon_commands ?? db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);

describe("performMoveSessionToDevice", () => {
  test("moving to the box resumes THERE and releases the laptop", async () => {
    const db = fixtures();
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: BOX,
      project_path: "/home/ubuntu/work/repo",
    });
    expect(conv(db).owner_device_id).toBe(BOX);
    expect(conv(db).project_path).toBe("/home/ubuntu/work/repo");
    const cmds = commands(db);
    expect(cmds.map((c: any) => [c.command, c.target_device_id])).toEqual([
      ["resume_session", BOX],
      ["release_session", LAPTOP],
    ]);
    expect(JSON.parse(cmds[1].args)).toEqual({ conversation_id: "conv1", session_id: "sess1" });
  });

  test("bringing it back releases the box — the return trip is what leaked", async () => {
    const db = fixtures({ owner_device_id: BOX, project_path: "/home/ubuntu/work/repo" });
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: LAPTOP,
      project_path: "/Users/me/src/repo",
    });
    const cmds = commands(db);
    expect(cmds.map((c: any) => [c.command, c.target_device_id])).toEqual([
      ["resume_session", LAPTOP],
      ["release_session", BOX],
    ]);
  });

  test("no previous owner, nothing to release", async () => {
    const db = fixtures({ owner_device_id: undefined });
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: BOX,
      project_path: "/home/ubuntu/work/repo",
    });
    expect(commands(db).map((c: any) => c.command)).toEqual(["resume_session"]);
  });

  test("re-homing to the device that already owns it releases nobody", async () => {
    const db = fixtures();
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: LAPTOP,
      project_path: "/Users/me/src/repo",
    });
    expect(commands(db).map((c: any) => c.command)).toEqual(["resume_session"]);
  });

  test("resume: false still releases the previous owner", async () => {
    const db = fixtures();
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: BOX,
      project_path: "/home/ubuntu/work/repo",
      resume: false,
    });
    expect(commands(db).map((c: any) => [c.command, c.target_device_id])).toEqual([["release_session", LAPTOP]]);
  });

  test("a box switch inserts a now-running-on notice", async () => {
    const db = fixtures();
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: BOX,
      project_path: "/home/ubuntu/work/repo",
    });
    const notices = (db._tables.messages ?? []).filter((m: any) => m.subtype === "machine_switch");
    expect(notices).toHaveLength(1);
    expect(notices[0].content.startsWith(MACHINE_SWITCH_NOTICE_PREFIX)).toBe(true);
    expect(notices[0].content).toContain("Cloud Linux");
    expect(notices[0].content).toContain("My-MacBook");
  });

  test("Move to Cloud Linux inserts the divider as soon as the picker fires", async () => {
    const db = fixtures();
    const ctx: any = { db, auth: { getUserIdentity: async () => ({ subject: `${ME}|sess`, tokenIdentifier: "x" }) } };
    const handler = (moveToRemote as any)._handler ?? (moveToRemote as any).handler;
    await handler(ctx, { conversation_id: "conv1", to_device_id: BOX });
    const notices = (db._tables.messages ?? []).filter((m: any) => m.subtype === "machine_switch");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("Cloud Linux");
    expect(notices[0].content).toContain("My-MacBook");
  });

  test("re-homing onto the same box inserts nothing", async () => {
    const db = fixtures();
    await performMoveSessionToDevice({ db }, ME as any, {
      conversation_id: "conv1" as any,
      owner_device_id: LAPTOP,
      project_path: "/Users/me/src/repo",
    });
    expect((db._tables.messages ?? []).filter((m: any) => m.subtype === "machine_switch")).toHaveLength(0);
  });

  test("someone else's conversation is refused", async () => {
    const db = fixtures({ user_id: "u".repeat(31) + "x" });
    await expect(
      performMoveSessionToDevice({ db }, ME as any, {
        conversation_id: "conv1" as any,
        owner_device_id: BOX,
        project_path: "/home/ubuntu/work/repo",
      }),
    ).rejects.toThrow("not your conversation");
  });
});
