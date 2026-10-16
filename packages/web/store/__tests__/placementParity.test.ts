import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// The dev parity check at the end of placeInboxRows (assertPlacementParity)
// compares the incremental placements with the pure projection. A declared
// in-flight overlay moves a row on purpose, and a teammate rides its lead
// wherever the overlay put it, so the check must compare riders against the
// same ride, not report them as drift (ct-56078, convergence seed 21).

const T0 = Date.now();
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0 - 60_000,
  agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false,
  title: id,
  ...(over as any),
});

describe("placement parity check", () => {
  let errors: string[];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errors = [];
    spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  it("does not report teammates riding a lead whose answer is in flight", () => {
    const lead = row("lead1", { agent_status: "permission_blocked", is_idle: false });
    const mate1 = row("mate1", { spawned_by_conversation_id: "lead1", agent_team_name: "team", agent_status: "working", is_idle: false });
    const mate2 = row("mate2", { spawned_by_conversation_id: "lead1", agent_team_name: "team", agent_status: "stopped" });
    const placed = placeSections(
      Object.fromEntries([lead, mate1, mate2].map((s) => [s._id, s])),
      new Set(["lead1"]),
    );
    expect(placed.placements.get("lead1")?.bucket).toBe("working");
    expect(placed.placements.get("mate1")?.bucket).toBe("working");
    expect(placed.placements.get("mate2")?.bucket).toBe("working");
    expect(errors.filter((e) => e.includes("[placeInboxRows]"))).toEqual([]);
  });
});
