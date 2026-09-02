import { test, expect, describe } from "bun:test";
import { classifyFeedMessage, isNoiseUserMessage, isHiddenSystemNotice, isWarningSystemNotice, isBackgroundAgentStoppedNotice, backgroundAgentStoppedName, parseBashInput, parseBashOutput, cleanTitle } from "./conversationProcessor";

// Regression: the message feed was dumping raw <task-notification> XML and other
// structured/machine messages as cards. classifyFeedMessage is the single shared
// gate that hides them everywhere.
describe("classifyFeedMessage — structured/noise messages are hidden", () => {
  const noiseSamples: Record<string, string> = {
    "task notification (the feed bug)":
      "<task-notification> <task-id>b4zp81qce</task-id> <tool-use-id>toolu_017MRto2Ni6bcrNYNrTZSCNZ</tool-use-id> <output-file>/private/tmp/claude-501/-Users-ashot-src-codecast/232bb56f.output</output-file> <status>completed</status> </task-notification>",
    "scheduled task wrapper":
      '<scheduled-task title="Check CI" id="abc">run the suite</scheduled-task>',
    "skill expansion dump":
      "Base directory for this skill: /Users/ashot/.claude/skills/commit\n\nDo the thing.",
    "compaction prompt":
      "Your task is to create a detailed summary of the conversation so far. <summary>",
    "session continuation":
      "This session is being continued from a previous conversation that ran out of context.",
    "interrupt": "[Request interrupted by user]",
    "background agent stopped": 'Background agent "Build P2.6 shadow-soak sweep" was stopped by the user.',
    "codex turn aborted": "<turn_aborted>user aborted</turn_aborted>",
    "tool-output pointer": "Read the output file to retrieve the result: /tmp/x.output",
    "import notice": "[Codecast import] earlier messages were truncated for context.",
    "system-reminder only": "<system-reminder>be concise</system-reminder>",
    "empty": "   ",
  };

  for (const [name, content] of Object.entries(noiseSamples)) {
    test(`hides: ${name}`, () => {
      expect(isNoiseUserMessage(content)).toBe(true);
      expect(classifyFeedMessage(content)).toEqual({ kind: "hidden" });
    });
  }
});

describe("classifyFeedMessage — real messages show cleaned", () => {
  test("plain prompt passes through", () => {
    const d = classifyFeedMessage("Can you investigate the dispatch job?");
    expect(d).toEqual({ kind: "text", text: "Can you investigate the dispatch job?" });
  });

  test("strips a trailing system-reminder but keeps the prose", () => {
    const d = classifyFeedMessage(
      "Fix the budget context error.\n<system-reminder>be concise</system-reminder>",
    );
    expect(d.kind).toBe("text");
    expect(d.kind === "text" && d.text).toBe("Fix the budget context error.");
  });

  test("slash command collapses to /cmd", () => {
    const d = classifyFeedMessage("<command-name>commit</command-name><command-args>all</command-args>");
    expect(d).toEqual({ kind: "text", text: "/commit" });
  });

  test("a real message that merely mentions task-notification is not hidden", () => {
    const d = classifyFeedMessage("Why does the <task-notification> handling drop messages?");
    expect(d.kind).toBe("text");
  });

  test("a real message that merely mentions a background agent is not hidden", () => {
    const d = classifyFeedMessage("Why did the background agent stop unexpectedly?");
    expect(d.kind).toBe("text");
    expect(isBackgroundAgentStoppedNotice("Why did the background agent stop unexpectedly?")).toBe(false);
  });
});

// `!` bash mode (Claude Code composer): input renders as "! cmd", the output
// echo is machine noise for previews. The thread pairs them into one terminal
// block; these helpers are the shared classification everything hangs off.
describe("bash-mode messages", () => {
  test("parseBashInput extracts the typed command", () => {
    expect(parseBashInput("<bash-input>pwd</bash-input>")).toBe("pwd");
    expect(parseBashInput("<bash-input>git log --oneline | head -3</bash-input>")).toBe("git log --oneline | head -3");
    expect(parseBashInput("run <bash-input>pwd</bash-input> for me")).toBeNull();
    expect(parseBashInput("plain message")).toBeNull();
  });

  test("parseBashOutput extracts stdout and stderr", () => {
    expect(parseBashOutput("<bash-stdout>/Users/m1/work/codecast</bash-stdout><bash-stderr></bash-stderr>"))
      .toEqual({ stdout: "/Users/m1/work/codecast", stderr: "" });
    expect(parseBashOutput("<bash-stdout></bash-stdout><bash-stderr>not found</bash-stderr>"))
      .toEqual({ stdout: "", stderr: "not found" });
    expect(parseBashOutput("plain message")).toBeNull();
  });

  test("feed shows the input as '! cmd'", () => {
    expect(classifyFeedMessage("<bash-input>pwd</bash-input>")).toEqual({ kind: "text", text: "! pwd" });
  });

  test("feed hides the output echo", () => {
    const output = "<bash-stdout>/Users/m1/work/codecast</bash-stdout><bash-stderr></bash-stderr>";
    expect(isNoiseUserMessage(output)).toBe(true);
    expect(classifyFeedMessage(output)).toEqual({ kind: "hidden" });
  });

  test("cleanTitle renders the input as typed", () => {
    expect(cleanTitle("<bash-input>pwd</bash-input>")).toBe("! pwd");
  });
});

describe("backgroundAgentStoppedName", () => {
  test("extracts the quoted agent name from the notice", () => {
    expect(backgroundAgentStoppedName('Background agent "Build P2.6 shadow-soak sweep" was stopped by the user.'))
      .toBe("Build P2.6 shadow-soak sweep");
  });

  test("tolerates a missing trailing period and surrounding whitespace", () => {
    expect(isBackgroundAgentStoppedNotice('  Background agent "x" was stopped by the user  ')).toBe(true);
  });

  test("returns null for non-notice content", () => {
    expect(backgroundAgentStoppedName("just a normal message")).toBeNull();
  });

  test("an inter-agent teammate broadcast is hidden (tags + framing both stripped)", () => {
    const broadcast =
      "Another Claude session sent a message:\n" +
      '<teammate-message teammate_id="tracker-stale" color="green" summary="updates complete">\nAll updates landed.\n</teammate-message>\n' +
      "This came from another Claude session — not typed by your user … that's permission laundering.";
    expect(classifyFeedMessage(broadcast)).toEqual({ kind: "hidden" });
  });
});

// Claude Code writes terminal status lines into the transcript as
// system/"informational" entries. Only the Remote Control connection notices
// are hidden; the rest (usage-limit pauses, typo hints) still render.
describe("isHiddenSystemNotice — Remote Control notices are hidden", () => {
  test("Remote Control disconnected / not started here", () => {
    expect(isHiddenSystemNotice("Remote Control disconnected — signed-in claude.ai account or organization changed on this machine — run /remote-control to start a session", "informational")).toBe(true);
    expect(isHiddenSystemNotice("Remote Control disconnected — OAuth token unavailable — run /login", "informational")).toBe(true);
    expect(isHiddenSystemNotice("Remote Control not started here · another Claude Code on this machine (started 5m ago) owns it", "informational")).toBe(true);
  });

  test("other informational lines stay visible", () => {
    expect(isHiddenSystemNotice("Usage limit reached · continuing automatically at 5:50pm · esc or type to cancel", "informational")).toBe(false);
    expect(isHiddenSystemNotice("Automatic continue cancelled · /rate-limit-options to re-arm", "informational")).toBe(false);
    expect(isHiddenSystemNotice("Unknown command: /loginq. Did you mean /login?", "informational")).toBe(false);
  });

  test("the text alone is not enough — a user typing it is not a notice", () => {
    expect(isHiddenSystemNotice("Remote Control disconnected", undefined)).toBe(false);
    expect(isHiddenSystemNotice("Remote Control disconnected", "local_command")).toBe(false);
  });
});

// Usage-limit status lines render in the warning tone; the rest of the
// informational lines keep the neutral system gray.
describe("isWarningSystemNotice — usage-limit notices are warnings", () => {
  test("limit pauses, cancelled auto-continue, hit-your-limit forms", () => {
    expect(isWarningSystemNotice("Usage limit reached · continuing automatically at 5:50pm · esc or type to cancel", "informational")).toBe(true);
    expect(isWarningSystemNotice("Claude usage limit reached. Your limit will reset at 3am (America/New_York)", "informational")).toBe(true);
    expect(isWarningSystemNotice("Automatic continue cancelled · /rate-limit-options to re-arm", "informational")).toBe(true);
    expect(isWarningSystemNotice("You've hit your session limit · resets 11:30pm (America/New_York)", "informational")).toBe(true);
  });

  test("other informational lines stay neutral", () => {
    expect(isWarningSystemNotice("Unknown command: /loginq. Did you mean /login?", "informational")).toBe(false);
    expect(isWarningSystemNotice("Remote Control disconnected — OAuth token unavailable — run /login", "informational")).toBe(false);
  });

  test("the text alone is not enough — a user typing it is not a notice", () => {
    expect(isWarningSystemNotice("Usage limit reached", undefined)).toBe(false);
    expect(isWarningSystemNotice("Usage limit reached", "local_command")).toBe(false);
  });
});
