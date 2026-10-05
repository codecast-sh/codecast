import { describe, expect, test } from "bun:test";
import { stepDirection, welcomeStep, welcomeTrail, type WelcomeFacts } from "./onboarding";
import { ASKS, firstAsks } from "../../components/simple/lane";

const base: WelcomeFacts = { signedIn: true, connectAvailable: true, connectionsKnown: true, connected: false, skipped: false };

describe("welcomeStep", () => {
  test("someone signed out signs in first, whatever else is known", () => {
    expect(welcomeStep({ ...base, signedIn: false, connected: true, skipped: true })).toBe("signin");
  });

  test("signed in and not connected: connect", () => {
    expect(welcomeStep(base)).toBe("connect");
  });

  test("connected, skipped, or a deployment that cannot connect: start", () => {
    expect(welcomeStep({ ...base, connected: true })).toBe("start");
    expect(welcomeStep({ ...base, skipped: true })).toBe("start");
    expect(welcomeStep({ ...base, connectAvailable: false })).toBe("start");
  });

  test("waits rather than showing connect to someone who may be connected", () => {
    expect(welcomeStep({ ...base, connectionsKnown: false })).toBeNull();
    expect(welcomeStep({ ...base, connectAvailable: undefined })).toBeNull();
    // A skip still waits for the connections, since Start's ask depends on them.
    expect(welcomeStep({ ...base, connectionsKnown: false, skipped: true })).toBeNull();
    expect(welcomeStep({ ...base, connectAvailable: undefined, skipped: true })).toBe("start");
    // A deployment that cannot connect Google needs no connections answer.
    expect(welcomeStep({ ...base, connectionsKnown: false, connectAvailable: false })).toBe("start");
  });
});

describe("welcomeTrail and stepDirection", () => {
  test("the rail leaves out connect where Google cannot connect", () => {
    expect(welcomeTrail(false)).toEqual(["signin", "start"]);
    expect(welcomeTrail(undefined)).toEqual(["signin", "connect", "start"]);
  });

  test("direction follows the order of the screens", () => {
    expect(stepDirection("connect", "start")).toBe("forward");
    expect(stepDirection("start", "connect")).toBe("back");
  });
});

describe("firstAsks", () => {
  test("with mail and calendar, the lead is what needs them this week", () => {
    expect(firstAsks({ read_mail: true, modify_mail: true, send_mail: true, calendar: true }).lead).toBe(ASKS.week);
  });

  test("mail alone leads with replies, calendar alone with the week ahead", () => {
    expect(firstAsks({ read_mail: true, modify_mail: false, send_mail: false, calendar: false }).lead).toBe(ASKS.replies);
    expect(firstAsks({ read_mail: false, modify_mail: false, send_mail: false, calendar: true }).lead).toBe(ASKS.calendarWeek);
  });

  test("nothing connected: no lead, and no ask that needs mail or a calendar", () => {
    const { lead, more } = firstAsks(null);
    expect(lead).toBeNull();
    expect(more.length).toBeGreaterThanOrEqual(3);
    for (const ask of more) expect(ask).not.toMatch(/mail|calendar/i);
  });
});
