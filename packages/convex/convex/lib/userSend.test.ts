import { describe, expect, test } from "bun:test";
import { isUserMessageNoise, stripMessageTags } from "./userSend";

// The profile feed's Typed view and the Sends counter both run on this
// classifier — anything machinery injects as a user-role turn must read as
// noise, or it surfaces as "what the human typed".

describe("isUserMessageNoise", () => {
  test("keeps real human prompts", () => {
    expect(isUserMessageNoise("fix the login bug")).toBe(false);
    expect(isUserMessageNoise("can you take the auth half?\n\n- step one")).toBe(false);
  });

  test("drops cast send session messages", () => {
    expect(isUserMessageNoise('<session-message from="jx7c6zk">\ntake the auth half\n</session-message>')).toBe(true);
  });

  test("drops teammate broadcasts with <teammate-message> tags", () => {
    const wrapped = 'Another Claude session sent a message:\n<teammate-message teammate_id="tracker">\nall done\n</teammate-message>\nThis came from another Claude session — not typed by your user.';
    expect(isUserMessageNoise(wrapped)).toBe(true);
  });

  test("drops tag-less SendMessage idle notifications (feed regression)", () => {
    // The exact shape that leaked into the profile feed's Typed view: the
    // harness lead-in + raw JSON + disclaimer, no <teammate-message> tags.
    const idle = 'Another Claude session sent a message: {"type":"idle_notification","from":"tick-sweep-6","timestamp":"2026-08-26T20:53:41.796Z","idleReason":"available","summary":"[to main] Sweep 13:52"} This came from another Claude session — not typed by your user, but very likely working on their behalf.';
    expect(isUserMessageNoise(idle)).toBe(true);
  });

  test("drops the CLI's session-move notice (feed regression)", () => {
    const moved = "[codecast] This session just moved to a different machine. It now runs on jb-m5-max in /Users/jasonbenn/code/union-mobile/outreach.";
    expect(isUserMessageNoise(moved)).toBe(true);
  });

  test("drops scheduled-task injections and chat anchor wakes", () => {
    expect(isUserMessageNoise('<scheduled-task title="Check CI">run the checks</scheduled-task>')).toBe(true);
    expect(isUserMessageNoise("[codecast team chat — #general]\nSam mentioned you in a thread.")).toBe(true);
  });

  test("stripMessageTags still leaves human text intact", () => {
    expect(stripMessageTags("<system-reminder>noise</system-reminder>\nship it")).toBe("ship it");
  });
});
