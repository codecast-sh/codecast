import { describe, expect, it } from "bun:test";
import {
  MAX_MENTIONS,
  botHandle,
  emailLocalHandle,
  extractMentionHandles,
  memberHandle,
  mentionsHere,
} from "./handles";

// This module is imported by the SERVER's mention resolver and by both clients'
// completion strips. These tests are the contract that a handle offered is a
// handle honoured.

describe("extractMentionHandles", () => {
  it("finds handles at boundaries and lowercases them", () => {
    expect(extractMentionHandles("hey @Maya and (@devin): look")).toEqual(["maya", "devin"]);
  });

  it("ignores emails, paths and mid-word at-signs", () => {
    expect(extractMentionHandles("mail me at a@b.com or /path/@thing")).toEqual([]);
  });

  it("drops scope words and duplicates", () => {
    expect(extractMentionHandles("@here @maya @maya @channel @everyone")).toEqual(["maya"]);
  });

  it("caps at MAX_MENTIONS", () => {
    const text = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `@user${i}`).join(" ");
    expect(extractMentionHandles(text).length).toBe(MAX_MENTIONS);
  });
});

describe("mentionsHere", () => {
  it("matches the scope word at a boundary only", () => {
    expect(mentionsHere("ping @here now")).toBe(true);
    expect(mentionsHere("adhere to plans")).toBe(false);
    expect(mentionsHere("path/@here")).toBe(false);
  });
});

describe("the member vocabulary", () => {
  it("bots answer to their display-name slug", () => {
    expect(botHandle("The Anchor!")).toBe("theanchor");
    expect(botHandle("  ")).toBe(null);
    expect(memberHandle({ is_bot: true, name: "Anchor" })).toBe("anchor");
  });

  it("humans answer to github first, then the email local part", () => {
    expect(memberHandle({ github_username: "Ashot", email: "x@y.z" })).toBe("ashot");
    expect(memberHandle({ email: "dev.in@y.z" })).toBe(null); // dot fails the strict local rule
    expect(memberHandle({ email: "devin@y.z" })).toBe("devin");
  });

  it("humans never answer to their display name", () => {
    // A member can rename themselves; matching names would let them intercept
    // a teammate's mentions.
    expect(memberHandle({ name: "Maya Lindqvist" })).toBe(null);
  });

  it("emailLocalHandle refuses locals that are not safe handles", () => {
    expect(emailLocalHandle("a+tag@y.z")).toBe(null);
    expect(emailLocalHandle(undefined)).toBe(null);
  });
});
