import { describe, expect, it } from "bun:test";
import { STALE_PROMPT_AFTER_MS, updatePromptKind } from "./kind";

const base = {
  bakedGeneration: 3,
  servedGeneration: 3,
  dismissedGeneration: 0,
  updateWaitingSince: 1_000,
  staleSnoozedUntil: 0,
  now: 1_000,
};

describe("updatePromptKind", () => {
  it("stays silent for a routine deploy", () => {
    expect(updatePromptKind(base)).toBeNull();
  });

  it("prompts when the served build bumped the generation", () => {
    expect(updatePromptKind({ ...base, servedGeneration: 4 })).toBe("release");
  });

  it("never re-prompts a generation the person dismissed", () => {
    expect(updatePromptKind({ ...base, servedGeneration: 4, dismissedGeneration: 4 })).toBeNull();
    expect(updatePromptKind({ ...base, servedGeneration: 5, dismissedGeneration: 4 })).toBe("release");
  });

  it("prompts a window an update has waited on for a day, then honours the snooze", () => {
    const later = base.updateWaitingSince + STALE_PROMPT_AFTER_MS;
    expect(updatePromptKind({ ...base, now: later - 1 })).toBeNull();
    expect(updatePromptKind({ ...base, now: later })).toBe("stale");
    expect(updatePromptKind({ ...base, now: later, staleSnoozedUntil: later + 1 })).toBeNull();
  });
});
