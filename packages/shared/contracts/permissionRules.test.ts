import { describe, expect, test } from "bun:test";
import {
  boundedRuleRequest,
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
    ["terraform", "terraform *"],
  ])("%s saves %s", (command, saved) => {
    expect(shellRequest(command).always).toEqual([saved]);
  });

  test("splits on control operators, drops cd, keeps each sub-command", () => {
    const r = shellRequest("cd /repo && git status; git push origin main | tee /dev/null || echo 'no luck'");
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
    expect(claudeToolRequest("Write", { file_path: "/r/a.ts" })).toEqual({ permission: "edit", patterns: ["/r/a.ts"], always: ["*"] });
    expect(codexApprovalRequest("applyPatchApproval", { changes: { "/r/a.ts": {} } })).toEqual({ permission: "edit", patterns: ["/r/a.ts"], always: ["*"] });
  });

  test("WebFetch keeps the host", () => {
    expect(claudeToolRequest("WebFetch", { url: "https://docs.x.dev/a?b" }).always).toEqual(["docs.x.dev"]);
  });
});

test("an oversized request keeps no patterns rather than a cut", () => {
  const r = shellRequest(Array.from({ length: 40 }, (_, i) => `echo ${i}`).join(" && "));
  expect(boundedRuleRequest(r)).toEqual({ permission: "bash", patterns: [], always: [], opaque: true });
});
