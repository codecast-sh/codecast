import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeSessionsLiveness, _resetChildAuqProbeCacheForTests } from "./conversations";
import { ME, MIN, H, NOW, EPOCH, conv, db } from "./conversations.projection.testkit";

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); _resetChildAuqProbeCacheForTests(); });
afterEach(() => { nowSpy.mockRestore(); });

// An Agent-tool subagent has no managed session of its own, so only the
// subagent window brings it to the liveness overlay.
describe("a session-less subagent keeps its settled parent working", () => {
  const lead = () => conv("p", { updated_at: EPOCH - 3 * H });
  const child = (extra: Record<string, unknown>) => conv("c", {
    is_subagent: true, parent_conversation_id: "conversations_p", status: "active", message_count: 12, ...extra,
  });

  test("while it is quiet inside an open tool call", async () => {
    const callAt = EPOCH - 12 * MIN;
    const tables = { conversations: [lead(), child({ updated_at: callAt, last_message_role: "assistant", activity: { text: "bun test", tool: "Bash", at: callAt } })] };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_p.bucket).toBe("working");
  });

  test("on the team board too, for the viewer's own lead", async () => {
    const TEAM = "teams_1";
    const callAt = EPOCH - 12 * MIN;
    const tables = {
      teams: [{ _id: TEAM }],
      team_memberships: [{ _id: "tm_me", team_id: TEAM, user_id: ME }],
      users: [{ _id: ME, name: "Me" }],
      conversations: [
        conv("p", { updated_at: EPOCH - 3 * H, team_id: TEAM, is_private: false }),
        child({ team_id: TEAM, is_private: false, updated_at: callAt, last_message_role: "assistant", activity: { text: "bun test", tool: "Bash", at: callAt } }),
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any, TEAM as any);
    expect(liveness.conversations_p.bucket).toBe("working");
  });

  test("not once its call returned and it went quiet", async () => {
    const tables = { conversations: [lead(), child({ updated_at: EPOCH - 12 * MIN, last_message_role: "user", activity: { text: "bun test", tool: "Bash", at: EPOCH - 13 * MIN } })] };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_p.bucket).not.toBe("working");
  });
});
