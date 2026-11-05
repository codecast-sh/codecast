import { describe, expect, test } from "bun:test";
import { userMayRead } from "./sessionDecisions";
import { passCore } from "./decisionHandoff";
import { HOST, BOSS, OWNER2, TEAM, NOW, seed, twoOptions, askApproach } from "./sessionDecisions.testkit";

describe("the team's line decisions", () => {
  const MATE = "users_mate" as any;
  const lineSeed = () => {
    const s = seed({
      users: [{ _id: HOST, name: "Host" }, { _id: BOSS, name: "Boss" }, { _id: OWNER2, name: "Owner Two" }, { _id: MATE, name: "Mate" }],
      team_memberships: [
        { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
        { _id: "m2", user_id: BOSS, team_id: TEAM, role: "admin" },
        { _id: "m3", user_id: MATE, team_id: TEAM, role: "member" },
      ],
    });
    // A station's private session asked it: no team, so the conversation clause opens it to nobody else.
    s.tables.conversations.push({ _id: "conversations_station", session_id: "sess-station", user_id: HOST, owner_user_id: HOST, message_count: 1 });
    s.tables.session_decisions.push(
      { _id: "session_decisions_line", short_id: "sd-40", conversation_id: "conversations_station", user_id: HOST, question: "Ship it?", options: twoOptions, status: "pending", task_id: "tasks_t1", workflow_run_id: "workflow_runs_r1", trial: true, asked_user_ids: [HOST], holder: { kind: "user", id: HOST }, holder_key: `user:${HOST}`, created_at: NOW },
      { _id: "session_decisions_plain", short_id: "sd-41", conversation_id: "conversations_station", user_id: HOST, question: "Lunch?", options: twoOptions, status: "pending", task_id: "tasks_t1", asked_user_ids: [HOST], created_at: NOW },
    );
    return s;
  };

  test("a teammate who can read the problem reads its line decision; a stranger and a plain decision stay shut", async () => {
    const { ctx, tables } = lineSeed();
    const [line, plain] = tables.session_decisions;
    expect(await userMayRead(ctx, MATE, line)).toBe(true);
    expect(await userMayRead(ctx, OWNER2, line)).toBe(false);
    expect(await userMayRead(ctx, MATE, plain)).toBe(false);
  });

  test("a trial's line decision is assigned to a teammate: it is theirs and enters their queue; a role is refused", async () => {
    const { ctx, tables } = lineSeed();
    expect(await passCore(ctx, HOST, "sd-40", { kind: "role", id: "org_roles_head" })).toEqual({ error: "A trial run's question stays with its trial" });
    expect(await passCore(ctx, MATE, "sd-40", { kind: "user", id: MATE })).toEqual({ passed: true });
    const row = tables.session_decisions[0];
    expect(row.passed_to).toMatchObject({ kind: "user", id: MATE, by: MATE });
    expect(row.asked_user_ids).toEqual([MATE]);
    expect(tables.decision_inbox.map((i: any) => [i.user_id, i.status])).toEqual([[MATE, "pending"]]);
    // Reassigned, it moves to the next teammate's queue.
    expect(await passCore(ctx, HOST, "sd-40", { kind: "user", id: BOSS })).toEqual({ passed: true });
    expect(tables.decision_inbox.map((i: any) => i.user_id)).toEqual([BOSS]);
  });

  test("asked again, a decision given to a teammate stays theirs", async () => {
    const { ctx, tables } = seed();
    await askApproach(ctx);
    expect(await passCore(ctx, HOST, "sd-1", { kind: "user", id: BOSS })).toEqual({ passed: true });
    await askApproach(ctx);
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.session_decisions[0].asked_user_ids).toEqual([BOSS]);
    expect(tables.decision_inbox.map((i: any) => i.user_id)).toEqual([BOSS]);
  });
});
