import { describe, expect, test } from "bun:test";
import { familyStandingLabel, limitContinueTarget, otherModelFor, parkedModelFamily } from "../limitContinue";

// A session parked on one model's week goes on with another model, on web's
// park card and the phone's banner alike.

describe("parkedModelFamily", () => {
  test("names the model when the newest banner is a model-only limit", () => {
    expect(parkedModelFamily([
      { role: "user", content: "continue" },
      { role: "assistant", content: "You've hit your Fable limit · resets Nov 24 at 2am (America/Los_Angeles). /model to switch models." },
    ])).toBe("fable");
  });
  test("an account-wide limit or a later reply names none", () => {
    expect(parkedModelFamily([{ role: "assistant", content: "You've hit your weekly limit · resets Nov 24, 2am (UTC)" }])).toBeUndefined();
    expect(parkedModelFamily([
      { role: "assistant", content: "You've hit your Fable limit · resets Nov 24 at 2am (UTC). /model to switch models." },
      { role: "assistant", content: "Done, the tests pass." },
    ])).toBeUndefined();
    expect(parkedModelFamily(undefined)).toBeUndefined();
  });
  test("Fable goes on Opus, Opus on Sonnet", () => {
    expect(otherModelFor("fable").key).toBe("opus");
    expect(otherModelFor("opus").key).toBe("sonnet");
  });
});

// A model's week is per account: a Fable park continues on the account that
// still has Fable, never on one whose Fable week is as spent as the one it
// left (2026-11-22: six accounts at Fable 100%, one at 22%, and the card
// offered only Opus).
describe("limitContinueTarget for a model-only park", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const week = (percent: number) => ({ percent, resets_at: now + 3 * 86_400_000 });
  const profile = (name: string, weekly: number, fable: number) => ({
    name,
    email: `${name}@example.com`,
    usage: { fetched_at: now - 60_000, session: week(5), weekly: week(weekly), weekly_scoped: { ...week(fable), label: "Fable" } },
  });
  const device = {
    active_email: "studio@example.com",
    profiles: [
      profile("studio", 88, 100),
      profile("symmetry", 60, 100),
      profile("frame", 62, 100),
      profile("ada", 70, 22),
    ],
  };

  test("a Fable park picks the account with Fable left", () => {
    expect(limitContinueTarget(device, now, true, "fable").best?.name).toBe("ada");
    // Ranked by the general week alone it would pick symmetry, Fable spent.
    expect(limitContinueTarget(device, now, true).best?.name).toBe("symmetry");
    expect(familyStandingLabel(limitContinueTarget(device, now, true, "fable").best?.usage, "fable", now)).toBe("Fable 22% used");
  });

  test("an account with no Fable meter is unproven, not room", () => {
    const unmetered = { ...device, profiles: [...device.profiles.filter((p) => p.name !== "ada"), { name: "blind", email: "blind@example.com", usage: { fetched_at: now - 60_000, session: week(1), weekly: week(5) } }] };
    expect(limitContinueTarget(unmetered, now, true, "fable").best).toBeUndefined();
  });

  test("with no account holding Fable there is no account to offer", () => {
    const spent = { ...device, profiles: device.profiles.filter((p) => p.name !== "ada") };
    expect(limitContinueTarget(spent, now, true, "fable").best).toBeUndefined();
    // An account-wide park still ranks by the general week.
    expect(limitContinueTarget(spent, now, true).best?.name).toBe("symmetry");
  });
});
