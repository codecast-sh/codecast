// Codecast's rules settle a call before any card: the daemon asks
// permissionRules.check first and opens a card only when it says "ask".
import { describe, expect, test } from "bun:test";
import { shellRequest } from "@codecast/shared/contracts/permissionRules";
import { handlePermissionRequest } from "./permissionHandler";
import { parsePermissionHookInput, permissionDecisionOutput } from "./permissionHookWait";

function fakeSync(verdict: any) {
  const created: any[] = [];
  const sync = {
    checkPermission: async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
    createPermissionRequest: async (p: any) => { created.push(p); return "perm1"; },
    getPermissionDecision: async () => ({ _id: "perm1", status: "approved", tool_name: "Bash" }),
    cancelPermissionRequest: async () => true,
  };
  return { sync: sync as any, created };
}

const prompt = { tool_name: "Bash", arguments_preview: "git push", ruleRequest: shellRequest("git push") };

describe("settling before a card", () => {
  test("an allow answers with no card", async () => {
    const { sync, created } = fakeSync({ action: "allow", reason: "rule" });
    expect(await handlePermissionRequest(sync, "c", "s", prompt, () => {})).toEqual({ approved: true, settled: "rule" });
    expect(created).toEqual([]);
  });

  test("an unattended deny carries its message to the agent and stops nothing", async () => {
    const { sync, created } = fakeSync({ action: "deny", reason: "unattended", message: "Nobody is watching" });
    const decision = await handlePermissionRequest(sync, "c", "s", prompt, () => {});
    expect(decision).toEqual({ approved: false, message: "Nobody is watching", settled: "unattended" });
    expect(created).toEqual([]);
    const out = JSON.parse(permissionDecisionOutput(decision!, []));
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "Nobody is watching" });
  });

  test("ask opens a card that carries the rule request", async () => {
    const { sync, created } = fakeSync({ action: "ask" });
    expect((await handlePermissionRequest(sync, "c", "s", prompt, () => {}))?.approved).toBe(true);
    expect(created[0].rule_request).toEqual(shellRequest("git push"));
  });

  test("a server that cannot answer the check falls back to a card", async () => {
    const { sync, created } = fakeSync(new Error("Could not find public function"));
    await handlePermissionRequest(sync, "c", "s", prompt, () => {});
    expect(created).toHaveLength(1);
  });

  test("prechecked skips the check", async () => {
    const { sync, created } = fakeSync({ action: "allow" });
    await handlePermissionRequest(sync, "c", "s", { ...prompt, prechecked: true }, () => {});
    expect(created).toHaveLength(1);
  });
});

test("the hook payload carries the call in rule terms", () => {
  const input = parsePermissionHookInput(JSON.stringify({
    hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Bash", tool_input: { command: "cd sub && npm run build" }, cwd: import.meta.dir,
  }));
  expect(input?.ruleRequest).toEqual({ permission: "bash", patterns: ["npm run build"], always: ["npm run build *"] });
});

test("an approval never hands codecast-kept rules back to Claude", () => {
  const out = JSON.parse(permissionDecisionOutput({ approved: true, remember: true }, []));
  expect(out.hookSpecificOutput.decision).toEqual({ behavior: "allow" });
});
