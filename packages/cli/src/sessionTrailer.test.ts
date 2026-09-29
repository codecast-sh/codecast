import { describe, expect, test } from "bun:test";
import { addCommitTrailer, findGitCommits, sessionTrailerHookOutput, type SessionTrailerDeps } from "./sessionTrailer";

const T = "Codecast-Session: https://codecast.sh/conversation/abc";
const F = ` --trailer '${T}'`;
const add = (c: string) => addCommitTrailer(c, T);

describe("addCommitTrailer", () => {
  test("the plain forms", () => {
    expect(add(`git commit -m "fix: x"`)).toBe(`git commit${F} -m "fix: x"`);
    expect(add(`git commit -am 'fix: x'`)).toBe(`git commit${F} -am 'fix: x'`);
    expect(add(`git commit -F msg.txt`)).toBe(`git commit${F} -F msg.txt`);
    expect(add(`git commit --amend --no-edit`)).toBe(`git commit${F} --amend --no-edit`);
    expect(add(`git commit`)).toBe(`git commit${F}`);
  });

  test("inside compound commands, every commit, and nothing else", () => {
    expect(add(`git add . && git commit -m "a" && git push`)).toBe(`git add . && git commit${F} -m "a" && git push`);
    expect(add(`cd repo; git commit -m a || echo no`)).toBe(`cd repo; git commit${F} -m a || echo no`);
    expect(add(`git commit -m a\ngit commit --amend -m b`)).toBe(`git commit${F} -m a\ngit commit${F} --amend -m b`);
    expect(add(`(cd sub && git commit -m a)`)).toBe(`(cd sub && git commit${F} -m a)`);
    expect(add(`if true; then git commit -m a; fi`)).toBe(`if true; then git commit${F} -m a; fi`);
  });

  test("global options and env prefixes before the subcommand", () => {
    expect(add(`git -C /tmp/r commit -m a`)).toBe(`git -C /tmp/r commit${F} -m a`);
    expect(add(`git -c commit.gpgsign=false --no-pager commit -m a`)).toBe(`git -c commit.gpgsign=false --no-pager commit${F} -m a`);
    expect(add(`GIT_AUTHOR_NAME=x git commit -m a`)).toBe(`GIT_AUTHOR_NAME=x git commit${F} -m a`);
  });

  test("heredoc commit messages: the body is never touched, the commit is", () => {
    const cmd = `git commit -F - <<'EOF'\nfix: git commit is great\n\ngit commit -m inside\nEOF\n`;
    expect(add(cmd)).toBe(`git commit${F} -F - <<'EOF'\nfix: git commit is great\n\ngit commit -m inside\nEOF\n`);
    const sub = `git commit -m "$(cat <<'EOF'\nfix: x\nEOF\n)"`;
    expect(add(sub)).toBe(`git commit${F} -m "$(cat <<'EOF'\nfix: x\nEOF\n)"`);
  });

  test("text that only mentions a commit is left alone", () => {
    expect(add(`echo "git commit -m x"`)).toBeNull();
    expect(add(`echo git commit`)).toBeNull();
    expect(add(`git log --grep commit`)).toBeNull();
    expect(add(`# git commit -m x\nls`)).toBeNull();
    expect(add(`git show commit`)).toBeNull();
    expect(add(`gh pr create --title "git commit"`)).toBeNull();
    expect(add(`ls > git; cat commit`)).toBeNull();
  });

  test("idempotent: a command that already names the trailer is left alone", () => {
    const once = add(`git commit -m a`)!;
    expect(add(once)).toBeNull();
    expect(add(`git commit -m "a" --trailer "Codecast-Session: x"`)).toBeNull();
  });

  test("quotes in the trailer value are escaped for the shell", () => {
    expect(addCommitTrailer("git commit -m a", "K: it's")).toBe(`git commit --trailer 'K: it'\\''s' -m a`);
  });

  test("each commit knows the directory it runs in", () => {
    expect(findGitCommits("git commit")).toEqual([{ offset: 10, dir: "." }]);
    expect(findGitCommits(`cd /tmp/r && git commit -m a`).map((c) => c.dir)).toEqual(["/tmp/r"]);
    expect(findGitCommits(`cd sub; git -C inner commit -m a; cd "../other" && git commit`).map((c) => c.dir)).toEqual(["sub/inner", "sub/../other"]);
    expect(findGitCommits(`git -C ~/src/x commit -m a`).map((c) => c.dir)).toEqual(["~/src/x"]);
  });

  test("keep drops the commits of an opted out directory only", () => {
    expect(addCommitTrailer(`git commit -m a; cd off && git commit -m b`, T, (d) => d !== "off")).toBe(`git commit${F} -m a; cd off && git commit -m b`);
  });
});

const ID = "jx7bq5kz13a2eypp4a6vdqznas7zvrw2";
function deps(over: Partial<SessionTrailerDeps> = {}): SessionTrailerDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    env: {},
    configEnabled: () => true,
    repoSetting: () => null,
    gitTakesTrailer: () => true,
    conversationFor: async (sid) => (sid === "sess-1" ? ID : null),
    webUrl: "https://codecast.sh",
    log: (l) => logs.push(l),
    logs,
    ...over,
  };
}
const hookInput = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "sess-1", cwd: "/tmp/r", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "Commit" }, ...extra });

describe("sessionTrailerHookOutput", () => {
  test("rewrites the command and keeps every other input field", async () => {
    const out = JSON.parse(await sessionTrailerHookOutput(hookInput(`git commit -m "fix"`), deps()));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          command: `git commit --trailer 'Codecast-Session: https://codecast.sh/conversation/${ID}' -m "fix"`,
          description: "Commit",
        },
      },
    });
    // No permission decision: the permission flow is untouched.
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  test("each off switch leaves the command alone", async () => {
    const cmd = hookInput("git commit -m a");
    expect(await sessionTrailerHookOutput(cmd, deps({ env: { CODECAST_SESSION_TRAILER: "0" } }))).toBe("");
    expect(await sessionTrailerHookOutput(cmd, deps({ configEnabled: () => false }))).toBe("");
    expect(await sessionTrailerHookOutput(cmd, deps({ repoSetting: () => "false" }))).toBe("");
    expect(await sessionTrailerHookOutput(cmd, deps({ repoSetting: () => "true" }))).not.toBe("");
  });

  test("the repository setting is read where the commit runs, not in the session's cwd", async () => {
    const asked: string[] = [];
    const d = deps({ repoSetting: (dir) => { asked.push(dir); return dir === "/work/off" ? "false" : null; } });
    expect(await sessionTrailerHookOutput(hookInput("cd /work/off && git commit -m a"), d)).toBe("");
    expect(asked).toEqual(["/work/off"]);
    expect(await sessionTrailerHookOutput(hookInput("git -C ../on commit -m a"), d)).toContain("--trailer");
    expect(asked).toContain("/tmp/on");
  });

  test("not a Bash commit, an unknown session, an old git: nothing, never an error", async () => {
    expect(await sessionTrailerHookOutput(hookInput("ls"), deps())).toBe("");
    expect(await sessionTrailerHookOutput(hookInput("git commit -m a", { tool_name: "Edit" }), deps())).toBe("");
    expect(await sessionTrailerHookOutput("not json", deps())).toBe("");
    const unknown = deps();
    expect(await sessionTrailerHookOutput(hookInput("git commit -m a", { session_id: "other" }), unknown)).toBe("");
    expect(unknown.logs[0]).toContain("has not synced yet");
    expect(await sessionTrailerHookOutput(hookInput("git commit -m a"), deps({ gitTakesTrailer: () => false }))).toBe("");
  });

  test("the lookups run only for a command that has a commit to trail", async () => {
    let looked = 0;
    const d = deps({ conversationFor: async () => { looked++; return ID; }, repoSetting: () => { looked++; return null; } });
    await sessionTrailerHookOutput(hookInput("echo git commit"), d);
    expect(looked).toBe(0);
  });
});
