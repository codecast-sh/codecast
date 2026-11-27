// The work marks are built from ids the call sites spell from live values
// (`task.${category}`, `task.priority.${level}`, `plan.${status}`, `pr.${state}`).
// Each value those vocabularies can hold must name a registered mark, or the
// glyph renders unregistered and the legend never lists it.
import { describe, expect, test } from "bun:test";
import { TASK_STATUS_CATEGORIES, PLAN_STATES } from "@codecast/shared/tasks";
import { MARK_BY_ID } from "../marks";
import { deployMarkId, taskStatusMarkId } from "../marks/work";
import { DEPLOY_STATE_ICON, REACH_ICON } from "../deploys/deployLook";
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

  test("every deploy state and change state a pill draws is registered", () => {
    for (const s of Object.keys(DEPLOY_STATE_ICON)) registered(deployMarkId(s));
    registered(deployMarkId("live", true));
    for (const s of Object.keys(REACH_ICON)) registered(`deploy.${s}`);
    for (const s of ["done", "active", "waiting", "you", "back", "failed", "skipped", "stopped"]) registered(`change.now.${s}`);
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
