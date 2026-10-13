import { describe, expect, test } from "bun:test";
import { addCommitTrailer, findGitCommits, SESSION_LINK_FRESH_MS, sessionLinkLookup, sessionTrailerHookOutput, type SessionLinkIO, type SessionTrailerDeps } from "./sessionTrailer";
import type { CachedSessionLink } from "./localConversationMap";

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
    expect(add(`git commit -m a --trailer='codecast-session=x'`)).toBeNull();
    expect(add(`git commit --trailer "Codecast-Session:x" -m a`)).toBeNull();
  });

  test("a message that mentions the key still gets the trailer", () => {
    expect(add(`git commit -m "feat: add the Codecast-Session trailer"`)).toBe(`git commit${F} -m "feat: add the Codecast-Session trailer"`);
    expect(add(`git commit -m "Codecast-Session: quoted in the subject"`)).toBe(`git commit${F} -m "Codecast-Session: quoted in the subject"`);
    const heredoc = `git commit -F - <<'EOF'\nfeat: Codecast-Session trailer\n\nCodecast-Session: x\nEOF\n`;
    expect(add(heredoc)).toBe(`git commit${F} -F - <<'EOF'\nfeat: Codecast-Session trailer\n\nCodecast-Session: x\nEOF\n`);
    // Another trailer, or our key passed to a different command, does not count.
    expect(add(`git commit -m a --trailer "Co-authored-by: x"`)).toBe(`git commit${F} -m a --trailer "Co-authored-by: x"`);
    expect(add(`echo --trailer "Codecast-Session: x"; git commit -m a`)).toBe(`echo --trailer "Codecast-Session: x"; git commit${F} -m a`);
  });

  test("only the commit that already names the trailer is skipped", () => {
    expect(add(`git commit -m a --trailer "Codecast-Session: x" && git commit --amend -m b`))
      .toBe(`git commit -m a --trailer "Codecast-Session: x" && git commit${F} --amend -m b`);
  });

  test("quotes in the trailer value are escaped for the shell", () => {
    expect(addCommitTrailer("git commit -m a", "K: it's")).toBe(`git commit --trailer 'K: it'\\''s' -m a`);
  });

  test("each commit knows the directory it runs in", () => {
    expect(findGitCommits("git commit")).toEqual([{ offset: 10, dir: ".", named: false }]);
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
    teamVisible: async () => true,
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

  test("a conversation id that is not a Convex id never reaches the command", async () => {
    for (const bad of ["abc", "jx7bq5kz13a2eypp4a6vdqznas7zvrw2'; rm -rf ~; '", "../../x", "JX7BQ5KZ13A2EYPP4A6VDQZNAS7ZVRW2"]) {
      const d = deps({ conversationFor: async () => bad });
      expect(await sessionTrailerHookOutput(hookInput("git commit -m a"), d)).toBe("");
      expect(d.logs.join("\n")).toContain("not a conversation id");
    }
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

describe("the team-visible policy", () => {
  const cmd = hookInput("git commit -m a");

  test("a session its team can see gets the trailer; a private one does not", async () => {
    expect(await sessionTrailerHookOutput(cmd, deps())).toContain("--trailer");
    const priv = deps({ teamVisible: async () => false });
    expect(await sessionTrailerHookOutput(cmd, priv)).toBe("");
    expect(priv.logs.join("\n")).toContain("private to you");
  });

  test("unknown visibility (server unreachable, older server) adds nothing", async () => {
    const d = deps({ teamVisible: async () => null });
    expect(await sessionTrailerHookOutput(cmd, d)).toBe("");
    expect(d.logs.join("\n")).toContain("could not learn");
  });

  test("always, in the environment or the repository, trails a private session without asking", async () => {
    let asked = 0;
    const priv = (over: Partial<SessionTrailerDeps>) => deps({ teamVisible: async () => { asked++; return false; }, ...over });
    expect(await sessionTrailerHookOutput(cmd, priv({ env: { CODECAST_SESSION_TRAILER: "always" } }))).toContain("--trailer");
    expect(await sessionTrailerHookOutput(cmd, priv({ repoSetting: () => "Always" }))).toContain("--trailer");
    expect(asked).toBe(0);
    // Per directory: only the commit in the overridden repository gets it.
    const mixed = priv({ repoSetting: (dir) => (dir === "/tmp/pub" ? "always" : null) });
    const out = JSON.parse(await sessionTrailerHookOutput(hookInput("git commit -m a; cd /tmp/pub && git commit -m b"), mixed));
    expect(out.hookSpecificOutput.updatedInput.command).toMatch(/^git commit -m a; cd \/tmp\/pub && git commit --trailer '/);
  });

  test("off still wins over visibility", async () => {
    expect(await sessionTrailerHookOutput(cmd, deps({ repoSetting: () => "false" }))).toBe("");
  });
});

describe("sessionLinkLookup", () => {
  function io(over: Partial<SessionLinkIO> & { cache?: Record<string, CachedSessionLink>; t?: number } = {}) {
    const saved: [string, CachedSessionLink][] = [];
    let fetches = 0;
    const base: SessionLinkIO = {
      local: () => ({ "sess-1": ID }),
      cached: () => over.cache ?? {},
      save: (sid, link) => saved.push([sid, link]),
      fetch: async () => ({ conversation_id: ID, team_visible: true }),
      now: () => over.t ?? 1_000_000,
    };
    const { cache: _c, t: _t, ...rest } = over;
    return { lookup: sessionLinkLookup({ ...base, ...rest, fetch: async (sid) => { fetches++; return (rest.fetch ?? base.fetch)(sid); } }), saved, fetches: () => fetches };
  }

  test("a fresh cache entry answers without a request", async () => {
    const x = io({ cache: { "sess-1": { conversation_id: ID, team_visible: false, checked_at: 1_000_000 - 1000 } } });
    expect(await x.lookup.conversationFor("sess-1")).toBe(ID);
    expect(await x.lookup.teamVisible("sess-1", ID)).toBe(false);
    expect(x.fetches()).toBe(0);
  });

  test("a miss asks the server once and caches the answer", async () => {
    const x = io();
    expect(await x.lookup.teamVisible("sess-1", ID)).toBe(true);
    expect(await x.lookup.teamVisible("sess-1", ID)).toBe(true);
    expect(x.fetches()).toBe(1);
    expect(x.saved).toEqual([["sess-1", { conversation_id: ID, team_visible: true, checked_at: 1_000_000 }]]);
  });

  test("a stale entry is re-asked, and still answers when the server cannot", async () => {
    const stale = { "sess-1": { conversation_id: ID, team_visible: true, checked_at: 1_000_000 - SESSION_LINK_FRESH_MS - 1 } };
    const up = io({ cache: stale, fetch: async () => ({ conversation_id: ID, team_visible: false }) });
    expect(await up.lookup.teamVisible("sess-1", ID)).toBe(false);
    const down = io({ cache: stale, fetch: async () => null });
    expect(await down.lookup.teamVisible("sess-1", ID)).toBe(true);
    expect(down.saved).toEqual([]);
  });

  test("an entry for another conversation, or a server without the flag, is no answer", async () => {
    const other = io({ cache: { "sess-1": { conversation_id: "jx7other00000000000000000000000", team_visible: true, checked_at: 1_000_000 } }, fetch: async () => null });
    expect(await other.lookup.teamVisible("sess-1", ID)).toBeNull();
    const old = io({ fetch: async () => ({ conversation_id: ID }) });
    expect(await old.lookup.teamVisible("sess-1", ID)).toBeNull();
    expect(old.saved).toEqual([]);
  });

  test("a session the daemon has not mapped yet comes from the cache, then the server", async () => {
    const x = io({ local: () => ({}), cache: { "sess-2": { conversation_id: ID, team_visible: true, checked_at: 1 } } });
    expect(await x.lookup.conversationFor("sess-2")).toBe(ID);
    expect(x.fetches()).toBe(0);
    expect(await x.lookup.conversationFor("sess-3")).toBe(ID);
    expect(x.fetches()).toBe(1);
  });
});
