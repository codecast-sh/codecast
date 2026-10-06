import { describe, expect, test } from "bun:test";
import { WELCOME_TRAIL, stepDirection, trailStep, welcomeStep, type WelcomeFacts } from "./onboarding";
import { ASKS, firstAsks } from "../../components/simple/lane";

const base: WelcomeFacts = { signedIn: true, connectAvailable: true, connectionsKnown: true, connected: false, connecting: false };

describe("welcomeStep", () => {
  test("someone signed out signs in first, whatever else is known", () => {
    expect(welcomeStep({ ...base, signedIn: false, connected: true, connecting: true })).toBe("signin");
  });

  test("signed in: straight to the first useful thing, connected or not", () => {
    expect(welcomeStep(base)).toBe("start");
    expect(welcomeStep({ ...base, connected: true })).toBe("start");
    expect(welcomeStep({ ...base, connectAvailable: undefined })).toBe("start");
  });

  test("the connect screen only when asked for and only where connect works", () => {
    expect(welcomeStep({ ...base, connecting: true })).toBe("connect");
    expect(welcomeStep({ ...base, connecting: true, connectAvailable: undefined })).toBe("start");
    expect(welcomeStep({ ...base, connecting: true, connectAvailable: false })).toBe("start");
    expect(welcomeStep({ ...base, connecting: true, connected: true })).toBe("start");
  });

  test("waits for the connection, since Start's asks depend on it", () => {
    expect(welcomeStep({ ...base, connectionsKnown: false })).toBeNull();
  });
});

describe("the rail and stepDirection", () => {
  test("two steps, with connect standing at Start", () => {
    expect(WELCOME_TRAIL).toEqual(["signin", "start"]);
    expect(trailStep("connect")).toBe("start");
  });

  test("direction follows the order of the screens", () => {
    expect(stepDirection("signin", "start")).toBe("forward");
    expect(stepDirection("start", "connect")).toBe("forward");
    expect(stepDirection("connect", "start")).toBe("back");
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

  test("nothing connected: no lead, no ask that needs mail or a calendar, and no routine before a first result", () => {
    const { lead, more } = firstAsks(null);
    expect(lead).toBeNull();
    expect(more.length).toBeGreaterThanOrEqual(3);
    for (const ask of more) expect(ask).not.toMatch(/mail|calendar|\bweek\b|\bevery\b/i);
  });
});
