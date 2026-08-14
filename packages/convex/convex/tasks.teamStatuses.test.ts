import { describe, expect, test } from "bun:test";
import { resolveStatusWrite } from "./tasks";
import { makeFakeDb } from "./testDb";

// Per-team task statuses (Linear-style). resolveStatusWrite is the ONE rule
// for how {status, status_id} args become a write: every mutation that moves
// a task's status routes through it, so these tests pin the whole contract.

const TEAM = "teams_a" as any;

const team = (statuses?: any[]) => ({
  _id: TEAM,
  name: "A",
  ...(statuses ? { task_statuses: statuses } : {}),
});

const CUSTOM = [
  { id: "backlog", name: "Backlog", category: "backlog" },
  { id: "open", name: "Todo", category: "open" },
  { id: "in_progress", name: "In Progress", category: "in_progress" },
  { id: "st_wip", name: "Working on", category: "in_progress" },
  { id: "in_review", name: "Verify", category: "in_review" },
  { id: "done", name: "Done", category: "done" },
  { id: "st_ship", name: "Shipped", category: "done" },
  { id: "dropped", name: "Dropped", category: "dropped" },
];

function ctx(statuses?: any[]) {
  const db = makeFakeDb({ teams: [] }) as any;
  const t = team(statuses);
  const realGet = db.get.bind(db);
  db.get = async (id: any) => (id === TEAM ? t : realGet(id));
  return { db };
}

describe("resolveStatusWrite — category only", () => {
  test("a category change clears the stale refinement", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "in_progress", { status: "open" });
    expect(r.status).toBe("open");
    expect(r.statusId).toEqual({ set: true, value: undefined });
  });

  test("a same-category write keeps the refinement (cast task start on a refined task)", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "in_progress", { status: "in_progress" });
    expect(r.statusId.set).toBe(false);
  });

  test("no status args touches nothing", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "open", {});
    expect(r.status).toBeUndefined();
    expect(r.statusId.set).toBe(false);
  });

  test("an invalid category is refused with the category vocabulary", async () => {
    await expect(
      resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status: "working_on" }),
    ).rejects.toThrow(/Invalid task status/);
  });
});

describe("resolveStatusWrite — status_id", () => {
  test("a custom status sets its category and stores the id", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status_id: "st_wip" });
    expect(r.status).toBe("in_progress");
    expect(r.statusId).toEqual({ set: true, value: "st_wip" });
  });

  test("picking a category default stores no refinement", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status_id: "in_progress" });
    expect(r.status).toBe("in_progress");
    expect(r.statusId).toEqual({ set: true, value: undefined });
  });

  test("empty string clears back to the category default", async () => {
    const r = await resolveStatusWrite(ctx(CUSTOM), TEAM, "in_progress", { status_id: "" });
    expect(r.statusId).toEqual({ set: true, value: undefined });
  });

  test("an id the team does not define is refused", async () => {
    await expect(
      resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status_id: "st_nope" }),
    ).rejects.toThrow(/Unknown status/);
  });

  test("a status sent alongside must agree with the id's category", async () => {
    await expect(
      resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status: "open", status_id: "st_wip" }),
    ).rejects.toThrow(/category/);
    const ok = await resolveStatusWrite(ctx(CUSTOM), TEAM, "open", { status: "done", status_id: "st_ship" });
    expect(ok.status).toBe("done");
    expect(ok.statusId).toEqual({ set: true, value: "st_ship" });
  });

  test("a personal task (no team) resolves against the defaults", async () => {
    const ok = await resolveStatusWrite(ctx(), undefined, "open", { status_id: "in_review" });
    expect(ok.status).toBe("in_review");
    expect(ok.statusId).toEqual({ set: true, value: undefined });
    await expect(
      resolveStatusWrite(ctx(), undefined, "open", { status_id: "st_wip" }),
    ).rejects.toThrow(/Unknown status/);
  });

  test("a team with no config resolves against the defaults too", async () => {
    const ok = await resolveStatusWrite(ctx(), TEAM, "open", { status_id: "done" });
    expect(ok.status).toBe("done");
    expect(ok.statusId).toEqual({ set: true, value: undefined });
  });
});
