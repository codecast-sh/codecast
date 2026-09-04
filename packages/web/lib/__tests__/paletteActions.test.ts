import { describe, expect, test } from "bun:test";
import { paletteActions, paletteDigitIndex, paletteObjectPath, type PaletteTargetType } from "../paletteActions";
import { resolvePaletteTarget } from "../paletteTarget";

const session = { _id: "session-1", user_id: "me", agent_type: "claude_code", message_count: 3, title: "Example" };
const keys = (type: PaletteTargetType, row: any = session, user = "me") => paletteActions(type, [row], user, true).map(a => a.key);

describe("command menu action coverage", () => {
  test("session operations include agent switching, forks, rename and lifecycle actions", () => {
    expect(keys("session")).toEqual(expect.arrayContaining(["agent_switch", "agent_fork", "rename", "model", "session_pin", "session_favorite", "session_stash", "session_stash_hide", "session_defer", "session_dormant", "session_kill", "copy", "copylink", "forward", "newtab"]));
  });
  test("foreign and unresolved sessions expose reading and sharing only", () => {
    for (const user of ["other", ""]) {
      expect(keys("session", session, user)).toEqual(["open", "newtab", "copy", "copylink", "forward"]);
    }
    expect(keys("session", { ...session, user_id: undefined, authorName: "Teammate" }, "me")).toEqual(["open", "newtab", "copy", "copylink", "forward"]);
    expect(keys("session", { ...session, user_id: undefined, is_own: false }, "me")).toEqual(["open", "newtab", "copy", "copylink", "forward"]);
  });
  test("assigned and routed sessions retain their owner controls", () => {
    expect(keys("session", { ...session, user_id: "other", owned_by_me: true })).toContain("agent_switch");
    expect(keys("session", { ...session, user_id: "other", owner_user_id: "me" })).toContain("agent_fork");
  });
  test("stashed sessions can be restored", () => {
    const actions = keys("session", { ...session, inbox_stashed_at: 123 });
    expect(actions).toContain("session_restore");
    expect(actions).toContain("session_kill");
    expect(actions).not.toContain("session_stash");
  });
  test("session-specific navigation appears when the backing metadata exists", () => {
    const actions = keys("session", {
      ...session,
      parent_conversation_id: "parent",
      git_branch: "feature/palette",
      project_path: "/repo",
    });
    expect(actions).toEqual(expect.arrayContaining(["session_parent", "session_branch", "session_files"]));
  });
  test("task and document menus cover their context menu verbs", () => {
    expect(keys("task", { _id: "task", parent_id: "parent" })).toEqual(expect.arrayContaining(["status", "priority", "labels", "assign", "parent", "remove_parent", "agent_run", "drop", "copylink", "forward"]));
    expect(keys("doc", { _id: "doc" })).toEqual(expect.arrayContaining(["type", "labels", "pin", "archive", "rename", "copylink", "forward"]));
  });
  test("plan and project menus cover their context menu verbs", () => {
    expect(keys("plan", { _id: "plan" })).toEqual(expect.arrayContaining(["plan_status", "rename", "create_task", "open", "newtab", "copy", "copylink", "forward"]));
    expect(keys("project", { _id: "project", target_date: 1 })).toEqual(expect.arrayContaining(["project_status", "rename", "deadline", "clear_deadline", "create_task", "create_plan", "create_doc", "open", "newtab", "copy", "copylink", "forward"]));
  });
  test("bulk menus do not silently rename or copy only the first item", () => {
    for (const type of ["task", "doc"] as const) {
      const actions = paletteActions(type, [{ _id: "1" }, { _id: "2" }], "me").map(a => a.key);
      expect(actions).not.toContain("rename");
      expect(actions).not.toContain("copy");
      expect(actions).not.toContain("pin");
    }
  });
  test("trigger actions follow lifecycle eligibility", () => {
    const paused = keys("trigger", { _id: "t", status: "paused" });
    expect(paused).toContain("trigger_resume");
    expect(paused).not.toContain("trigger_pause");
    const done = keys("trigger", { _id: "t", status: "completed" });
    expect(done).toEqual(expect.arrayContaining(["trigger_reactivate", "trigger_delete", "trigger_duplicate", "trigger_prompt"]));
    expect(done).not.toContain("trigger_cancel");
    expect(done).not.toContain("trigger_edit");
  });
  test("mnemonics are unique within each object level", () => {
    for (const type of ["session", "task", "doc", "plan", "project", "trigger"] as const) {
      const letters = paletteActions(type, [{ ...session, status: "scheduled" }], "me", true).flatMap(a => a.hotkey ? [a.hotkey] : []);
      expect(new Set(letters).size).toBe(letters.length);
    }
  });
  test("sharing is omitted when chat is disabled", () => {
    expect(paletteActions("task", [{ _id: "t" }], "me", false).map(a => a.key)).not.toContain("forward");
  });
});

describe("command tree targeting", () => {
  test("detail routes resolve complete cached rows, including short IDs", () => {
    const state = { plans: { p1: { _id: "p1", short_id: "pl-7", title: "Plan", status: "paused" } }, projects: { p2: { _id: "p2", title: "Project" } }, agentTasks: { t1: { _id: "t1", short_id: "tr-7", status: "paused" } } };
    expect(resolvePaletteTarget(state, "/plans/pl-7")?.targets[0].status).toBe("paused");
    expect(resolvePaletteTarget(state, "/projects/p2")?.targetType).toBe("project");
    expect(resolvePaletteTarget(state, "/triggers/tr-7")?.targets[0]._id).toBe("t1");
    expect(resolvePaletteTarget(state, "/plans/missing")).toBeNull();
    expect(resolvePaletteTarget(state, "/plans")).toBeNull();
  });
  test("links use canonical routes", () => {
    expect(paletteObjectPath("session", { _id: "s" })).toBe("/conversation/s");
    expect(paletteObjectPath("project", { _id: "p" })).toBe("/projects/p");
  });
  test("digit accelerators leave typing and IME input alone", () => {
    const e = { key: "2", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(paletteDigitIndex(e, 5)).toBe(-1);
    expect(paletteDigitIndex({ ...e, metaKey: true }, 5)).toBe(1);
    expect(paletteDigitIndex({ ...e, ctrlKey: true }, 5)).toBe(1);
    expect(paletteDigitIndex({ ...e, metaKey: true, isComposing: true }, 5)).toBe(-1);
    expect(paletteDigitIndex({ ...e, metaKey: true }, 1)).toBe(-1);
  });
});
