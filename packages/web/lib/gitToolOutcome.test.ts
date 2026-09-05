import { describe, expect, test } from "bun:test";
import { commandLeavesCheckout, gitToolOutcome, madeInTranscript, transcriptGitOutcomes } from "./gitToolOutcome";

describe("gitToolOutcome", () => {
  test("a git commit and the summary line it printed", () => {
    expect(gitToolOutcome("git commit -m 'fix the thing'", "[main 1a2b3c4] fix the thing\n 2 files changed, 4 insertions(+)")).toEqual({ kind: "commit", hash: "1a2b3c4", subject: "fix the thing", branch: "main" });
    expect(gitToolOutcome("git add -A && git commit -q -m x", "[feature/x (root-commit) abcdef0] x")).toEqual({ kind: "commit", hash: "abcdef0", subject: "x", branch: "feature/x" });
  });
  test("a gh pr create and the URL it printed", () => {
    const out = "Creating pull request for feat/x into main in codecast-sh/codecast\n\nhttps://github.com/codecast-sh/codecast/pull/482\n";
    expect(gitToolOutcome("gh pr create --fill", out)).toEqual({ kind: "pr", ref: "codecast-sh/codecast#482", url: "https://github.com/codecast-sh/codecast/pull/482" });
  });
  test("other commands, failures and unrelated output are nothing", () => {
    expect(gitToolOutcome("git status", "[main 1a2b3c4] not a commit")).toBeNull();
    expect(gitToolOutcome("git commit -m x", "nothing to commit, working tree clean")).toBeNull();
    expect(gitToolOutcome("git commit -m x", "[main 1a2b3c4] x", true)).toBeNull();
    expect(gitToolOutcome("gh pr view 12", "https://github.com/o/r/pull/12")).toBeNull();
    expect(gitToolOutcome("echo commit", "[main 1a2b3c4] x")).toBeNull();
  });
  test("a command that changes directory may have committed elsewhere", () => {
    expect(commandLeavesCheckout("git commit -m x")).toBe(false);
    expect(commandLeavesCheckout("git add -A && git commit -m x")).toBe(false);
    expect(commandLeavesCheckout("cd /tmp/x && git commit -m x")).toBe(true);
    expect(commandLeavesCheckout("git -C ../other commit -m x")).toBe(true);
    expect(commandLeavesCheckout('cd "$(mktemp -d)" && git init && git commit -m x')).toBe(true);
  });

  test("transcriptGitOutcomes pairs each result with the call that made it", () => {
    const messages = [
      { tool_calls: [{ id: "t1", name: "Bash", input: JSON.stringify({ command: "git commit -m a" }) }, { id: "t2", name: "Bash", input: { command: "git log -1" } }, { id: "t3", name: "Bash", input: { command: "gh pr create -f" } }] },
      { tool_results: [{ tool_use_id: "t1", content: "[main 1111111] a" }, { tool_use_id: "t2", content: "[main 2222222] not from a commit" }, { tool_use_id: "t3", content: "https://github.com/o/r/pull/9" }] },
    ];
    const outcomes = transcriptGitOutcomes(messages);
    expect([...outcomes.commitShas]).toEqual(["1111111"]);
    expect([...outcomes.prRefs]).toEqual(["o/r#9"]);
    expect(madeInTranscript("1111111" + "a".repeat(33), outcomes.commitShas)).toBe(true);
    expect(madeInTranscript("2222222" + "a".repeat(33), outcomes.commitShas)).toBe(false);
  });
});
