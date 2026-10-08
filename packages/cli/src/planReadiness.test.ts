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

  test("backlog is not started (open) but never ready (TG1), and not blocked either", () => {
    const r = planReadiness([t("ct-1", { status: "backlog" }), t("ct-2")]);
    expect(ids(r.open)).toEqual(["ct-1", "ct-2"]);
    expect(ids(r.ready)).toEqual(["ct-2"]);
    expect(ids(r.blocked)).toEqual([]);
  });

  test("a blocker outside the plan was not looked up, so it blocks", () => {
    const r = planReadiness([t("ct-2", { blocked_by: ["ct-99"] })]);
    expect(ids(r.blocked)).toEqual(["ct-2"]);
  });

  test("a parent in the plan being worked holds its subtasks; one outside the plan does not", () => {
    const r = planReadiness([
      t("ct-1", { status: "in_progress" }),
      t("ct-2", { parent_id: "id_ct-1" }),
      t("ct-3", { parent_id: "id_elsewhere" }),
    ]);
    expect(ids(r.ready)).toEqual(["ct-3"]);
  });
});
