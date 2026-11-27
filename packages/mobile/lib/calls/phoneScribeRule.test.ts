import { describe, expect, test } from "bun:test";
import { decideAutoScribe } from "@codecast/web/lib/calls/autoScribe";
import { decidePhoneScribe, type PhoneScribeInput } from "./phoneScribeRule";

const SESSION = "session:conv1";
const PHONE = "u_phone";
const PHONE2 = "u_phone2";
const WEB = "u_web";

function input(over: Partial<PhoneScribeInput>): PhoneScribeInput {
  return {
    roomKey: SESSION,
    connected: true,
    deliberate: true,
    transcribeOff: false,
    rosterIds: [PHONE],
    meId: PHONE,
    live: null,
    scribeActive: false,
    phoneIds: [PHONE, PHONE2],
    ...over,
  };
}

// Every seat looks at the room in turn until nobody changes anything, with the
// server's arbitration (transcripts.start / releaseScribe): no record or an
// open seat goes to the asker; a seated scribe makes every other asker an
// observer; an unseated scribe's run is adopted. Counts hand-overs, so a run
// bouncing between seats shows up.
function settle(roster: string[], opts: { off?: boolean; firstScribe?: string } = {}) {
  let startedBy: string | null | undefined = opts.firstScribe;
  const active = new Set<string>(opts.firstScribe ? [opts.firstScribe] : []);
  let handovers = 0;
  const live = () => (startedBy === undefined ? null : { startedBy });
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const me of roster) {
      const i = input({ rosterIds: roster, meId: me, live: live(), scribeActive: active.has(me), transcribeOff: !!opts.off });
      const v = me === WEB ? decideAutoScribe(i) : decidePhoneScribe(i);
      if (v === "start" && !active.has(me)) {
        const scribeSeated = !!startedBy && startedBy !== me && roster.includes(startedBy);
        if (scribeSeated) continue; // observer
        if (startedBy && startedBy !== me) handovers++;
        startedBy = me;
        active.add(me);
        changed = true;
      } else if (v === "release") {
        active.delete(me);
        startedBy = null;
        handovers++;
        changed = true;
      } else if ((v === "yield" || v === "stop") && active.delete(me)) {
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { scribes: [...active], startedBy, handovers };
}

describe("phone scribe election", () => {
  test("a phone alone in a session's room scribes", () => {
    expect(decidePhoneScribe(input({}))).toBe("start");
    expect(settle([PHONE]).scribes).toEqual([PHONE]);
  });

  test("a phone and a web seat: the web seat scribes, exactly one", () => {
    expect(settle([PHONE, WEB]).scribes).toEqual([WEB]);
  });

  test("a phone already scribing hands the run to a web seat once, and it stays there", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, WEB], live: { startedBy: PHONE }, scribeActive: true }))).toBe("release");
    const r = settle([PHONE, WEB], { firstScribe: PHONE });
    expect(r).toEqual({ scribes: [WEB], startedBy: WEB, handovers: 1 });
  });

  // Rule 1: nothing pushes the run on; the waiting seat must ask again itself.
  test("a seat that was an observer asks again once the scribe seat is open", () => {
    expect(decideAutoScribe(input({ rosterIds: [PHONE, WEB], meId: WEB, live: { startedBy: PHONE } }))).toBe("hold");
    expect(decideAutoScribe(input({ rosterIds: [PHONE, WEB], meId: WEB, live: { startedBy: null } }))).toBe("start");
  });

  // Rule 2: after releasing, the phone must not take the open seat back.
  test("a phone that released never asks while the web seat is there", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, WEB], live: { startedBy: null } }))).toBe("hold");
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, WEB], live: { startedBy: WEB } }))).toBe("hold");
  });

  test("the web seat leaving: the phone takes the run back", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE], live: { startedBy: WEB } }))).toBe("start");
  });

  // Rule 3: phones never release to phones.
  test("two phones: the first keeps the run, no hand-overs", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, PHONE2], live: { startedBy: PHONE }, scribeActive: true }))).toBe("hold");
    expect(settle([PHONE, PHONE2], { firstScribe: PHONE })).toEqual({ scribes: [PHONE], startedBy: PHONE, handovers: 0 });
    expect(settle([PHONE, PHONE2]).scribes).toHaveLength(1);
  });

  test("an agent's face or a guest in the room does not take the phone's run", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE, "agent:conv1", "guest:g1"], live: { startedBy: PHONE }, scribeActive: true }))).toBe("hold");
  });

  test("transcription switched off: nobody scribes", () => {
    expect(settle([PHONE], { off: true }).scribes).toEqual([]);
    expect(settle([PHONE, WEB], { off: true }).scribes).toEqual([]);
    expect(settle([PHONE, PHONE2], { off: true }).scribes).toEqual([]);
  });

  test("a run the server handed to someone else is let go", () => {
    expect(decidePhoneScribe(input({ rosterIds: [PHONE], live: { startedBy: WEB }, scribeActive: true }))).toBe("yield");
  });
});
