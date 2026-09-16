import { describe, expect, test } from "bun:test";
import { AVATAR_KEYS, avatarOf, defaultAvatarFor, isAvatarKey } from "./orgAvatars";

describe("org avatars (org-staffing.md S13)", () => {
  test("24 distinct keys, and only those validate", () => {
    expect(AVATAR_KEYS.length).toBe(24);
    expect(new Set(AVATAR_KEYS).size).toBe(24);
    expect(isAvatarKey(AVATAR_KEYS[3])).toBe(true);
    expect(isAvatarKey("owl")).toBe(true);
    expect(isAvatarKey("avatar-01")).toBe(false);
    expect(isAvatarKey(undefined)).toBe(false);
  });
  test("the default is stable per handle, spreads across the set, and yields to a chosen key", () => {
    expect(defaultAvatarFor("growth")).toBe(defaultAvatarFor("growth"));
    expect(defaultAvatarFor("Growth")).toBe(defaultAvatarFor("growth"));
    const faces = new Set(["growth", "billing", "chief-of-staff", "platform", "mobile", "infra", "docs", "seo"].map(defaultAvatarFor));
    expect(faces.size).toBeGreaterThan(4);
    expect(avatarOf({ handle: "growth", avatar: AVATAR_KEYS[7] })).toBe(AVATAR_KEYS[7]);
    expect(avatarOf({ handle: "growth", avatar: "not-a-key" })).toBe(defaultAvatarFor("growth"));
    expect(avatarOf({ handle: "growth" })).toBe(defaultAvatarFor("growth"));
  });
});
