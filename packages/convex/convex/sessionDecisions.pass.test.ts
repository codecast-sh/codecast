import { describe, expect, test } from "bun:test";
import { answerCore, listForUserCore, personMayResolve, reroutePendingDecisionsForConversation } from "./sessionDecisions";
import { passCore } from "./decisionHandoff";
import { HOST, BOSS, OWNER2, NOW, seed, askApproach, seated, linesIn } from "./testDecisions";

// A person hands an open question to someone else (passCore): a teammate takes
// it into their queue, a role is woken on it and may answer it without a grant,
// and neither ownership moves nor holder refreshes take it back.
describe("passing a decision", () => {
  test("to a teammate: it leaves the asked people's queues and enters theirs, and rerouting keeps it there", async () => {
    const { ctx, tables } = seed();
    await askApproach(ctx);
    const id = tables.session_decisions[0]._id;
    expect(await passCore(ctx, HOST, "sd-1", { kind: "user", id: BOSS })).toEqual({ passed: true });
    const row = tables.session_decisions[0];
    expect(row.asked_user_ids).toEqual([BOSS]);
    expect(row.holder).toEqual({ kind: "user", id: BOSS });
    expect(row.passed_to).toMatchObject({ kind: "user", id: BOSS, by: HOST });
    expect(tables.decision_inbox.map((i) => [i.user_id, i.status])).toEqual([[BOSS, "pending"]]);
    expect((await listForUserCore(ctx, HOST, NOW)).map((d) => d._id)).toEqual([]);
    expect((await listForUserCore(ctx, BOSS, NOW)).map((d) => d._id)).toEqual([id]);
    await reroutePendingDecisionsForConversation(ctx, "conversations_ask" as any, NOW);
    expect(tables.session_decisions[0].asked_user_ids).toEqual([BOSS]);
  });

  test("to someone off the session's team, a bot, or a stranger's decision is refused", async () => {
    const { ctx, tables } = seed({ users: [{ _id: HOST, name: "Host" }, { _id: BOSS, name: "Boss" }, { _id: OWNER2, name: "Owner Two" }, { _id: "users_bot", name: "Bot", is_bot: true }] });
    await askApproach(ctx);
    expect(await passCore(ctx, HOST, "sd-1", { kind: "user", id: OWNER2 })).toEqual({ error: "Owner Two is not on this session's team" });
    expect(await passCore(ctx, HOST, "sd-1", { kind: "user", id: "users_bot" })).toEqual({ error: "Pass it to a person or a role" });
    expect(await passCore(ctx, "users_nobody" as any, "sd-1", { kind: "user", id: BOSS })).toEqual({ error: "Unauthorized: not your decision" });
    expect(tables.session_decisions[0].passed_to).toBeUndefined();
  });

  test("to a role: the role is woken, holds it, and its session answers without a grant", async () => {
    const { ctx, tables } = await seated();
    await askApproach(ctx, "sess-plain");
    expect(tables.session_decisions[0].holder).toEqual({ kind: "user", id: HOST });
    expect(await passCore(ctx, HOST, "sd-1", { kind: "role", id: "org_roles_head" })).toEqual({ passed: true });
    const row = tables.session_decisions[0];
    expect(row.holder).toEqual({ kind: "role", id: "org_roles_head" });
    expect(row.hops.map((h: any) => h.role_id)).toContain("org_roles_head");
    expect(linesIn(tables, "conversations_head").some((l) => l.includes("sd-1"))).toBe(true);
    // The people keep the card, held by the role, so any of them can still answer.
    expect(personMayResolve(row, HOST)).toBe(true);
    const r = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-head", answer_index: 1 });
    expect(r.error).toBeUndefined();
    expect(r.answered_by).toEqual({ kind: "role", id: "org_roles_head" });
    expect(tables.session_decisions[0].status).toBe("answered");
  });

  test("to a role with no running session is refused and changes nothing", async () => {
    const { ctx, tables } = seed();
    await askApproach(ctx, "sess-plain");
    expect(await passCore(ctx, HOST, "sd-1", { kind: "role", id: "org_roles_head" })).toEqual({ error: "Head has no running session to hear it" });
    expect(tables.session_decisions[0].holder).toEqual({ kind: "user", id: HOST });
  });
});
