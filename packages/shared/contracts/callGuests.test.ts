import { describe, expect, test } from "bun:test";
import {
  callParticipantKind,
  callSpeakerName,
  guestDisplayName,
  guestIdFromIdentity,
  guestIdentity,
  guestJoinPath,
  guestMayJoin,
  isGuestIdentity,
  normalizeGuestName,
  GUEST_NAME_MAX,
} from "./callGuests";
import { agentFaceIdentity } from "./callRoomKeys";

describe("guest identities", () => {
  test("round trip through the LiveKit identity", () => {
    const id = guestIdentity("k17guest");
    expect(id).toBe("guest:k17guest");
    expect(isGuestIdentity(id)).toBe(true);
    expect(guestIdFromIdentity(id)).toBe("k17guest");
  });

  test("teammates, agent faces and a bare prefix are not guests", () => {
    for (const other of ["k17user", agentFaceIdentity("conv1"), "guest:", "", "Guest:x", null, undefined]) {
      expect(isGuestIdentity(other as any)).toBe(false);
      expect(guestIdFromIdentity(other as any)).toBeNull();
    }
  });

  test("one classifier tells all three apart", () => {
    expect(callParticipantKind("k17user")).toBe("person");
    expect(callParticipantKind(guestIdentity("g1"))).toBe("guest");
    expect(callParticipantKind(agentFaceIdentity("c1"))).toBe("agent");
  });
});

describe("guest names", () => {
  test("whitespace and control characters collapse, and an empty name is refused", () => {
    expect(normalizeGuestName("  Ada \n Lovelace\t")).toBe("Ada Lovelace");
    expect(normalizeGuestName("Ada​Lovelace")).toBe("Ada Lovelace");
    expect(normalizeGuestName("Ada‮ecalevol")).toBe("Ada ecalevol");
    expect(normalizeGuestName("   ")).toBeNull();
    expect(normalizeGuestName(null)).toBeNull();
  });

  test("the guest marking is the room's to add, never typed in", () => {
    expect(normalizeGuestName("Sam (guest)")).toBe("Sam");
    expect(normalizeGuestName("Sam(Guest) (guest)")).toBe("Sam");
    expect(callSpeakerName(guestIdentity("g1"), normalizeGuestName("Sam (guest)"))).toBe("Sam (guest)");
    expect(normalizeGuestName("(guest)")).toBeNull();
    expect(normalizeGuestName("Guest Lecturer")).toBe("Guest Lecturer");
  });

  test("capped by characters, never splitting one", () => {
    const long = "😀".repeat(GUEST_NAME_MAX + 5);
    expect(Array.from(normalizeGuestName(long)!)).toHaveLength(GUEST_NAME_MAX);
  });

  test("a guest is marked wherever the room reads names, and in the transcript's words", () => {
    expect(guestDisplayName("Ada")).toBe("Ada (guest)");
    expect(guestDisplayName("")).toBe("Guest (guest)");
    expect(callSpeakerName(guestIdentity("g1"), " Ada ")).toBe("Ada (guest)");
    expect(callSpeakerName("k17user", "Sam")).toBe("Sam");
    expect(callSpeakerName("k17user", "")).toBe("Someone");
  });
});

describe("guest lifecycle", () => {
  test("only an admitted guest may hold a media token", () => {
    expect(guestMayJoin("admitted")).toBe(true);
    for (const s of ["waiting", "denied", "removed", "left"] as const) expect(guestMayJoin(s)).toBe(false);
  });

  test("a guest link opens its own page, not the team invite page", () => {
    expect(guestJoinPath("abc123")).toBe("/meet/abc123");
  });
});
