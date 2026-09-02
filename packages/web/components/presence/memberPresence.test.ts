import { describe, expect, it } from "bun:test";
import {
  PRESENCE_META,
  groupMembersByBand,
  presenceBand,
  memberFleetSummary,
  memberInHuddle,
  memberPresenceVisual,
  presenceActivityLine,
  presenceAvatarClass,
  presenceLabel,
  presenceLine,
} from "./memberPresence";
import type { InboxSession } from "../../store/inboxStore";

const NOW = 1_700_000_000_000;
const ctx = (over: Partial<Parameters<typeof presenceActivityLine>[1]> = {}) => ({ now: NOW, ...over });
const fleet = (over: Partial<ReturnType<typeof memberFleetSummary>> = {}) => ({
  working: 0,
  needsYou: 0,
  topStatus: null,
  topTitle: null,
  topSessionKey: null,
  ...over,
}) as any;

const member = (over: Record<string, any> = {}) => ({ presence_state: "active", ...over });

describe("memberPresenceVisual", () => {
  it("draws a manual busy over the heartbeat state", () => {
    expect(memberPresenceVisual(member({ status: "busy" }))).toBe("busy");
    expect(memberPresenceVisual(member({ presence_state: "idle", status: "busy" }))).toBe("busy");
  });

  it("keeps offline over a stale busy flag — a dead daemon is gone, not busy", () => {
    expect(memberPresenceVisual(member({ presence_state: "offline", status: "busy" }))).toBe("offline");
  });

  it("draws a declared away over an active heartbeat — the declaration is the point", () => {
    expect(memberPresenceVisual(member({ status: "away" }))).toBe("away");
    expect(presenceActivityLine(member({ status: "away" }), ctx())).toBe("away");
    expect(presenceLine(member({ status: "away" }), NOW)).toBe("Away");
  });

  // A live room is a report the heartbeat cannot make. Presence is driven by
  // INPUT, and listening in a huddle is not input — so a long call turned
  // everyone in it idle and then away while they were talking to each other.
  describe("a live room outranks the heartbeat", () => {
    it("draws somebody in a huddle as present, whatever their keyboard did", () => {
      expect(memberPresenceVisual(member({ presence_state: "away", in_room_key: "dm:a:b" }))).toBe("active");
      expect(memberPresenceVisual(member({ presence_state: "idle", in_huddle: true }))).toBe("active");
    });

    it("beats offline too — the room's lease IS the report", () => {
      expect(memberPresenceVisual(member({ presence_state: "offline", in_room_key: "dm:a:b" }))).toBe("active");
    });

    it("never overrides a declaration", () => {
      expect(memberPresenceVisual(member({ presence_state: "away", in_room_key: "dm:a:b", status: "busy" }))).toBe("busy");
      expect(memberPresenceVisual(member({ presence_state: "active", in_huddle: true, status: "away" }))).toBe("away");
    });

    it("still calls a silent, roomless machine offline", () => {
      expect(memberPresenceVisual(member({ presence_state: "offline" }))).toBe("offline");
      expect(memberPresenceVisual(member({ presence_state: "offline", status: "busy" }))).toBe("offline");
    });

    it("puts them in the band their badge claims", () => {
      const inHuddle = { _id: "u1", name: "Ann", presence_state: "away", in_room_key: "dm:a:b" };
      expect(presenceBand(inHuddle)).toBe(presenceBand({ presence_state: "active" }));
    });
  });

  it("falls back to offline for an unknown state", () => {
    expect(memberPresenceVisual({ presence_state: "asleep" })).toBe("offline");
  });
});

describe("the encoding", () => {
  it("gives every state a shape or a glyph, never hue alone", () => {
    // active solid, idle hollow, away+busy carry a glyph, offline draws nothing.
    expect(PRESENCE_META.active.badge).toBe("pres-active");
    expect(PRESENCE_META.idle.badge).toBe("pres-idle");
    expect(PRESENCE_META.away.glyph).toBe("moon");
    expect(PRESENCE_META.busy.glyph).toBe("minus");
    expect(PRESENCE_META.offline.badge).toBe("");
  });

  it("names each state in one word", () => {
    expect(presenceLabel("active")).toBe("Active");
    expect(presenceLabel("busy")).toBe("Busy");
  });

  it("fades the face for away and offline only", () => {
    expect(presenceAvatarClass("active")).toBe("");
    expect(presenceAvatarClass("away")).toBe("pres-av-away");
    expect(presenceAvatarClass("offline")).toBe("pres-av-offline");
  });
});

describe("presenceActivityLine ordering", () => {
  const loud = member({ in_room_key: "dm:a:b", status: "busy" });

  it("puts a live voice above everything", () => {
    expect(
      presenceActivityLine(loud, ctx({ talking: true, room: { label: "#design" }, fleet: fleet({ working: 3 }) })),
    ).toBe("talking on the walkie");
  });

  it("puts the huddle above the fleet", () => {
    expect(
      presenceActivityLine(loud, ctx({ room: { label: "#design" }, fleet: fleet({ working: 3 }) })),
    ).toBe("in a huddle · #design");
  });

  it("says a locked huddle is locked instead of guessing its name", () => {
    expect(
      presenceActivityLine(member(), ctx({ room: { label: "a huddle", locked: true } })),
    ).toBe("in a locked huddle");
  });

  it("names the room a member of it sits in, locked or not", () => {
    expect(
      presenceActivityLine(member({ in_room_key: "call:1" }), ctx({ room: { label: "Ann, Bo", locked: true } })),
    ).toBe("in a huddle · Ann, Bo");
  });

  it("falls back to the bare huddle when the label is redacted away", () => {
    expect(presenceActivityLine(member({ in_huddle: true }), ctx())).toBe("in a huddle");
  });

  // A people room's shared label names it from the VIEWER's seat, which is
  // right for the dock pill and wrong on a row about one of the people in it.
  describe("naming a people huddle from the row's own seat", () => {
    const riley = member({ _id: "riley", in_room_key: "dm:riley:jordan" });
    const peopleRoom = (members: Array<[string, string]>) => ({
      roomKey: "dm:riley:jordan",
      // What describeRoom hands every surface: the OTHER people, from the
      // viewer's seat. On Riley's row this said "Riley Chen".
      label: "Riley Chen",
      members: members.map(([user_id, user_name]) => ({ user_id, user_name })),
    });

    it("says 'with you' instead of reading the row its own name", () => {
      expect(
        presenceActivityLine(
          riley,
          ctx({ viewerId: "jordan", room: peopleRoom([["riley", "Riley Chen"], ["jordan", "Jordan Lee"]]) }),
        ),
      ).toBe("in a huddle with you");
    });

    it("names the other end when the viewer is not in it", () => {
      expect(
        presenceActivityLine(
          riley,
          ctx({ viewerId: "sam", room: peopleRoom([["riley", "Riley Chen"], ["ann", "Ann Diaz"]]) }),
        ),
      ).toBe("in a huddle · Ann Diaz");
    });

    it("keeps 'with you' first and adds who else is there", () => {
      expect(
        presenceActivityLine(
          riley,
          ctx({
            viewerId: "jordan",
            room: peopleRoom([["riley", "R"], ["jordan", "Jordan Lee"], ["ann", "Ann Diaz"]]),
          }),
        ),
      ).toBe("in a huddle with you and Ann Diaz");
    });

    it("caps a crowd so one row stays one line", () => {
      expect(
        presenceActivityLine(
          riley,
          ctx({
            viewerId: "sam",
            room: peopleRoom([
              ["riley", "R"], ["ann", "Ann"], ["bo", "Bo"], ["cy", "Cy"], ["di", "Di"],
            ]),
          }),
        ),
      ).toBe("in a huddle · Ann, Bo and 2 more");
    });

    it("says the plain thing when they are alone in a room they opened", () => {
      expect(
        presenceActivityLine(riley, ctx({ viewerId: "jordan", room: peopleRoom([["riley", "Riley Chen"]]) })),
      ).toBe("in a huddle");
    });

    it("leaves a channel room's shared label alone — it names nobody", () => {
      expect(
        presenceActivityLine(
          riley,
          ctx({
            viewerId: "jordan",
            room: {
              roomKey: "channel:design",
              label: "#design",
              members: [{ user_id: "riley", user_name: "Riley Chen" }],
            },
          }),
        ),
      ).toBe("in a huddle · #design");
    });

    it("keeps the shared label when no roster came with the room", () => {
      expect(
        presenceActivityLine(riley, ctx({ viewerId: "jordan", room: { roomKey: "dm:riley:jordan", label: "Riley Chen" } })),
      ).toBe("in a huddle · Riley Chen");
    });
  });

  it("counts working agents and quotes what the top one is on", () => {
    expect(
      presenceActivityLine(member(), ctx({ fleet: fleet({ working: 2, topTitle: "fixing auth" }) })),
    ).toBe("2 agents working · fixing auth");
    expect(presenceActivityLine(member(), ctx({ fleet: fleet({ working: 1 }) }))).toBe("1 agent working");
  });

  it("asks for an answer when nothing is running", () => {
    expect(presenceActivityLine(member(), ctx({ fleet: fleet({ needsYou: 3 }) }))).toBe(
      "needs to answer 3 agents",
    );
  });

  it("caps absurd fleet counts", () => {
    expect(presenceActivityLine(member(), ctx({ fleet: fleet({ working: 608 }) }))).toBe(
      "20+ agents working",
    );
  });

  it("says busy when there is nothing else to say", () => {
    expect(presenceActivityLine(member({ status: "busy" }), ctx())).toBe("busy");
  });

  it("times the idle and prints the plain words for the rest", () => {
    expect(
      presenceActivityLine(
        member({ presence_state: "idle", presence_input_at: NOW - 12 * 60_000 }),
        ctx(),
      ),
    ).toBe("idle 12m");
    expect(presenceActivityLine(member({ presence_state: "away" }), ctx())).toBe("away");
    expect(presenceActivityLine(member(), ctx())).toBe("active now");
    expect(
      presenceActivityLine(
        member({ presence_state: "offline", daemon_last_seen: NOW - 3 * 3600_000 }),
        ctx(),
      ),
    ).toBe("last seen 3h ago");
    expect(presenceActivityLine(member({ presence_state: "offline" }), ctx())).toBe("offline");
  });
});

describe("memberFleetSummary", () => {
  const sess = (over: Partial<InboxSession> = {}): InboxSession =>
    ({
      _id: "c1",
      session_id: "s1",
      updated_at: NOW - 10_000,
      agent_type: "claude_code",
      message_count: 3,
      is_idle: true,
      user_id: "u1",
      title: "fixing auth",
      ...over,
    }) as InboxSession;
  const opts = { queued: new Set<string>(), pendingSendIds: new Set<string>(), now: NOW };

  it("carries the top session's title for the activity line", () => {
    const f = memberFleetSummary([sess({ is_idle: false, agent_status: "working" } as any)], "u1", opts);
    expect(f?.working).toBe(1);
    expect(f?.topTitle).toBe("fixing auth");
  });

  it("ignores other people's sessions", () => {
    expect(memberFleetSummary([sess({ user_id: "u2" } as any)], "u1", opts)).toBeNull();
  });
});

describe("roster bands", () => {
  const who = (name: string, over: Record<string, any> = {}) => ({ _id: name, name, ...over });

  it("keeps busy under Online — they are at the machine, the badge says not now", () => {
    expect(presenceBand(member({ status: "busy" }))).toBe("online");
    expect(presenceBand(member())).toBe("online");
  });

  it("files a declared away under Away even on a live heartbeat", () => {
    expect(presenceBand(member({ status: "away" }))).toBe("away");
  });

  it("orders the sections and drops the empty ones", () => {
    const groups = groupMembersByBand([
      who("Zoe", { presence_state: "offline" }),
      who("Ann", { presence_state: "active" }),
      who("Bo", { presence_state: "active", status: "busy" }),
      who("Cy", { presence_state: "away" }),
    ]);
    expect(groups.map((g) => g.band)).toEqual(["online", "away", "offline"]);
    expect(groups[0].label).toBe("Online");
    // Sorted by name inside a section, never by freshness: a roster that
    // reshuffled on every heartbeat could not be clicked.
    expect(groups[0].members.map((m: any) => m.name)).toEqual(["Ann", "Bo"]);
  });

  it("survives a roster with holes", () => {
    expect(groupMembersByBand([null as any, undefined as any])).toEqual([]);
  });
});

// The founder's "this huddle indicator sticks around when I'm not in a call".
//
// A walkie burst seats everyone who hears it, and the seat is deliberately
// held for half a minute after the key comes up so a reply lands in the same
// room. `in_huddle` is true for that whole window with nobody in a call, so
// the chip lit for three seconds of somebody's voice and stayed lit long after
// the voice stopped.
describe("memberInHuddle", () => {
  const seated = (room: string) => ({ in_huddle: true, in_room_key: room });

  it("wears the chip for an ordinary huddle seat", () => {
    expect(memberInHuddle(seated("dm:a:b"), null)).toBe(true);
    expect(memberInHuddle(seated("dm:a:b"), "dm:c:d")).toBe(true);
  });

  it("does NOT wear it for a seat the walkie is holding as a burst", () => {
    // The seat exists — the person is audible — but a voice message is not a
    // conversation, and the chip is what claims one.
    expect(memberInHuddle(seated("dm:a:b"), "dm:a:b")).toBe(false);
  });

  it("wears it again the moment the burst becomes a call", () => {
    // `walkieHoldsRoom` goes false on the upgrade, so the caller passes null
    // and the same seat reads as the huddle it now is.
    expect(memberInHuddle(seated("dm:a:b"), null)).toBe(true);
  });

  it("is false with no seat at all, whatever the walkie is doing", () => {
    expect(memberInHuddle({}, "dm:a:b")).toBe(false);
    expect(memberInHuddle(null, "dm:a:b")).toBe(false);
  });

  it("still reads a seat carried by in_huddle alone", () => {
    // The roster reports in_room_key only when the viewer may see the room;
    // in_huddle survives that redaction, and a chip is all it drives.
    expect(memberInHuddle({ in_huddle: true }, "dm:a:b")).toBe(true);
  });
});
