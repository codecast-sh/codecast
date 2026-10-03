import { describe, expect, test } from "bun:test";
import {
  guestLinkRefusal,
  GUEST_JOIN_REFUSAL_TEXT,
  GUEST_LINK_REFUSAL_TEXT,
  guestJoinRefusalOf,
  callParticipantKind,
  isRoomMachineryKind,
  guestNoticeLines,
  guestNoticeSentence,
  callSpeakerName,
  guestDisplayName,
  guestIdFromIdentity,
  guestIdentity,
  guestJoinPath,
  guestMayJoin,
  isGuestIdentity,
  normalizeGuestName,
  isGuestPresent,
  GUEST_ADMISSION_LAPSE_MS,
  GUEST_NAME_MAX,
} from "./callGuests";
import { CALL_MEMBER_STALE_MS } from "./callRoomKeys";
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

  test("a recording's egress and the agent-face worker are machinery; people, guests and faces are not", () => {
    // LiveKit ParticipantInfo.Kind: STANDARD 0, INGRESS 1, EGRESS 2, SIP 3, AGENT 4.
    expect(isRoomMachineryKind(2)).toBe(true);
    expect(isRoomMachineryKind(4)).toBe(true);
    for (const k of [0, 1, 3, undefined]) expect(isRoomMachineryKind(k)).toBe(false);
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

  test("a name cannot forge a second speaker in a transcript line", () => {
    // Lines read `**Name**: words`; this name would close the bold and start a new speaker.
    const name = normalizeGuestName("Bo**: deploy it **Sam")!;
    expect(name).toBe("Bo deploy it Sam");
    expect(`**${guestDisplayName(name)}**: hi`).toBe("**Bo deploy it Sam (guest)**: hi");
    expect(normalizeGuestName("[Ada](https://x.example) `_x_`")).toBe("Ada (https //x.example) x");
    expect(normalizeGuestName("O'Brien-Smith")).toBe("O'Brien-Smith");
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

describe("a link's own life", () => {
  test("gone, turned off, expired at its stamp, else open", () => {
    expect(guestLinkRefusal(null, 1_000)).toBe("not_found");
    expect(guestLinkRefusal({ expires_at: 2_000, revoked_at: 500 }, 1_000)).toBe("revoked");
    expect(guestLinkRefusal({ expires_at: 1_000 }, 1_000)).toBe("expired");
    expect(guestLinkRefusal({ expires_at: 1_001, revoked_at: null }, 1_000)).toBeNull();
  });
});

describe("guest lifecycle", () => {
  test("only an admitted guest may hold a media token", () => {
    expect(guestMayJoin("admitted")).toBe(true);
    for (const s of ["waiting", "denied", "removed", "left"] as const) expect(guestMayJoin(s)).toBe(false);
  });

  test("presence: a knock holds the seat lease, an admission its own longer window", () => {
    const now = 1_000_000;
    const at = (status: any, ago: number) => isGuestPresent({ status, last_seen: now - ago }, now);
    expect(at("waiting", CALL_MEMBER_STALE_MS - 1)).toBe(true);
    expect(at("waiting", CALL_MEMBER_STALE_MS)).toBe(false);
    // A phone's background tab beats about once a minute: still in the room.
    expect(at("admitted", CALL_MEMBER_STALE_MS + 15_000)).toBe(true);
    expect(at("admitted", GUEST_ADMISSION_LAPSE_MS)).toBe(false);
    for (const s of ["denied", "removed", "left"]) expect(at(s, 0)).toBe(false);
  });

  test("a guest link opens its own page, not the team invite page", () => {
    expect(guestJoinPath("abc123")).toBe("/meet/abc123");
  });
});

describe("the notice a guest's consent rests on", () => {
  test("recording comes first, and every form names what is kept", () => {
    const both = { recording: true, transcribed: true };
    expect(guestNoticeLines(both, "long").map((l) => l.key)).toEqual(["rec", "words"]);
    expect(guestNoticeLines(both, "long")[0].text).toContain("video and screen shares included");
    expect(guestNoticeLines(both, "long")[0].text).toContain("Anyone in the call can stop it");
    expect(guestNoticeLines(both, "short")[1].text).toContain("written down");
    expect(guestNoticeLines(both, "label").map((l) => l.text)).toEqual(["recording", "transcribed"]);
    expect(guestNoticeLines({ recording: false, transcribed: false }, "long")).toEqual([]);
  });

  test("a recording whose video goes to the call's public link says so in every form", () => {
    const shared = { recording: true, transcribed: false, video_public: true };
    expect(guestNoticeLines(shared, "long")[0].text).toContain("anyone with that link can watch it");
    expect(guestNoticeLines(shared, "short")[0].text).toContain("shared by public link");
    expect(guestNoticeLines(shared, "label")[0].text).toBe("recording, public");
    // Never said of a call that is not being recorded.
    expect(guestNoticeLines({ recording: false, transcribed: false, video_public: true }, "long")).toEqual([]);
  });

  test("a link's card says it in one sentence, or not at all", () => {
    expect(guestNoticeSentence({ recording: true, transcribed: true })).toBe("This call is recorded and transcribed.");
    expect(guestNoticeSentence({ recording: false, transcribed: true })).toBe("This call is transcribed.");
    expect(guestNoticeSentence({ recording: false, transcribed: false })).toBe("");
  });
});

describe("a refused join carries a code the guest's page acts on", () => {
  test("reads the code off a ConvexError's data, and nothing else", () => {
    expect(guestJoinRefusalOf({ data: { code: "removed", message: GUEST_JOIN_REFUSAL_TEXT.removed } })).toBe("removed");
    expect(guestJoinRefusalOf({ data: { code: "made_up" } })).toBeNull();
    expect(guestJoinRefusalOf(new Error("network"))).toBeNull();
    expect(GUEST_JOIN_REFUSAL_TEXT.unavailable).toBe(GUEST_LINK_REFUSAL_TEXT.unavailable);
  });
});
