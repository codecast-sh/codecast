// The installed scripts must present the hook secret on the HTTP push, and
// must not put it in the URL.
//
// Asserted against the script text this build installs rather than by running
// bash: the real-shell suite beside this one (statusHook.test.ts) already
// times out on a loaded machine, and a flaky security test is worse than an
// honest one. The end-to-end run was done by hand — the real script against a
// real loopback server — and the receipt is on ct-53055.

import { describe, expect, test } from "bun:test";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";
import { USER_PROMPT_HOOK } from "./userPromptHook.js";
import { CODECAST_STATUSLINE_HOOK } from "./statuslineHook.js";

const POSTING_SCRIPTS: Array<[string, string]> = [
  ["codecast-status.sh", CODECAST_STATUS_HOOK],
  ["codecast-prompt.sh", USER_PROMPT_HOOK],
  ["codecast-statusline.sh", CODECAST_STATUSLINE_HOOK],
];

describe("installed hook scripts", () => {
  test.each(POSTING_SCRIPTS)("%s reads the secret from the 0600 file", (_name, script) => {
    expect(script).toContain('.codecast/hook-token');
  });

  test.each(POSTING_SCRIPTS)("%s sends it as a bearer header", (_name, script) => {
    expect(script).toMatch(/-H "Authorization: Bearer /);
  });

  test.each(POSTING_SCRIPTS)("%s never puts the secret in a query parameter", (_name, script) => {
    expect(script).not.toMatch(/(hook_token|token)=\$?\{?(CODECAST_HOOK_TOKEN|cc_token)/);
  });

  test("the status script reads the secret with builtins, not another process", () => {
    // A hook runs on every tool call; one extra process per event is what blew
    // Claude Code's hook timeout before.
    const read = CODECAST_STATUS_HOOK.slice(CODECAST_STATUS_HOOK.indexOf("CODECAST_HOOK_TOKEN="));
    const line = read.split("\n").find((l) => l.includes("hook-token"))!;
    expect(line).toContain("read -r");
    expect(line).not.toContain("$(cat");
  });
});
