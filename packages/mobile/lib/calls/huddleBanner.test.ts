import { describe, expect, test } from "bun:test";
import { nextTimeSeenPatch, phoneBannerState, readNextTimeSeen } from "./huddleBanner";

describe("phoneBannerState", () => {
  test("Scribe absent: the invite, until dismissed for the call", () => {
    expect(phoneBannerState({ present: false, memo: {}, nextSeen: false })).toBe("invite");
    expect(phoneBannerState({ present: false, memo: { dismissed: true }, nextSeen: false })).toBe(null);
  });

  test("invited from the banner: Next time, once per workspace", () => {
    expect(phoneBannerState({ present: true, memo: { invited: true }, nextSeen: false })).toBe("next");
    // Seen in an earlier call: never again.
    expect(phoneBannerState({ present: true, memo: { invited: true }, nextSeen: true })).toBe(null);
    // Seen just now, in this call: it stays until acted on.
    expect(phoneBannerState({ present: true, memo: { invited: true, nextShown: true }, nextSeen: true })).toBe("next");
    expect(phoneBannerState({ present: true, memo: { invited: true, nextShown: true, nextClosed: true }, nextSeen: true })).toBe(null);
  });

  test("Scribe present without this person's invite: no banner", () => {
    expect(phoneBannerState({ present: true, memo: {}, nextSeen: false })).toBe(null);
  });
});

describe("huddleNextTimeSeen", () => {
  test("reads per workspace and patches without touching other workspaces", () => {
    const ui = { huddleNextTimeSeen: { "team:a": true } };
    expect(readNextTimeSeen(ui, "team:a")).toBe(true);
    expect(readNextTimeSeen(ui, "team:b")).toBe(false);
    expect(readNextTimeSeen(ui, null)).toBe(false);
    expect(nextTimeSeenPatch(ui, "team:b")).toEqual({ huddleNextTimeSeen: { "team:a": true, "team:b": true } });
    expect(nextTimeSeenPatch(undefined, "team:b")).toEqual({ huddleNextTimeSeen: { "team:b": true } });
  });
});
