import { describe, expect, test } from "bun:test";
import { otherModelFor, parkedModelFamily } from "../limitContinue";

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
