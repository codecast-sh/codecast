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

  test("the display name the UI shows resolves too: --device \"cloud linux\"", () => {
    const withHost = [
      ...devices,
      { device_id: "dev-host-4", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true },
      { device_id: "dev-mini-5", label: "macOS - mini", platform: "darwin", is_remote: true },
    ];
    expect(resolveDeviceSelector(withHost, "cloud linux")).toBe("dev-host-4");
    expect(resolveDeviceSelector(withHost, "Cloud Linux")).toBe("dev-host-4");
    expect(resolveDeviceSelector(withHost, "remote mac")).toBe("dev-mini-5");
    // The stored label still resolves as before.
    expect(resolveDeviceSelector(withHost, "linux - ip-172-31-40-243")).toBe("dev-host-4");
  });

  test("a stored label wins over another machine's display name", () => {
    const collision = [
      { device_id: "dev-host-4", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true },
      { device_id: "dev-laptop-1", label: "Cloud Linux", platform: "darwin", is_remote: false },
    ];
    expect(resolveDeviceSelector(collision, "cloud linux")).toBe("dev-laptop-1");
  });

  test("a display name never resolves to a team agent box, and a box still resolves by id/label", () => {
    const mine = [{ device_id: "dev-laptop-1", label: "Nose", platform: "darwin", is_remote: false }];
    const boxes = [{ device_id: "dev-box-9", label: "Linux - ip-10-0-0-9", platform: "linux", is_remote: true }];
    expect(() => resolveDeviceSelector(mine, "Cloud Linux", boxes)).toThrow('Unknown device "Cloud Linux"');
    expect(resolveDeviceSelector(mine, "dev-box-9", boxes)).toBe("dev-box-9");
    expect(resolveDeviceSelector(mine, "linux - ip-10-0-0-9", boxes)).toBe("dev-box-9");
    // With a host of their own the name resolves to THAT one, box or no box.
    const withHost = [...mine, { device_id: "dev-host-4", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true }];
    expect(resolveDeviceSelector(withHost, "Cloud Linux", boxes)).toBe("dev-host-4");
  });

  test("a display name shared by two of the user's devices is ambiguous and names the ids", () => {
    const twoHosts = [
      { device_id: "dev-host-4", label: "Linux - ip-172-31-40-243", platform: "linux", is_remote: true },
      { device_id: "dev-host-5", label: "Linux - ip-172-31-40-244", platform: "linux", is_remote: true },
    ];
    expect(() => resolveDeviceSelector(twoHosts, "Cloud Linux")).toThrow('"Cloud Linux" names 2 of your devices — use the device id: dev-host-4, dev-host-5');
    expect(resolveDeviceSelector(twoHosts, "dev-host-5")).toBe("dev-host-5");
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
