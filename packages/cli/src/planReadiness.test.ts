import { describe, expect, test } from "bun:test";
import { planReadiness } from "./planReadiness";

const t = (short_id: string, over: Record<string, unknown> = {}) => ({ _id: `id_${short_id}`, short_id, status: "open", ...over });
const ids = (rows: { short_id: string }[]) => rows.map((r) => r.short_id);

describe("planReadiness", () => {
  test("a finished or dropped blocker clears, an open one holds, an _id ref resolves", () => {
    const r = planReadiness([
      t("ct-1", { status: "done" }),
      t("ct-2", { status: "dropped" }),
      t("ct-3", { blocked_by: ["ct-1", "id_ct-2"] }),
      t("ct-4", { blocked_by: ["ct-3"] }),
    ]);
    expect(ids(r.ready)).toEqual(["ct-3"]);
    expect(ids(r.blocked)).toEqual(["ct-4"]);
  });

  test("backlog is not started (open) but never ready (TG1), not blocked either, and listed as parked", () => {
    const r = planReadiness([t("ct-1", { status: "backlog" }), t("ct-2")]);
    expect(ids(r.open)).toEqual(["ct-1", "ct-2"]);
    expect(ids(r.ready)).toEqual(["ct-2"]);
    expect(ids(r.blocked)).toEqual([]);
    expect(ids(r.parked)).toEqual(["ct-1"]);
  });

  test("a blocker outside the plan that nobody looked up blocks", () => {
    const r = planReadiness([t("ct-2", { blocked_by: ["ct-99"] })]);
    expect(ids(r.blocked)).toEqual(["ct-2"]);
  });

  test("blockers outside the plan resolve from graph_outside: done clears, open holds, not found is missing", () => {
    const outside = {
      tasks: [{ _id: "id_ct-90", short_id: "ct-90", status: "done" }, { _id: "id_ct-91", short_id: "ct-91", status: "open" }],
      searched: ["ct-90", "ct-91", "ct-404"],
    };
    const r = planReadiness([
      t("ct-1", { blocked_by: ["ct-90"] }),
      t("ct-2", { blocked_by: ["ct-91"] }),
      t("ct-3", { blocked_by: ["ct-404"] }),
    ], outside);
    expect(ids(r.ready)).toEqual(["ct-1", "ct-3"]);
    expect(ids(r.blocked)).toEqual(["ct-2"]);
  });

  test("a parent being worked holds its subtasks, in the plan or outside it; one not looked up holds them too", () => {
    const outside = {
      tasks: [{ _id: "id_ct-80", short_id: "ct-80", status: "in_review" }, { _id: "id_ct-81", short_id: "ct-81", status: "open" }],
      searched: ["id_ct-80", "id_ct-81", "id_gone"],
    };
    const tasks = [
      t("ct-1", { status: "in_progress" }),
      t("ct-2", { parent_id: "id_ct-1" }),
      t("ct-3", { parent_id: "id_ct-80" }),
      t("ct-4", { parent_id: "id_ct-81" }),
      t("ct-5", { parent_id: "id_gone" }),
    ];
    expect(ids(planReadiness(tasks, outside).ready)).toEqual(["ct-4", "ct-5"]);
    expect(ids(planReadiness(tasks).ready)).toEqual([]);
  });
});
