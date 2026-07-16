import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performReparentSessionToDevice } from "./devices";

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
