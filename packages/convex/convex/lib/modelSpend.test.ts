import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import { HOUR_MS, projectModelSpend, recordModelSpend } from "./modelSpend";

const T = 1_791_800_000_000;
const A = "projects_a" as any, B = "projects_b" as any;

describe("model spend by project and hour", () => {
  test("a call is charged to the hour it settled in, split evenly among the projects it served; one that served none files unattributed", async () => {
    const tables: Record<string, any[]> = { model_spend_hours: [] };
    const ctx = { db: makeFakeDb(tables) };
    await recordModelSpend(ctx, "team:t", [A], "judge", 0.3, T);
    await recordModelSpend(ctx, "team:t", [A], "call", 0.2, T + 60_000);
    await recordModelSpend(ctx, "team:t", [A, B], "judge", 1, T + 2 * HOUR_MS);
    await recordModelSpend(ctx, "team:t", [], "grouping", 0.05, T);
    expect(await projectModelSpend(ctx, A, T)).toMatchObject({ usd: 1, calls: 3, by_purpose: { judge: 0.8, grouping: 0, call: 0.2 } });
    expect(await projectModelSpend(ctx, B, T)).toMatchObject({ usd: 0.5, calls: 1 });
    // From a later hour on, the earlier hour is not the project's spend any more.
    expect(await projectModelSpend(ctx, A, T + 2 * HOUR_MS)).toMatchObject({ usd: 0.5, calls: 1 });
    expect(tables.model_spend_hours.filter((r) => !r.project_id)).toEqual([expect.objectContaining({ usd: 0.05, calls: 1, by_purpose: { judge: 0, grouping: 0.05, call: 0 } })]);
  });
});
