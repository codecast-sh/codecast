import { describe, expect, test } from "bun:test";
import {
  isExcludedStableItem,
  parseStableContext,
  resolveStableLaunch,
  STABLE_ENV_CONVERSATION_ID,
  STABLE_ENV_EXCLUDE,
  STABLE_ENV_GLOBAL,
  STABLE_ENV_MODE,
} from "./stableContext";

describe("resolveStableLaunch", () => {
  test("session environment overrides machine defaults", () => {
    expect(resolveStableLaunch({
      [STABLE_ENV_MODE]: "solo",
      [STABLE_ENV_GLOBAL]: "false",
      [STABLE_ENV_EXCLUDE]: " jx7aaaa, jx7bbbb ",
      [STABLE_ENV_CONVERSATION_ID]: "conversations123",
    }, {
      stable_mode: "team",
      stable_global: true,
    })).toEqual({
      mode: "solo",
      global: false,
      exclude: ["jx7aaaa", "jx7bbbb"],
      conversationId: "conversations123",
    });
  });

  test("explicit off suppresses injection and invalid env modes fall back safely", () => {
    expect(resolveStableLaunch({ [STABLE_ENV_MODE]: "off" }, {
      stable_mode: "team",
    }).mode).toBeNull();

    expect(resolveStableLaunch({ [STABLE_ENV_MODE]: "invalid" }, {
      stable_mode: "solo",
    }).mode).toBe("solo");
  });
});

describe("stable-context records", () => {
  test("parses a valid snapshot while dropping malformed cards", () => {
    expect(parseStableContext(JSON.stringify({
      mode: "team",
      global: true,
      injected_at: 123,
      items: [
        { id: "conversations1", title: "Keep" },
        { id: "conversations2" },
        null,
      ],
    }))).toEqual({
      mode: "team",
      global: true,
      injected_at: 123,
      items: [{ id: "conversations1", title: "Keep" }],
    });
  });

  test("rejects malformed records and matches full or short exclusions", () => {
    expect(parseStableContext("{")).toBeNull();
    expect(parseStableContext(JSON.stringify({ mode: "off", items: [] }))).toBeNull();
    expect(isExcludedStableItem("jx7AbCd-rest-of-id", ["JX7ABCD"])).toBe(true);
    expect(isExcludedStableItem("jx7AbCd-rest-of-id", ["other"])).toBe(false);
  });
});
