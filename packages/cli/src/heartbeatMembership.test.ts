import { describe, expect, test } from "bun:test";
import { deadTranscriptBeats, strikeUnknownBeats } from "./heartbeatMembership";

const facts = (over: Partial<Record<"pane" | "parked" | "alive", string[]>> = {}) => ({
  hasPane: (id: string) => (over.pane ?? []).includes(id),
  parked: (id: string) => (over.parked ?? []).includes(id),
  processAlive: (id: string) => (over.alive ?? []).includes(id),
});

describe("deadTranscriptBeats", () => {
  test("a session whose process exited stops beating", () => {
    expect(deadTranscriptBeats(["gone", "running"], facts({ alive: ["running"] }))).toEqual(["gone"]);
  });

  test("a pane or a park keeps a session beating without a registered process", () => {
    expect(deadTranscriptBeats(["paned", "parked", "gone"], facts({ pane: ["paned"], parked: ["parked"] }))).toEqual(["gone"]);
  });

  test("a fleet of finished hands drains to the ones still running", () => {
    const ids = Array.from({ length: 173 }, (_, i) => `s${i}`);
    const alive = ids.slice(0, 39);
    expect(deadTranscriptBeats(ids, facts({ alive })).length).toBe(134);
  });
});

describe("strikeUnknownBeats", () => {
  test("a session the server disowns three flushes running stops beating", () => {
    const strikes = new Map<string, number>();
    expect(strikeUnknownBeats(strikes, ["a", "b"], ["a"])).toEqual([]);
    expect(strikeUnknownBeats(strikes, ["a", "b"], ["a"])).toEqual([]);
    expect(strikeUnknownBeats(strikes, ["a", "b"], ["a"])).toEqual(["a"]);
    expect(strikes.size).toBe(0);
  });

  test("a registration that lands after the first beat clears the count", () => {
    const strikes = new Map<string, number>();
    strikeUnknownBeats(strikes, ["a"], ["a"]);
    strikeUnknownBeats(strikes, ["a"], ["a"]);
    expect(strikeUnknownBeats(strikes, ["a"], [])).toEqual([]);
    expect(strikeUnknownBeats(strikes, ["a"], ["a"])).toEqual([]);
  });

  test("an older backend that lists nothing drops nothing", () => {
    const strikes = new Map<string, number>();
    for (let i = 0; i < 5; i++) expect(strikeUnknownBeats(strikes, ["a"], undefined)).toEqual([]);
  });
});
