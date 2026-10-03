import { describe, expect, test } from "bun:test";
import { paletteActions, paletteActionForKey, paletteDigitIndex, paletteItemScore, paletteObjectPath, type PaletteTargetType } from "../paletteActions";
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
  test("a cloud agent session keeps its agent and its provider's model: no switch, no model picker, fork and hand off stay", () => {
    for (const cloud of [{ agent_type: "codex", session_id: "task_e_6abc48f2" }, { agent_type: "cursor", session_id: "bc-123" }]) {
      const actions = keys("session", { ...session, ...cloud });
      expect(actions).not.toContain("agent_switch");
      expect(actions).not.toContain("model");
      expect(actions).toEqual(expect.arrayContaining(["agent_fork", "agent_handoff"]));
    }
    // A local Codex session still has both.
    expect(keys("session", { ...session, agent_type: "codex", session_id: "019a-local" })).toEqual(expect.arrayContaining(["agent_switch", "model"]));
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
  // The right-click menu reads the same isSessionSetAside/isSessionKilled rule,
  // so a killed row offers neither Kill again nor the filing verbs, whose
  // stamps would leave it under Killed.
  test("killed sessions offer restore, never kill or the filing verbs", () => {
    const actions = keys("session", { ...session, inbox_killed_at: 123 });
    expect(actions).toContain("session_restore");
    for (const verb of ["session_kill", "session_stash", "session_stash_hide", "session_defer", "session_dormant", "session_done", "session_needs_input", "snooze"]) {
      expect(actions).not.toContain(verb);
    }
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
  test("registered commands do not get a second menu shortcut", () => {
    for (const type of ["session", "task", "doc", "plan", "project", "trigger"] as const) {
      for (const action of paletteActions(type, [session], "me", true)) {
        if (action.shortcutAction) expect(action.hotkey).toBeUndefined();
      }
    }
    const copyLink = paletteActions("session", [session], "me").find(action => action.key === "copylink");
    expect(copyLink?.shortcutAction).toBe("conv.copyLink");
  });
  test("sharing is omitted when chat is disabled", () => {
    expect(paletteActions("task", [{ _id: "t" }], "me", false).map(a => a.key)).not.toContain("forward");
  });
});

describe("command menu keyboard reuse", () => {
  const actions = paletteActions("session", [session], "me");
  const event = (overrides: Record<string, unknown> = {}) => ({
    key: "Backspace", code: "Backspace", ctrlKey: true, metaKey: false,
    altKey: false, shiftKey: false, target: { tagName: "INPUT", value: "" },
    ...overrides,
  }) as unknown as KeyboardEvent;

  test("lifecycle commands use the registered backspace family", () => {
    expect(paletteActionForKey(event(), actions)?.key).toBe("session_stash");
    expect(paletteActionForKey(event({ shiftKey: true }), actions)?.key).toBe("session_kill");
    expect(paletteActionForKey(event({ altKey: true }), actions)?.key).toBe("session_stash_hide");
    expect(paletteActionForKey(event({ ctrlKey: false, shiftKey: true }), actions)?.key).toBe("session_defer");
    expect(paletteActionForKey(event({ ctrlKey: false, altKey: true, shiftKey: true }), actions)?.key).toBe("session_dormant");
  });

  test("backspace chords edit a nonempty search instead of acting on a session", () => {
    for (const modifiers of [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: false, shiftKey: true }, { ctrlKey: false, altKey: true, shiftKey: true }]) {
      expect(paletteActionForKey(event({ ...modifiers, target: { tagName: "INPUT", value: "find a session" } }), actions)).toBeUndefined();
    }
  });

  test("duplicate Alt-letter commands no longer run", () => {
    for (const letter of ["s", "b", "d", "k", "r", "p", "v", "l", "c"]) {
      expect(paletteActionForKey(event({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: false, altKey: true }), actions)).toBeUndefined();
    }
  });

  test("snooze jumps straight to durations using its registered shortcut", () => {
    expect(paletteActionForKey(event({ key: "Ω", code: "KeyZ", ctrlKey: false, altKey: true }), actions)?.key).toBe("snooze");
  });

  test("new menu commands keep their own accelerators", () => {
    expect(paletteActionForKey(event({ key: "å", code: "KeyA", ctrlKey: false, altKey: true }), actions)?.key).toBe("agent_switch");
  });

  test("menu shortcuts work when the list holds focus", () => {
    const target = { tagName: "DIV", isContentEditable: false };
    expect(paletteActionForKey(event({ key: "å", code: "KeyA", ctrlKey: false, altKey: true, target }), actions)?.key).toBe("agent_switch");
    expect(paletteActionForKey(event({ key: "ƒ", code: "KeyF", ctrlKey: false, altKey: true, target }), actions)?.key).toBe("agent_fork");
    expect(paletteActionForKey(event({ target }), actions)?.key).toBe("session_stash");
    expect(paletteActionForKey(event({ key: "s", code: "KeyS", ctrlKey: false, target }), paletteActions("task", [{ _id: "task" }], "me"))?.key).toBe("status");
  });

  test("rename and label keep their registered chords while searching", () => {
    const target = { tagName: "INPUT", value: "rename" };
    expect(paletteActionForKey(event({ key: "E", code: "KeyE", shiftKey: true, target }), actions)?.key).toBe("rename");
    expect(paletteActionForKey(event({ key: "l", code: "KeyL", target }), actions)?.key).toBe("bucket");
  });

  test("plain letters, composition and already handled keys remain untouched", () => {
    expect(paletteActionForKey(event({ key: "s", code: "KeyS", ctrlKey: false }), paletteActions("task", [{ _id: "task" }], "me"))).toBeUndefined();
    expect(paletteActionForKey(event({ isComposing: true }), actions)).toBeUndefined();
    expect(paletteActionForKey(event({ defaultPrevented: true }), actions)).toBeUndefined();
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

describe("palette item ranking", () => {
  test("a row that creates from the typed query loses to a real match", () => {
    const q = "emdash";
    const compose = paletteItemScore(`__compose__ vault new named note|||${q}`, q);
    const search = paletteItemScore(`__search__ Cold email reply-rate|||c1`, q);
    const entity = paletteItemScore(`__entity__ some note|||n1`, q);
    expect(compose).toBeGreaterThan(0);
    expect(compose).toBeLessThan(search);
    expect(compose).toBeLessThan(entity);
  });

  test("filter values lead every match; filter names trail matches but beat compose", () => {
    const value = paletteItemScore("__filter__v file:src/a.ts", "file:");
    const name = paletteItemScore("__filter__o author:", "au");
    const search = paletteItemScore("__search__ Auth rewrite|||c1", "au");
    const compose = paletteItemScore("__compose__", "au");
    expect(value).toBeGreaterThan(search);
    expect(name).toBeLessThan(search);
    expect(name).toBeGreaterThan(compose);
  });

  test("a command named by the query outranks session and entity hits", () => {
    const q = "undo history";
    const command = paletteItemScore("Undo history undo redo history timeline changes take back revert recent actions", q);
    expect(command).toBeGreaterThan(paletteItemScore("__search__ Undo history timeline|||c1", q));
    expect(command).toBeGreaterThan(paletteItemScore("__entity__ Undo history timeline|||t1", q));
    expect(command).toBeGreaterThan(paletteItemScore("__recent__ Undo history work|||r1", q));
    expect(command).toBeLessThan(paletteItemScore("__filter__v file:src/a.ts", q));
    // A keyword hit alone is an ordinary match.
    expect(paletteItemScore("Undo history undo redo history timeline", "timeline")).toBe(1);
  });

  test("keyword rows still hide when they do not match", () => {
    expect(paletteItemScore("Files vault new note create markdown", "emdash")).toBe(0);
    expect(paletteItemScore("Files vault new note create markdown", "note")).toBe(1);
  });
  test("several sessions get only the verbs that act on every row, labeled with the count", () => {
    const rows = [session, { ...session, _id: "session-2", parent_conversation_id: "p", git_branch: "main" }, { ...session, _id: "session-3" }];
    const actions = paletteActions("session", rows, "me", true);
    const got = actions.map(a => a.key);
    expect(got).toEqual(expect.arrayContaining(["bucket", "device", "session_stash", "session_kill", "session_done", "session_pin", "character"]));
    for (const one of ["agent_switch", "agent_fork", "agent_handoff", "model", "rename", "session_parent", "session_branch", "session_files", "open", "copy"]) expect(got).not.toContain(one);
    expect(actions.find(a => a.key === "session_kill")?.label).toBe("Kill 3 sessions");
    expect(actions.find(a => a.key === "bucket")?.label).toBe("Label 3 sessions…");
  });
  test("a teammate: follow where they are, reach them, then their profile", () => {
    const person = { _id: "u-sam", name: "Samvit", username: "samvit", member: {}, online: true, following: false, session: { _id: "c1", title: "Deals lead" } };
    const actions = paletteActions("person", [person], "me", true);
    expect(actions.map(a => a.key)).toEqual(["person_follow", "person_message", "person_huddle", "open", "newtab", "copylink"]);
    expect(actions[0].label).toBe("Follow · Deals lead");
    expect(paletteObjectPath("person", person)).toBe("/team/samvit");
    // Offline: nothing to follow; chat off: no message.
    expect(paletteActions("person", [{ ...person, online: false, session: null }], "me", false).map(a => a.key)).toEqual(["person_huddle", "open", "newtab", "copylink"]);
    expect(paletteActions("person", [{ ...person, following: true }], "me", true)[0].label).toBe("Stop following");
  });
});
