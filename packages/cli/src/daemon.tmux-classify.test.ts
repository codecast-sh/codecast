import { describe, expect, test } from "bun:test";
import { classifyBypassBlock, classifyTmuxLiveState, extractTmuxLiveRegion, isPhantomBypassPermissionBlock } from "./daemon.js";

describe("isPhantomBypassPermissionBlock", () => {
  test("suppresses auto-approved tool permission_blocked in bypass mode", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", "Bash: rm -rf")).toBe(true);
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", undefined)).toBe(true);
  });

  test("lets a genuine AskUserQuestion block through even in bypass mode", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", "AskUserQuestion")).toBe(false);
  });

  test("never suppresses outside bypass mode or for non-blocked statuses", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "default", "Bash")).toBe(false);
    expect(isPhantomBypassPermissionBlock("working", "bypassPermissions", undefined)).toBe(false);
  });
});

// Real pane captures from cc-resume-f61304a3 (the session that surfaced this bug)
// and synthesized variants are used as test fixtures so the classifier is grounded
// in actual Claude Code TUI output rather than what we *think* it looks like.

const IDLE_PANE = `  Today (5/11): 1,564

  ────────────────────────────────────────
  Column 1: — routing_status='routed' (orphans)
  Today (5/11): 1,503

❯ Sample 100 of these 1500, look at the counter party agent runs and lets
  identify root cause for this - are they all old, check the rate of this issue
   in the last month

⏺ Bash(./xrun sql "
      -- Sample 100 uncovered routed needs, joined to their markets via
      need_set…)
  ⎿  Interrupted · What should Claude do instead?

❯ [Codecast import] This Claude session was truncated to avoid overly-long
  context (which can break Claude Code /compact).
  Original: 2216 messages. Included: last 1038 messages + first user message.

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)               ● high · /effort
`;

const REWIND_PANE = `❯ [Codecast import] This Claude session was truncated to avoid overly-long
  context (which can break Claude Code /compact).
  Original: 2217 messages. Included: last 1038 messages + first user message.

────────────────────────────────────────────────────────────────────────────────
  Rewind

  Restore the code and/or conversation to the point before…

   ↑ 16 more above

    [Request interrupted by user]
    ⚠ No code restore

    [Codecast import] This Claude session was truncated to avoid overly-l…
    ⚠ No code restore

  ❯ (current)



  Enter to continue · Esc to cancel
`;

// What the LIVE interrupted dialog looks like: text appears in the input area
// (between the input-box separators), not as a transcript ⎿ tool-output line.
const INTERRUPTED_LIVE_PANE = `  ⎿  Some past tool output line that survives in transcript

────────────────────────────────────────────────────────────────────────────────
  Interrupted · What should Claude do instead?
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// CRITICAL fixture: the original bug. "Interrupted · What should Claude do
// instead?" appears in scrollback as a tool-result transcript line, but the
// live input box is empty. The old INTERRUPTED_PATTERN matched this and looped
// forever. The new classifier must return "idle".
const INTERRUPTED_IN_SCROLLBACK_ONLY = `❯ continue on this

⏺ Bash(./xrun sql "select * from foo")
  ⎿  Interrupted · What should Claude do instead?

⏺ Got it, here's a summary of where things stand.

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

const BUSY_SPINNER_PANE = `❯ run the tests

⏺ Bash(bun test)
  ⎿  ⠹ Running…  (esc to interrupt)
`;

// The storm fixture (cc-resume-5caa8942): the agent is BUSY generating but
// still renders its input box for type-ahead. The spinner sits above the box
// and "esc to interrupt" sits in the footer below it — both OUTSIDE the
// box-body region. Slicing to the box body alone returned just "❯" and the
// classifier called it idle, so the daemon pasted a user turn into a mid-turn
// agent; the queued text never submitted to JSONL, never acked, and redelivered
// forever (each retry re-pasted → "not respondinghttps://…" pile-up).
const BUSY_WITH_INPUT_BOX_PANE = `⏺ Reading the delivery path now…

✻ Dilly-dallying… (1m 20s · ↓ 5.9k tokens · almost done thinking with high effort)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)               · esc to interrupt
`;

describe("classifyBypassBlock", () => {
  const SID = "07191b53";

  test("holds an AskUserQuestion block across a context-free follow-up (the bug)", () => {
    // Exact sequence that left jx7dwas showing "working/stuck" for 13 min on the web.
    const blocked = new Set<string>();

    // 1. PreToolUse AskUserQuestion: the agent is now waiting. Not a phantom.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "AskUserQuestion").suppress).toBe(false);
    expect(blocked.has(SID)).toBe(true);

    // 2. Follow-up generic Notification (no tool name) while still waiting. Pre-fix this
    //    was suppressed -> status reverted to "working" -> web fell behind. Must hold.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined).suppress).toBe(false);
    expect(blocked.has(SID)).toBe(true);

    // 3. The answer lands and the agent moves on. Block closes.
    expect(classifyBypassBlock(blocked, SID, "working", "bypassPermissions", undefined).suppress).toBe(false);
    expect(blocked.has(SID)).toBe(false);

    // 4. A genuine phantom auto-approve afterwards is suppressed again, as before.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "Bash: rm -rf").suppress).toBe(true);
  });

  test("a phantom with no preceding AskUserQuestion is still suppressed", () => {
    const blocked = new Set<string>();
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "Bash").suppress).toBe(true);
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined).suppress).toBe(true);
    expect(blocked.has(SID)).toBe(false);
  });

  test("never suppresses outside bypass mode, even mid-block", () => {
    const blocked = new Set<string>();
    classifyBypassBlock(blocked, SID, "permission_blocked", "default", "AskUserQuestion");
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "default", undefined).suppress).toBe(false);
  });

  test("blocks are tracked per session", () => {
    const blocked = new Set<string>();
    classifyBypassBlock(blocked, "sessA", "permission_blocked", "bypassPermissions", "AskUserQuestion");
    // A different session's phantom is unaffected by sessA's open block.
    expect(classifyBypassBlock(blocked, "sessB", "permission_blocked", "bypassPermissions", undefined).suppress).toBe(true);
    // sessA's own follow-up is still held.
    expect(classifyBypassBlock(blocked, "sessA", "permission_blocked", "bypassPermissions", undefined).suppress).toBe(false);
  });
});

describe("extractTmuxLiveRegion", () => {
  test("returns content between the last two separators for an idle input box", () => {
    const region = extractTmuxLiveRegion(IDLE_PANE);
    expect(region).toContain("❯");
    expect(region).not.toContain("Interrupted");
    expect(region).not.toContain("Codecast import");
    expect(region).not.toContain("Sample 100");
  });

  test("returns content below the single separator when a modal replaces the input", () => {
    const region = extractTmuxLiveRegion(REWIND_PANE);
    expect(region).toContain("Rewind");
    expect(region).toContain("Enter to continue");
    // The Rewind dialog *legitimately* quotes prior user message previews
    // (including the "[Codecast import]" banner) in its option list — that's not
    // scrollback bleed, it's modal content. The classifier still returns "rewind"
    // because we check the Esc-to-cancel signature before anything else.
    expect(region).not.toContain("Original: 2217 messages");
  });

  test("strips scrollback that contains the 'Interrupted' transcript line", () => {
    const region = extractTmuxLiveRegion(INTERRUPTED_IN_SCROLLBACK_ONLY);
    expect(region).not.toContain("Interrupted");
    expect(region.trim()).toContain("❯");
  });

  test("falls back to a tight tail when no separators are visible (busy state)", () => {
    const region = extractTmuxLiveRegion(BUSY_SPINNER_PANE);
    expect(region).toContain("esc to interrupt");
  });

  test("keeps the footer below the input box so the busy marker survives", () => {
    // Regression: an agent generating with its input box visible must not look
    // idle. The "esc to interrupt" footer lives below the box, so the extracted
    // region has to reach past the bottom separator.
    const region = extractTmuxLiveRegion(BUSY_WITH_INPUT_BOX_PANE);
    expect(region).toContain("❯");
    expect(region).toContain("esc to interrupt");
    // Still no scrollback bleed — the spinner line above the box stays out.
    expect(region).not.toContain("Dilly-dallying");
    expect(region).not.toContain("Reading the delivery path");
  });
});

describe("classifyTmuxLiveState", () => {
  test("idle: empty prompt between separators", () => {
    const region = extractTmuxLiveRegion(IDLE_PANE);
    expect(classifyTmuxLiveState(region)).toBe("idle");
  });

  test("idle even when 'Interrupted' is in scrollback only (the original bug)", () => {
    const region = extractTmuxLiveRegion(INTERRUPTED_IN_SCROLLBACK_ONLY);
    expect(classifyTmuxLiveState(region)).toBe("idle");
  });

  test("rewind: Restore dialog with 'Enter to continue · Esc to cancel'", () => {
    const region = extractTmuxLiveRegion(REWIND_PANE);
    expect(classifyTmuxLiveState(region)).toBe("rewind");
  });

  test("interrupted: live 'What should Claude do instead?' inside input region", () => {
    const region = extractTmuxLiveRegion(INTERRUPTED_LIVE_PANE);
    expect(classifyTmuxLiveState(region)).toBe("interrupted");
  });

  test("busy: spinner glyph or 'esc to interrupt'", () => {
    const region = extractTmuxLiveRegion(BUSY_SPINNER_PANE);
    expect(classifyTmuxLiveState(region)).toBe("busy");
  });

  test("busy even when the input box is visible (the storm bug)", () => {
    // A generating agent renders ❯ for type-ahead; without the footer this used
    // to classify "idle" and the daemon pasted into the busy agent.
    const region = extractTmuxLiveRegion(BUSY_WITH_INPUT_BOX_PANE);
    expect(classifyTmuxLiveState(region)).toBe("busy");
  });

  test("warning: 'Press enter to continue' banner", () => {
    // Warning may appear with the prompt also visible — classifier checks region
    // and returns 'idle' if the separator-bracketed body is empty. To exercise the
    // warning path, run the classifier directly on the warning text region.
    expect(classifyTmuxLiveState("  Update available: 1.1.36 → 1.1.40\n  Press enter to continue")).toBe("warning");
  });

  test("idle beats 'Update available' persistent footer when input prompt is visible", () => {
    // Regression: Claude Code's persistent footer renders "Update available! Run:
    // brew upgrade claude-code" below the input box on every turn when an update
    // is pending. It is NOT a blocking modal — the input prompt (❯) stays usable.
    // Pre-fix, the classifier matched /Update available/ first and returned
    // "warning", which made ensureTmuxReady press Enter against the still-visible
    // banner, loop 3x, throw AGENT_STUCK_WARNING (and in practice AGENT_BUSY when
    // the agent was also working), and abandon delivery — so no Codecast-launched
    // tmux session could ever receive a message while any Claude update was
    // available. Real blocker warnings replace the input box, so prompt-visible
    // is a reliable "no modal" signal.
    const region = "❯  \n──────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n     Update available! Run: brew upgrade claude-code";
    expect(classifyTmuxLiveState(region)).toBe("idle");
  });

  test("exited: 'Resume this session with:' surfaced in the live region", () => {
    expect(classifyTmuxLiveState("Resume this session with: claude --resume abc123")).toBe("exited");
  });

  test("rewind beats interrupted when both keywords would match (Rewind dialog mentions interrupted requests in its option list)", () => {
    const region = `  Rewind
  Restore conversation
   ↑ 16 more above
    [Request interrupted by user]
    What should Claude do instead?
  ❯ (current)
  Enter to continue · Esc to cancel`;
    expect(classifyTmuxLiveState(region)).toBe("rewind");
  });

  test("unknown: no recognizable pattern → defer rather than guess", () => {
    expect(classifyTmuxLiveState("  some weird state we have never seen before")).toBe("unknown");
  });

  test("idle tolerates cursor placeholder glyphs after ❯", () => {
    expect(classifyTmuxLiveState("❯ ▋")).toBe("idle");
    expect(classifyTmuxLiveState("❯ \n  ▎")).toBe("idle");
    expect(classifyTmuxLiveState("›  ")).toBe("idle");
  });

  test("draft text in the input still classifies as idle (paste path clears it)", () => {
    // Real example pulled from cc-resume-c712d5e0 — user had typed a follow-up
    // but not pressed Enter. The classifier must let this through; refusing would
    // strand any session where the user typed something then walked away.
    expect(classifyTmuxLiveState("❯ retry the frontend deploy")).toBe("idle");
    expect(classifyTmuxLiveState("❯ commit this")).toBe("idle");
    expect(classifyTmuxLiveState("❯ yes do it")).toBe("idle");
  });

  test("modal patterns still beat ❯-with-draft-text — modal check runs first", () => {
    // If a modal happens to render with ❯ AND a modal marker, the modal wins.
    expect(classifyTmuxLiveState("Interrupted prompt\n❯ \nWhat should Claude do instead?")).toBe("interrupted");
    expect(classifyTmuxLiveState("❯ (current)\nEsc to cancel")).toBe("rewind");
  });

  test("no prompt glyph + no modal marker → unknown (defer rather than guess)", () => {
    expect(classifyTmuxLiveState("  some weird state we have never seen")).toBe("unknown");
    expect(classifyTmuxLiveState("Files touched:\n  foo.ts\n  bar.ts")).toBe("unknown");
  });
});

describe("end-to-end: the bug case", () => {
  test("the exact pane that bricked cc-resume-f61304a3 now classifies as idle", () => {
    // From `tmux capture-pane -p -J -t cc-resume-f61304a3:0.0 -S -15` taken
    // while the daemon was in the AGENT_INTERRUPTED loop.
    const buggedPane = `❯ Sample 100 of these 1500, look at the counter party agent runs and lets
  identify root cause for this - are they all old, check the rate of this issue
   in the last month

⏺ Bash(./xrun sql "
      -- Sample 100 uncovered routed needs, joined to their markets via
      need_set…)
  ⎿  Interrupted · What should Claude do instead?

❯ [Codecast import] This Claude session was truncated to avoid overly-long
  context (which can break Claude Code /compact).
  Original: 2216 messages. Included: last 1038 messages + first user message.

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)               ● high · /effort
`;
    const region = extractTmuxLiveRegion(buggedPane);
    const state = classifyTmuxLiveState(region);
    expect(state).toBe("idle");
  });
});
