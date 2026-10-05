import { describe, expect, it } from "bun:test";
import { agentFleetCounts, sessionAwakeAt } from "../liveness";

const NOW = 10_000_000;
const working = { message_count: 5, updated_at: NOW - 1000, agent_status: "working", agent_status_updated_at: NOW - 1000, last_heartbeat: NOW - 1000 };
const idleAwake = { message_count: 5, updated_at: NOW - 3600_000, agent_status: "idle", agent_status_updated_at: NOW - 3600_000, last_heartbeat: NOW - 1000 };
const asleep = { message_count: 5, updated_at: NOW - 3600_000, agent_status: "idle", last_heartbeat: NOW - 3600_000 };
const hibernated = { ...idleAwake, agent_status: "hibernated" };

describe("agentFleetCounts", () => {
  it("splits working and awake across sessions and subagents", () => {
    const rows = [
      { ...working, sub: false },
      { ...idleAwake, sub: false },
      { ...asleep, sub: false },
      { ...hibernated, sub: false },
      { ...working, sub: true },
      { ...working, sub: true },
      { ...idleAwake, sub: true },
    ];
    expect(agentFleetCounts(rows, (r) => r.sub, NOW)).toEqual({
      sessions: { working: 1, awake: 2 },
      subagents: { working: 2, awake: 3 },
    });
  });

  it("never counts a killed row as awake", () => {
    expect(sessionAwakeAt({ ...working, inbox_killed_at: NOW - 5 }, NOW)).toBe(false);
  });
});
