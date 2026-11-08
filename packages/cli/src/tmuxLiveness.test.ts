import { describe, expect, test } from "bun:test";
import { classifyTmuxLiveness } from "./tmuxLiveness.js";

const composer = "❯ \n  ⏵⏵ bypass permissions on";

describe("classifyTmuxLiveness", () => {
  test("an agent in the pane tree is alive, even when capture-pane got no answer", () => {
    expect(classifyTmuxLiveness({ panePid: 10, agent: 11, pane: composer })).toBe(true);
    expect(classifyTmuxLiveness({ panePid: 10, agent: 11, pane: null })).toBe(true);
  });

  test("dead only when tmux, ps and the pane all answered", () => {
    expect(classifyTmuxLiveness({ panePid: "gone", agent: null, pane: null })).toBe(false);
    expect(classifyTmuxLiveness({ panePid: 10, agent: "absent", pane: composer })).toBe(false);
    expect(classifyTmuxLiveness({ panePid: 10, agent: 11, pane: "" })).toBe(false);
    expect(classifyTmuxLiveness({ panePid: 10, agent: 11, pane: "Resume this session with:\nclaude --resume x" })).toBe(false);
  });

  // jx751p3, 2026-11-08, load 700: a list-panes or ps timeout read as dead
  // dropped a live session's tmux target and sent delivery to AppleScript.
  test("a probe with no answer is unknown, not dead", () => {
    expect(classifyTmuxLiveness({ panePid: null, agent: null, pane: null })).toBeNull();
    expect(classifyTmuxLiveness({ panePid: 10, agent: null, pane: composer })).toBeNull();
    expect(classifyTmuxLiveness({ panePid: 10, agent: null, pane: null })).toBeNull();
  });
});
