import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { paneTeardownBlock } from "./daemon.js";

// A lead whose turn ended reads idle while its teammate panel lists background
// agents. They run inside the lead's process and write nothing to its
// transcript, so a lead quiet for 5h with an agent working since the last
// daemon restart passed every other gate. Reaping it kills the agent mid-work.
describe("paneTeardownBlock", () => {
  const claudePane = (name: string) => fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "claude-panes", name), "utf8");

  test("an idle lead still listing background agents is not reaped", () => {
    expect(paneTeardownBlock("claude", claudePane("lead-idle-running-agent-chips.txt"))).toBe("background-agents-listed");
  });

  test("a plain idle pane is still reapable", () => {
    const rule = "─".repeat(80);
    expect(paneTeardownBlock("claude", `⏺ Done.\n\n${rule}\n❯\n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`)).toBeNull();
  });

  test("a pane that is not idle names its state", () => {
    expect(paneTeardownBlock("claude", claudePane("lead-busy-agent-chips.txt"))).toBe("pane=busy");
  });
});
