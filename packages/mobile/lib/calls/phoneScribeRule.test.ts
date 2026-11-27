import { describe, expect, test } from "bun:test";
import { decideAutoScribe, type AutoScribeInput } from "@codecast/web/lib/calls/autoScribe";
import { decidePhoneScribe } from "./phoneScribeRule";

const SESSION = "session:conv1";
const PHONE = "u_phone";
const WEB = "u_web";

function input(over: Partial<AutoScribeInput>): AutoScribeInput {
  return {
    roomKey: SESSION,
    connected: true,
    deliberate: true,
    transcribeOff: false,
    rosterIds: [PHONE],
    meId: PHONE,
    live: null,
    scribeActive: false,
    ...over,
  };
}

// Both clients looking at the same room until neither wants to change anything,
// with transcripts.start as the arbiter: a live run with a seated scribe makes
// every other asker an observer; an open seat goes to the first asker.
function settle(roster: string[], opts: { off?: boolean; firstScribe?: string | null } = {}) {
  let startedBy: string | null | undefined = opts.firstScribe === undefined ? undefined : opts.firstScribe;
  const active = new Set<string>(startedBy ? [startedBy] : []);
  const live = () => (startedBy === undefined ? null : { startedBy });
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const me of roster) {
      const i = input({ rosterIds: roster, meId: me, live: live(), scribeActive: active.has(me), transcribeOff: !!opts.off });
      const v = me === PHONE ? decidePhoneScribe(i) : decideAutoScribe(i);
      if (v === "start") {
        const seated = startedBy && roster.includes(startedBy);
        if (startedBy === undefined || startedBy === null || startedBy === me || !seated) {
          if (startedBy !== me || !active.has(me)) changed = true;
          startedBy = me;
          active.add(me);
        }
      } else if (v === "release") {
        active.delete(me);
        startedBy = null;
        changed = true;
      } else if (v === "yield" || v === "stop") {
        if (active.delete(me)) changed = true;
      }
    }
    if (!changed) break;
  }
  return { scribes: [...active], startedBy };
}

describe("phone scribe election", () => {
  test("a phone alone in a session's room scribes", () => {
    expect(decidePhoneScribe(input({}))).toBe("start");
    expect(settle([PHONE]).scribes).toEqual([PHONE]);
  });

  test("a phone and a web seat: the web seat scribes, exactly one", () => {
    expect(settle([PHONE, WEB]).scribes).toEqual([WEB]);
  });

  test("a phone already scribing hands the run to a web seat that sits down", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, WEB], live: { startedBy: PHONE }, scribeActive: true }))).toBe("release");
    const r = settle([PHONE, WEB], { firstScribe: PHONE });
    expect(r.scribes).toEqual([WEB]);
    expect(r.startedBy).toBe(WEB);
  });

  test("a phone that is not scribing never asks while another person is seated", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, WEB], live: { startedBy: null } }))).toBe("hold");
  });

  test("an agent's face or a guest in the room does not take the phone's run", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, "agent:conv1", "guest:g1"], live: { startedBy: PHONE }, scribeActive: true }))).toBe("hold");
  });

  test("transcription switched off: nobody scribes", () => {
    expect(settle([PHONE], { off: true }).scribes).toEqual([]);
    expect(settle([PHONE, WEB], { off: true }).scribes).toEqual([]);
  });

  test("a run the server handed to someone else is let go", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE], live: { startedBy: WEB }, scribeActive: true }))).toBe("yield");
  });
});
