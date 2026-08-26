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

// ── Feed cards: where a session ACTUALLY works ────────────────────────────────
// A card must reveal worktree residence, machine, recent edits, and latest
// activity — the four signals whose absence made agents mis-attribute
// working-tree edits and message the wrong session (jx7fnt5 → jx7b88a).
import { formatFeedResults, worktreeFromPath, feedFilePath } from "./formatter";

function feedConv(overrides: Record<string, any> = {}) {
  return {
    id: "conversations_feed1",
    title: "Budget mandate",
    project_path: "/Users/x/src/app",
    updated_at: new Date().toISOString(),
    message_count: 9000,
    work_state: "working",
    preview: [
      { line: 1, role: "user", content: "the founding goal" },
      { line: 2, role: "assistant", content: "the plan" },
    ],
    ...overrides,
  };
}

describe("formatFeedResults location + activity lines", () => {
  test("renders worktree, machine, edits, and the latest-messages tail", () => {
    const out = strip(
      formatFeedResults({
        conversations: [
          feedConv({
            worktree: "cockpit-bill",
            machine: "mac-studio",
            // Machine shows because this is another person's session; a
            // single-machine feed of your own sessions hides the label.
            user: { name: "sam", email: null },
            recent_files: [
              "/Users/x/src/app/.codecast/worktrees/cockpit-bill/src/budget/types.ts",
              "/Users/x/src/app/src/budget/page.tsx",
            ],
            tail: [
              { line: 8999, role: "user", content: "latest ask" },
              { line: 9000, role: "assistant", content: "latest answer" },
            ],
          }),
        ],
        scope: "global",
      } as any),
    );
    expect(out).toContain("worktree cockpit-bill");
    expect(out).toContain("on mac-studio");
    expect(out).toContain("edits:");
    expect(out).toContain("budget/types.ts");
    expect(out).toContain("the founding goal");
    expect(out).toContain("⋮");
    expect(out).toContain("latest answer");
    expect(out).toContain("8999");
    expect(out).toContain("cast diff");
  });

  test("derives worktree residence from recent edit paths when unregistered", () => {
    const out = strip(
      formatFeedResults({
        conversations: [
          feedConv({
            recent_files: ["/Users/x/src/app/.codecast/worktrees/fix-auth/src/a.ts"],
          }),
        ],
        scope: "global",
      } as any),
    );
    expect(out).toContain("worktree fix-auth");
  });

  test("summary line renders only for non-working sessions", () => {
    const base = { idle_summary: "Repaired 26 searches; watching conversion." };
    const idle = strip(
      formatFeedResults({ conversations: [feedConv({ ...base, work_state: "needs_input" })], scope: "g" } as any),
    );
    const working = strip(
      formatFeedResults({ conversations: [feedConv({ ...base, work_state: "working" })], scope: "g" } as any),
    );
    expect(idle).toContain("summary: Repaired 26 searches");
    expect(working).not.toContain("summary:");
  });

  test("a card with none of the new fields renders exactly as before", () => {
    const out = strip(formatFeedResults({ conversations: [feedConv()], scope: "g" } as any));
    expect(out).toContain("Budget mandate");
    expect(out).toContain("the founding goal");
    expect(out).not.toContain("worktree");
    expect(out).not.toContain("edits:");
  });
});

describe("worktreeFromPath", () => {
  test("extracts the worktree segment", () => {
    expect(worktreeFromPath("/a/.codecast/worktrees/fix-auth/src/x.ts")).toBe("fix-auth");
    expect(worktreeFromPath("/a/src/x.ts")).toBeUndefined();
    expect(worktreeFromPath(undefined)).toBeUndefined();
  });
});

describe("feed machine label discrimination", () => {
  test("hidden when every card is your own on one machine; shown across all once two machines appear", () => {
    const solo = strip(
      formatFeedResults({ conversations: [feedConv({ machine: "mbp" })], scope: "g" } as any),
    );
    expect(solo).not.toContain("on mbp");
    const mixed = strip(
      formatFeedResults({
        conversations: [feedConv({ machine: "mbp" }), feedConv({ machine: "mac-studio" })],
        scope: "g",
      } as any),
    );
    expect(mixed).toContain("on mbp");
    expect(mixed).toContain("on mac-studio");
  });
});

describe("feedFilePath", () => {
  test("relativizes against the project and the worktree copy", () => {
    expect(feedFilePath("/Users/x/src/app/packages/cli/src/a.ts", "/Users/x/src/app")).toBe(
      "packages/cli/src/a.ts",
    );
    expect(
      feedFilePath("/Users/x/src/app/.codecast/worktrees/fix-auth/packages/cli/src/a.ts", "/Users/x/src/app"),
    ).toBe("packages/cli/src/a.ts");
  });

  test("keeps a foreign absolute path visibly absolute", () => {
    expect(feedFilePath("/Users/ec2-user/work/repo/src/a.ts", "/Users/x/src/app")).toContain("/Users/ec2-user");
  });
});

import { formatReadResult } from "./formatter";

// A StructuredOutput call's input IS the agent's deliverable, and a non-full
// read collapses it to one summary line — which readers have mistaken for an
// empty result. The collapsed line must carry the exact --full command; the
// full view must not (it already shows everything).
describe("formatReadResult surfaces collapsed StructuredOutput payloads", () => {
  const readResult = {
    conversation: {
      id: "jx7abcd1234",
      title: "Workflow run",
      project_path: "/Users/x/code/proj",
      message_count: 3,
      updated_at: new Date().toISOString(),
    },
    messages: [
      {
        line: 2,
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        tool_calls: [
          { name: "StructuredOutput", input: JSON.stringify({ findings: [{ a: 1 }] }) },
        ],
      },
    ],
  };

  test("the collapsed view points at the --full command", () => {
    const out = strip(formatReadResult(readResult));
    expect(out).toContain("StructuredOutput findings[1]");
    expect(out).toContain("full payload: cast read jx7abcd 2 --full");
  });

  test("the full view prints the payload and no hint", () => {
    const out = strip(formatReadResult(readResult, { full: true }));
    expect(out).toContain('"findings"');
    expect(out).not.toContain("full payload:");
  });

  test("ordinary tool calls get no hint", () => {
    const out = strip(formatReadResult({
      ...readResult,
      messages: [{
        line: 2,
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        tool_calls: [{ name: "Bash", input: JSON.stringify({ command: "ls" }) }],
      }],
    }));
    expect(out).not.toContain("--full");
  });
});
