// A hosted assistant conversation has no process of the person's: it is never
// called disconnected, never idle "to resume", and never offers the
// unresponsive banner's Resume.
import { describe, expect, it } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { sessionDisconnected } from "../conversation/agentStatusPill";
import { sessionLooksAbandoned } from "../SessionErrorBanner";

describe("hosted conversations show no machine status", () => {
  const gone = { active: true, isConnected: false, recentlyMoved: false };

  it("is never disconnected", () => {
    expect(sessionDisconnected({ ...gone, agentType: "claude_code" })).toBe(true);
    expect(sessionDisconnected({ ...gone, agentType: HOSTED_AGENT_TYPE })).toBe(false);
    expect(sessionDisconnected({ ...gone, isConnected: undefined, agentType: "claude_code" })).toBe(false);
  });

  it("never looks abandoned", () => {
    const now = 10 * 60 * 1000;
    const stale = { updated_at: 0, messages: [{ role: "user", content: "Add a dentist task" }] };
    expect(sessionLooksAbandoned({ ...stale, agent_type: "claude_code" }, true, now)).toBe(true);
    expect(sessionLooksAbandoned({ ...stale, agent_type: HOSTED_AGENT_TYPE }, true, now)).toBe(false);
  });
});
