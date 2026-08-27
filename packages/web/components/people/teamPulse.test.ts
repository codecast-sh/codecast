import { describe, expect, it } from "bun:test";
import { pulseText, teamPulse } from "./teamPulse";
import type { FleetSummary } from "../presence/memberPresence";

const fleet = (over: Partial<FleetSummary> = {}): FleetSummary => ({
  working: 0,
  needsYou: 0,
  topStatus: null,
  topTitle: null,
  topSessionKey: null,
  ...over,
});

const m = (id: string, presence_state: string, extra: any = {}) => ({
  _id: id,
  presence_state,
  ...extra,
});

describe("teamPulse", () => {
  it("counts presence bands, busy as here, and sums the fleets", () => {
    const fleets = new Map<string, FleetSummary>([
      ["a", fleet({ working: 3, needsYou: 1 })],
      ["b", fleet({ working: 2 })],
    ]);
    const p = teamPulse(
      [
        m("a", "active"),
        m("b", "active", { status: "busy" }),
        m("c", "idle"),
        m("d", "active", { status: "away" }),
        m("e", "offline"),
      ],
      (x) => fleets.get(x._id),
      1,
    );
    expect(p).toMatchObject({ here: 2, idle: 1, away: 1, offline: 1, working: 5, needsInput: 1, huddles: 1 });
    expect(pulseText(p)).toBe("1 needs input · 2 here · 5 agents working · 1 huddle · 1 idle · 1 away");
  });

  it("drops zero counts and pluralises", () => {
    const p = teamPulse([m("a", "active")], () => fleet({ needsYou: 2 }), 0);
    expect(pulseText(p)).toBe("2 need input · 1 here");
  });

  it("says nobody is here rather than listing absences", () => {
    expect(pulseText(teamPulse([m("a", "offline"), m("b", "offline")], () => null, 0))).toBe("nobody here");
    expect(pulseText(teamPulse([], () => null, 0))).toBe("no teammates yet");
  });

  it("can be cut to the first N segments for a narrow slot", () => {
    const p = teamPulse([m("a", "active"), m("b", "idle")], () => fleet({ working: 1 }), 0);
    expect(pulseText(p, 2)).toBe("1 here · 2 agents working");
  });
});
