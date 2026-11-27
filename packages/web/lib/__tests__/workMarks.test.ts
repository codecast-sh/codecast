// The work marks are built from ids the call sites spell from live values
// (`task.${category}`, `task.priority.${level}`, `plan.${status}`, `pr.${state}`).
// Each value those vocabularies can hold must name a registered mark, or the
// glyph renders unregistered and the legend never lists it.
import { describe, expect, test } from "bun:test";
import { TASK_STATUS_CATEGORIES, PLAN_STATES } from "@codecast/shared/tasks";
import { MARK_BY_ID } from "../marks";
import { taskStatusMarkId } from "../marks/work";
import { TASK_PRIORITY, taskPriorityLevel } from "../taskPriority";
import { PLAN_STATUS_CONFIG } from "../planStatus";
import { PR_STATE_META } from "../prView";
import { TYPE_LABEL } from "../entityDisplay";

const registered = (id: string) => expect(MARK_BY_ID.has(id), id).toBe(true);

describe("work marks", () => {
  test("every task category, priority, plan status and plan state is registered", () => {
    for (const c of TASK_STATUS_CATEGORIES) registered(taskStatusMarkId(c));
    for (const p of Object.keys(TASK_PRIORITY)) registered(`task.priority.${p}`);
    for (const s of Object.keys(PLAN_STATUS_CONFIG)) registered(`plan.${s}`);
    for (const s of PLAN_STATES) registered(`plan.${s}`);
    for (const s of Object.keys(PR_STATE_META)) registered(`pr.${s}`);
  });

  test("every entity kind a card draws has a mark", () => {
    for (const type of Object.keys(TYPE_LABEL)) {
      if (type === "task" || type === "pr") continue; // drawn as their state
      registered(`entity.${type === "initiative" ? "goal" : type}`);
    }
  });

  test("an unknown status or priority falls back to a registered mark", () => {
    expect(taskStatusMarkId("draft")).toBe("task.open");
    expect(taskStatusMarkId(undefined)).toBe("task.open");
    expect(taskPriorityLevel(undefined)).toBe("medium");
    expect(taskPriorityLevel("toString", "none")).toBe("none");
    expect(taskPriorityLevel("urgent")).toBe("urgent");
  });
});
