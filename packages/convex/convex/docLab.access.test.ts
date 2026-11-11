import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { LAB_RUNS_PER_MINUTE, admitRun, labPromptWithinLimits } from "./docLab";
import { MODEL_CALL_LIMITS } from "@codecast/shared/contracts/modelCall";

// The web Lab sends a doc's text to a model under the vendor gate of the doc
// the caller names: the caller must be able to read that doc, and the model
// call is metered per person.

const TEAM = "teams_acme";
const ANA = "users_ana";
const BEN = "users_ben";
const EVE = "users_eve";

function ctxAs(userId: string | null) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ANA }, { _id: BEN }, { _id: EVE }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "member" },
    ],
    docs: [
      { _id: "doc_team", user_id: ANA, team_id: TEAM, workspace: `team:${TEAM}`, title: "Team doc" },
      { _id: "doc_mine", user_id: ANA, team_id: TEAM, workspace: `user:${ANA}`, title: "Private doc" },
    ],
    rate_limits: [],
  };
  const db: any = makeFakeDb(tables);
  db.normalizeId = (table: string, id: string) => ((tables[table] ?? []).some((r) => r._id === id) ? id : null);
  return { db, auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|sess`, tokenIdentifier: "x" } : null) } } as any;
}

const admit = (ctx: any, doc_id: string) => (admitRun as any)._handler(ctx, { doc_id });

describe("docLab.admitRun", () => {
  test("refuses a doc the caller cannot read", async () => {
    await expect(admit(ctxAs(EVE), "doc_team")).rejects.toThrow(/Doc not found/);
    await expect(admit(ctxAs(BEN), "doc_mine")).rejects.toThrow(/Doc not found/);
    await expect(admit(ctxAs(ANA), "not_a_doc")).rejects.toThrow(/Doc not found/);
    await expect(admit(ctxAs(null), "doc_team")).rejects.toThrow(/Unauthorized/);
  });

  test("admits the owner and a teammate of a team doc", async () => {
    expect(await admit(ctxAs(ANA), "doc_mine")).toBe("doc_mine");
    expect(await admit(ctxAs(BEN), "doc_team")).toBe("doc_team");
  });

  test("meters runs per person", async () => {
    const ctx = ctxAs(ANA);
    for (let i = 0; i < LAB_RUNS_PER_MINUTE; i++) await admit(ctx, "doc_mine");
    await expect(admit(ctx, "doc_mine")).rejects.toThrow(/Rate limit/);
  });
});

describe("docLab input size (F72)", () => {
  test("a draft past the server model call cap is refused before anything is sent", () => {
    const huge = "word ".repeat(MODEL_CALL_LIMITS.prompt_chars / 5 + 1);
    expect(() => labPromptWithinLimits({ tool: "typos" }, huge)).toThrow(/reads up to/);
    expect(() => labPromptWithinLimits({ tool: "alternatives", target: "x", context: huge }, "")).toThrow(/reads up to/);
  });

  test("an ordinary draft passes", () => {
    expect(labPromptWithinLimits({ tool: "typos" }, "A short draft with a tpyo.").prompt).toContain("tpyo");
  });
});
