import { describe, expect, test } from "bun:test";
import { formatMonitor } from "./formatter";

// The `cast sessions` SNAPSHOT renderer. The watch stream already handled kills
// correctly (a killed row emits `gone`, not a transition), but the snapshot did
// not: classifyWorkState collapses a retired row to "idle" — kill outranks every
// other signal — so a killed session printed as an ordinary idle one, with its
// tmux and process possibly still alive. These pin the killed marker's rendering.

// Colors are on whenever stdout is a TTY, which differs between a local run and
// CI, so assert on the text with escapes stripped.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function session(overrides: Record<string, any> = {}) {
  return {
    id: "conversations_abc123",
    session_id: "sess-1",
    title: "Ship the thing",
    project_path: "/Users/x/code/proj",
    updated_at: new Date().toISOString(),
    message_count: 12,
    agent_type: "claude",
    work_state: "idle",
    is_pinned: false,
    is_live: false,
    awaiting_input: false,
    idle_summary: null,
    last_user_message: null,
    active_plan: null,
    active_task: null,
    ...overrides,
  };
}

function result(sessions: any[], counts: Record<string, number> = {}) {
  return {
    sessions,
    counts: {
      working: 0, needs_input: 0, idle: sessions.length, pinned: 0, live: 0,
      total: sessions.length, ...counts,
    } as any,
    scope: "you",
  };
}

describe("formatMonitor renders the killed marker", () => {
  test("a killed row is badged `killed`", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })]), { all: true }));
    expect(out).toContain("killed");
    expect(out).toContain("Ship the thing");
  });

  test("an ordinary idle row is NOT badged killed", () => {
    const out = strip(formatMonitor(result([session()]), { all: true }));
    expect(out).not.toContain("killed");
  });

  // The regression proper: kill collapses work_state to "idle", so the badge is
  // the ONLY thing distinguishing a retired session from a live-but-quiet one.
  // Without the marker these two rows render identically.
  test("killed and ordinary idle rows do not render identically", () => {
    const killedOut = strip(formatMonitor(result([session({ is_killed: true })]), { all: true }));
    const idleOut = strip(formatMonitor(result([session()]), { all: true }));
    expect(killedOut).not.toBe(idleOut);
  });

  // A killed row stays pinned-visible; both tags must show, not one replacing
  // the other — pinned is why it is still listed, killed is what it is.
  test("a killed AND pinned row shows both tags", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true, is_pinned: true })]), { all: true }));
    expect(out).toContain("killed");
    expect(out).toContain("pinned");
  });

  test("the killed tag rides the state badge line, next to the work state", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })]), { all: true }));
    const badgeLine = out.split("\n").find((l) => l.includes("Ship the thing"))!;
    expect(badgeLine).toMatch(/idle\s+killed/);
  });
});

// Where the badge actually shows. A killed row classifies as idle
// (classifyWorkState gives kill precedence), and the DEFAULT view renders only
// NEEDS INPUT + WORKING, collapsing idle to a "+ N idle" line — so plain
// `cast sessions` shows no card for a killed session at all, pinned or not.
// That is intended (a killed row IS idle, and idle rows collapse), but the
// feature is narrower than "the snapshot badges killed rows" suggests, so it
// gets pinned here rather than left for the next reader to discover.
describe("formatMonitor default view collapses killed rows", () => {
  test("plain `cast sessions` renders no card for a killed row", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })])));
    expect(out).not.toContain("Ship the thing");
    expect(out).toContain("+ 1 idle");
  });

  // Pinning changes sort order, not grouping — it does not add a group.
  test("pinning a killed row does not surface it in the default view", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true, is_pinned: true })])));
    expect(out).not.toContain("Ship the thing");
    expect(out).not.toContain("killed");
  });

  test("-a reveals the row and its killed badge", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })]), { all: true }));
    expect(out).toContain("Ship the thing");
    expect(out).toContain("killed");
  });

  test("--state idle also reveals it", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })]), { state: "idle" }));
    expect(out).toContain("killed");
  });

  // The summary line is the ONLY killed signal in the default view.
  test("the summary still reports the killed count in the default view", () => {
    const out = strip(formatMonitor(result([session({ is_killed: true })], { killed: 1 })));
    expect(out.split("\n")[1]).toContain("killed 1");
  });
});

// The summary line reported stashed and dismissed as ONE `dismissed` figure,
// which hid how many agents were still running: stashed keeps the agent ALIVE,
// dismissed does not. Killed is a third state again, distinct from both.
describe("formatMonitor reports the three retirement states separately", () => {
  const summaryOf = (counts: Record<string, number>) =>
    strip(formatMonitor(result([], counts))).split("\n")[1];

  test("stashed is reported under its own name, not folded into dismissed", () => {
    const line = summaryOf({ stashed: 4, dismissed: 7 });
    expect(line).toContain("stashed 4");
    expect(line).toContain("dismissed 7");
  });

  test("killed is reported separately from dismissed", () => {
    const line = summaryOf({ dismissed: 7, killed: 1 });
    expect(line).toContain("killed 1");
    expect(line).toContain("dismissed 7");
  });

  test("all three appear together when all three are nonzero", () => {
    const line = summaryOf({ stashed: 4, dismissed: 7, killed: 1 });
    expect(line).toMatch(/stashed 4.*dismissed 7.*killed 1/);
  });

  // Zero-valued states stay off the line — the summary only names what exists.
  test("a state with no rows is omitted", () => {
    const line = summaryOf({ dismissed: 7 });
    expect(line).toContain("dismissed 7");
    expect(line).not.toContain("stashed");
    expect(line).not.toContain("killed");
  });
});
