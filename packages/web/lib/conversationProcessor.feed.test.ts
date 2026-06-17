import { test, expect, describe } from "bun:test";
import { classifyFeedMessage, isNoiseUserMessage } from "./conversationProcessor";

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
});
