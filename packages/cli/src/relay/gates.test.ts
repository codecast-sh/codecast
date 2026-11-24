import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isRelayHookArgv, messagingOnly } from "../fastPath.js";

const INDEX = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf-8");

function bodyOf(signature: string): string {
  const start = INDEX.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = INDEX.indexOf("\n}\n", start);
  return INDEX.slice(start, end);
}

describe("the messaging-only flag", () => {
  test("is on only when the config says exactly true", () => {
    expect(messagingOnly({ messaging_only: true })).toBe(true);
    expect(messagingOnly({ messaging_only: false })).toBe(false);
    expect(messagingOnly({})).toBe(false);
    expect(messagingOnly(null)).toBe(false);
    expect(messagingOnly(undefined)).toBe(false);
  });

  test("is set and cleared by `cast config messaging_only true|false`", () => {
    expect(INDEX).toMatch(/CONFIG_SETTABLE_KEYS = \[[^\]]*"messaging_only"/);
    expect(INDEX).toMatch(/BOOLEAN_CONFIG_KEYS = new Set<string>\(\[[^\]]*"messaging_only"/);
  });
});

describe("what the flag gates in index.ts", () => {
  test("ensureDaemonRunning never starts the daemon", () => {
    const body = bodyOf("function ensureDaemonRunning(): void {");
    expect(body).toMatch(/if \(!config\?\.auth_token \|\| messagingOnly\(config\)\) return;\n/);
    expect(body.indexOf("messagingOnly(config)")).toBeLessThan(body.indexOf("startDaemonQuiet()"));
  });

  test("refreshEnabledSnippets, which the auto-update and `cast update` call, returns before writing anything", () => {
    const body = bodyOf("async function refreshEnabledSnippets(config: Record<string, any>): Promise<void> {");
    expect(body.startsWith("async function refreshEnabledSnippets(config: Record<string, any>): Promise<void> {\n  if (messagingOnly(config)) return;\n")).toBe(true);
  });

  test("hook sync returns before touching the Claude settings", () => {
    for (const signature of ["async function syncHooks(config?: Record<string, any> | null): Promise<void> {", "async function syncFeatureHooks(config?: Record<string, any> | null): Promise<void> {"]) {
      const body = bodyOf(signature);
      expect(body.indexOf("messagingOnly(config ?? readConfig())")).toBeGreaterThan(-1);
      expect(body.indexOf("messagingOnly(")).toBeLessThan(body.indexOf("harnessHooksInstall"));
    }
  });
});

describe("the auto-update stays out of the hook commands, flag or not", () => {
  test("register, unregister and relay are recognised by argv", () => {
    for (const verb of ["register", "unregister", "relay"]) expect(isRelayHookArgv(["bun", "cast", verb, "--background"])).toBe(true);
    for (const verb of ["send", "feed", "registered", "relay-x", ""]) expect(isRelayHookArgv(["bun", "cast", verb])).toBe(false);
    expect(isRelayHookArgv(["bun", "cast"])).toBe(false);
  });

  test("the auto-update line is guarded by it, beside the stable-context guard", () => {
    expect(INDEX).toMatch(/if \(!isStableContextFastPath && !isRelayHookArgv\(process\.argv\) && [^\n]*autoUpdateSettled = checkForUpdates\(\)/);
  });

  test("the three commands skip the daemon autostart and command log in the preAction hook", () => {
    const line = INDEX.split("\n").find((l) => l.includes("const internalCmds = ["))!;
    for (const verb of ["register", "unregister", "relay"]) expect(line).toContain(`'${verb}'`);
  });
});
