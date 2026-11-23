import { describe, expect, test } from "bun:test";
import { answerCore, GRANT_TTL_MS } from "./sessionDecisions";
import { performSetSessionDriver } from "./lib/sessionRolePause";
import { HOST, BOSS, OWNER2, NOW, askApproach, seated, linesIn } from "./testDecisions";

// A person who takes the wheel of a session filed under a role pauses the
// role (org-roles-run-work.md R1): the paused role hears none of the
// session's questions and answers none of them; they are the owners', the
// driver among them, from the moment the wheel changes hands.
describe("a paused role hears no decisions", () => {
  const grant = { _id: "decision_grants_g1", role_id: "org_roles_lead", category: "approach", scope_key: "role:org_roles_lead", granted_by: BOSS, granted_at: NOW, expires_at: Date.now() + GRANT_TTL_MS };

  test("asked while a person drives: no role hears or holds it, and it is in the owners' queue at once", async () => {
    const { ctx, tables } = await seated();
    tables.decision_grants.push(grant);
    await ctx.db.patch("conversations_ask", { driver_user_id: HOST });
    const asked = await askApproach(ctx);
    expect(asked.holder).toEqual({ kind: "user", id: HOST });
    const row = tables.session_decisions[0];
    expect(row.hops).toEqual([]);
    expect(new Set(row.asked_user_ids)).toEqual(new Set([HOST, OWNER2]));
    expect(new Set(tables.decision_inbox.map((i) => i.user_id))).toEqual(new Set([HOST, OWNER2]));
    expect(linesIn(tables, "conversations_standing")).toEqual([]);
  });

  test("taking the wheel moves an open question off the role to the owners; the role may no longer answer it", async () => {
    const { ctx, tables } = await seated();
    tables.decision_grants.push(grant);
    const asked = await askApproach(ctx);
    expect(asked.holder).toEqual({ kind: "role", id: "org_roles_lead" });
    expect(tables.decision_inbox).toEqual([]);

    await performSetSessionDriver(ctx, HOST, { session_id: "sess-ask", driver: { kind: "user", user_id: HOST } });
    const row = tables.session_decisions[0];
    expect(row.holder).toEqual({ kind: "user", id: HOST });
    expect(new Set(tables.decision_inbox.map((i) => i.user_id))).toEqual(new Set([HOST, OWNER2]));
    const r = await answerCore(ctx, { userId: HOST }, { decision_id: "sd-1", session_id: "sess-standing", answer_index: 1 });
    expect(r.error).toContain("is paused on the session that asked: a person is working in it");
    expect(tables.session_decisions[0].status).toBe("pending");

    // Handing the wheel back gives the role its hold again.
    await performSetSessionDriver(ctx, HOST, { session_id: "sess-ask", driver: { kind: "role" } });
    expect(tables.session_decisions[0].holder).toEqual({ kind: "role", id: "org_roles_lead" });
  });
});
