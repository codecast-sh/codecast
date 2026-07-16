import { describe, expect, test } from "bun:test";
import { deriveProducingParents } from "./conversations";

// The sessionsLiveness overlay used to run a by_parent_conversation_id scan for
// every idle inbox row to decide "does a producing subagent child keep this
// parent working?" — one indexed query per row, which blew Convex's system
// operation budget on heartbeat recomputes for a full inbox window. The scan is
// now replaced by ONE derived set; these tests pin the derivation to the exact
// acceptance rule of subagentKeepsParentWorking (see inboxFilters.ts): a child
// counts only with output in the last 5 minutes, or while live with an active
// agent status.

const NOW = 1_700_000_000_000;
const PARENT = "conv_parent";

function child(overrides: Record<string, any>) {
  return {
    _id: "conv_child",
    parent_conversation_id: PARENT,
    is_subagent: true,
    status: "active",
    updated_at: NOW - 60 * 1000, // 1 min ago — inside the producing grace
    ...overrides,
  };
}

function maps(overrides: Partial<{ liveConvIds: Set<string>; agentStatusMap: Map<string, any> }> = {}) {
  return {
    liveConvIds: overrides.liveConvIds ?? new Set<string>(),
    agentStatusMap: overrides.agentStatusMap ?? new Map(),
  };
}

describe("deriveProducingParents", () => {
  test("child with recent output keeps its parent working", () => {
    const parents = deriveProducingParents([child({})], maps(), NOW);
    expect(parents.has(PARENT)).toBe(true);
  });

  test("quiet, non-live child does not", () => {
    const parents = deriveProducingParents(
      [child({ updated_at: NOW - 10 * 60 * 1000 })],
      maps(),
      NOW,
    );
    expect(parents.size).toBe(0);
  });

  test("quiet child that is live with an active agent status does", () => {
    const parents = deriveProducingParents(
      [child({ updated_at: NOW - 10 * 60 * 1000 })],
      maps({
        liveConvIds: new Set(["conv_child"]),
        agentStatusMap: new Map([["conv_child", "working"]]),
      }),
      NOW,
    );
    expect(parents.has(PARENT)).toBe(true);
  });

  test("live but idle-status child does not", () => {
    const parents = deriveProducingParents(
      [child({ updated_at: NOW - 10 * 60 * 1000 })],
      maps({
        liveConvIds: new Set(["conv_child"]),
        agentStatusMap: new Map([["conv_child", "idle"]]),
      }),
      NOW,
    );
    expect(parents.size).toBe(0);
  });

  test("recent non-subagent child (plain fork) does not", () => {
    const parents = deriveProducingParents([child({ is_subagent: false })], maps(), NOW);
    expect(parents.size).toBe(0);
  });

  test("completed child does not", () => {
    const parents = deriveProducingParents([child({ status: "completed" })], maps(), NOW);
    expect(parents.size).toBe(0);
  });

  test("rows without a parent are ignored", () => {
    const parents = deriveProducingParents(
      [{ _id: "conv_top", is_subagent: false, status: "active", updated_at: NOW }],
      maps(),
      NOW,
    );
    expect(parents.size).toBe(0);
  });
});
