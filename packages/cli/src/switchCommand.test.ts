import { describe, expect, test } from "bun:test";
import { parseSwitchAgentArg, switchOutcome } from "./switchCommand";

describe("parseSwitchAgentArg", () => {
  test("accepts daemon and convex spellings", () => {
    expect(parseSwitchAgentArg("claude")).toBe("claude_code");
    expect(parseSwitchAgentArg("claude_code")).toBe("claude_code");
    expect(parseSwitchAgentArg("Codex")).toBe("codex");
    expect(parseSwitchAgentArg("grok")).toBe("grok");
  });

  test("rejects unknown names", () => {
    expect(() => parseSwitchAgentArg("not-an-agent")).toThrow(/Unknown agent/);
  });
});

// A same-agent model change is two slash commands queued for the session. The
// command said "applied" for a `/model opus` still waiting behind a blocked
// queue, and the session stayed on the model whose limit it had hit.
describe("switchOutcome", () => {
  test("a queued model change is not reported as applied", () => {
    const said = switchOutcome({ reconstituted: false, live_commands: ["/model opus", "/effort high"] });
    expect(said).toBe("sent /model opus and /effort high to the session; it changes when the session reads them");
    expect(said).not.toContain("applied");
    expect(switchOutcome({ live_commands: ["/effort low"] })).toBe("sent /effort low to the session; it changes when the session reads it");
  });

  test("a change with nothing sent says the running session is unchanged", () => {
    expect(switchOutcome({ reconstituted: false, live_commands: [] })).toContain("nothing was sent to the running session");
    expect(switchOutcome({})).toContain("nothing was sent to the running session");
  });

  test("a restart and a blank relaunch keep their own words", () => {
    expect(switchOutcome({ reconstituted: true })).toBe("this session will resume as the new agent");
    expect(switchOutcome({ blank: true, reconstituted: false })).toBe("blank session relaunched");
  });
});
