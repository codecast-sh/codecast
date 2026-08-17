import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { resolveDeviceSelector, resolveSpawnParent } from "./spawn";

const devices = [
  { device_id: "dev-laptop-1", label: "Nose" },
  { device_id: "dev-remote-2", label: "mac mini" },
  { device_id: "dev-bare-3" },
];

describe("resolveDeviceSelector — cast spawn --device", () => {
  test("matches a device_id exactly", () => {
    expect(resolveDeviceSelector(devices, "dev-remote-2")).toBe("dev-remote-2");
  });

  test("matches a label case-insensitively", () => {
    expect(resolveDeviceSelector(devices, "nose")).toBe("dev-laptop-1");
    expect(resolveDeviceSelector(devices, "Mac Mini")).toBe("dev-remote-2");
  });

  test("a device_id wins over another machine's identical label", () => {
    const shadowed = [
      { device_id: "dev-bare-3", label: "workhorse" },
      { device_id: "dev-laptop-1", label: "dev-bare-3" },
    ];
    expect(resolveDeviceSelector(shadowed, "dev-bare-3")).toBe("dev-bare-3");
  });

  test("unknown value throws and names the devices the user has", () => {
    expect(() => resolveDeviceSelector(devices, "noze")).toThrow(
      'Unknown device "noze". Your devices: Nose, mac mini, dev-bare-3',
    );
  });

  test("no registered devices still gives an actionable message", () => {
    expect(() => resolveDeviceSelector([], "nose")).toThrow("(none registered)");
  });
});

// resolveSpawnParent — cast spawn --subagent. The contract: the parent must be
// one of the caller's own sessions, both link fields come back together
// (parent_conversation_id nests the row, is_subagent makes it self-identify on
// every emission path), and an unresolved ref throws rather than silently
// producing a first-class inbox card.
describe("resolveSpawnParent — cast spawn --subagent", () => {
  const OWNER = "u_owner";
  const OTHER = "u_other";
  const PARENT = {
    _id: "conv-parent-1",
    user_id: OWNER,
    session_id: "11111111-2222-3333-4444-555555555555",
    short_id: "conv-pa",
  };
  const FOREIGN = {
    _id: "conv-foreign-1",
    user_id: OTHER,
    session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    short_id: "conv-fo",
  };

  const ctx = () =>
    ({ db: makeFakeDb({ conversations: [PARENT, FOREIGN], managed_sessions: [] }) }) as any;

  test("resolves the caller's session by its session UUID (detectCurrentSessionId shape)", async () => {
    expect(await resolveSpawnParent(ctx(), OWNER as any, PARENT.session_id)).toEqual({
      parent_conversation_id: PARENT._id as any,
      is_subagent: true,
    });
  });

  test("resolves by short_id", async () => {
    expect(await resolveSpawnParent(ctx(), OWNER as any, PARENT.short_id)).toEqual({
      parent_conversation_id: PARENT._id as any,
      is_subagent: true,
    });
  });

  test("another user's session is not a valid parent", async () => {
    await expect(resolveSpawnParent(ctx(), OWNER as any, FOREIGN.session_id)).rejects.toThrow(
      "not found among your sessions",
    );
  });

  test("an unknown ref throws instead of falling back to a first-class spawn", async () => {
    await expect(resolveSpawnParent(ctx(), OWNER as any, "nope-nope")).rejects.toThrow(
      'Parent session "nope-nope" not found',
    );
  });
});
