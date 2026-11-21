import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { withoutMinorityModelParks } from "./accountSwitch";

// A park on one model's week moves the fleet only when the fleet mostly runs
// that model. One Fable session hopped an Opus fleet across three accounts
// every few minutes (2026-11-21).

const FABLE_BANNER = "You've hit your Fable limit · resets Nov 24 at 2am (America/Los_Angeles). /model to switch models.";
const WEEKLY_BANNER = "You've hit your weekly limit · resets Nov 24, 2am (UTC)";

function world() {
  return makeFakeDb({
    conversations: [{ _id: "conv_fable" }, { _id: "conv_week" }],
    messages: [
      { _id: "m1", conversation_id: "conv_fable", role: "user", content: "continue", timestamp: 1 },
      { _id: "m2", conversation_id: "conv_fable", role: "assistant", content: FABLE_BANNER, timestamp: 2 },
      { _id: "m3", conversation_id: "conv_week", role: "user", content: "continue", timestamp: 1 },
      { _id: "m4", conversation_id: "conv_week", role: "assistant", content: WEEKLY_BANNER, timestamp: 2 },
    ],
  });
}

describe("withoutMinorityModelParks", () => {
  test("an Opus fleet leaves a Fable park out of the account decision", async () => {
    const kept = await withoutMinorityModelParks({ db: world() }, [{ _id: "conv_fable" }, { _id: "conv_week" }] as any, ["claude-opus-5-5"]);
    expect(kept.map((c) => c._id)).toEqual(["conv_week"] as any);
  });

  test("a Fable fleet still acts on its Fable park", async () => {
    const kept = await withoutMinorityModelParks({ db: world() }, [{ _id: "conv_fable" }] as any, ["claude-fable-5-2"]);
    expect(kept.map((c) => c._id)).toEqual(["conv_fable"] as any);
  });
});
