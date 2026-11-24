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

describe("sign-in on a messaging-only machine writes the auth config and nothing else", () => {
  const body = () => bodyOf("async function runOnboarding(config: Config): Promise<void> {");

  test("runOnboarding returns first, before the history import, ~/.claude writes, the daemon and autostart", () => {
    const b = body();
    expect(b.startsWith("async function runOnboarding(config: Config): Promise<void> {\n  if (messagingOnly(config)) {\n")).toBe(true);
    const gate = b.indexOf("return;", b.indexOf("messagingOnly(config)"));
    for (const later of ["history_import_pending", "installSlashCommand()", "syncHooks(config)", "installSkillsSnippet", "startDaemon()", "ensureAutostart()"]) {
      expect(b.indexOf(later)).toBeGreaterThan(gate);
    }
  });

  test("runAuth and runLogin write the config before onboarding and spread the existing one, so the flag survives sign-in", () => {
    for (const fn of ["async function runLogin(setupToken: string): Promise<void> {", "async function runAuth(opts: { query?: Record<string, string> } = {}): Promise<void> {"]) {
      const b = bodyOf(fn);
      expect(b).toContain("...existingConfig,");
      expect(b.indexOf("writeConfig(config);")).toBeLessThan(b.indexOf("await runOnboarding(config);"));
    }
  });

  test("the enrollment path does not start a daemon on such a machine", () => {
    expect(INDEX).toContain("else if (!autostartDisabledByEnv() && !isDaemonRunning() && !messagingOnly(enrolled)) {\n      startDaemon();");
  });
});

describe("uninstall stops the relay", () => {
  test("it asks stopRelay to stop it before removing anything", () => {
    const start = INDEX.indexOf('.command("uninstall")');
    const block = INDEX.slice(start, INDEX.indexOf('.command("links")', start));
    expect(block).toContain('await import("./relay/relayCommand.js")');
    expect(block).toContain("await stopRelay(realStopDeps(), DEFAULT_INTERVALS.replaceWait);");
    expect(block.indexOf("stopRelay(")).toBeLessThan(block.indexOf("// 2. Remove auto-start"));
  });
});

describe("the auto-update stays out of the hook commands, flag or not", () => {
  test("register, unregister and relay are recognised by argv", () => {
    for (const verb of ["register", "unregister", "relay"]) expect(isRelayHookArgv(["bun", "cast", verb, "--background"])).toBe(true);
    for (const verb of ["send", "feed", "registered", "relay-x", ""]) expect(isRelayHookArgv(["bun", "cast", verb])).toBe(false);
    expect(isRelayHookArgv(["bun", "cast"])).toBe(false);
  });

  test("the auto-update line skips it through the hook fast-path flag", () => {
    expect(INDEX).toMatch(/const isStableContextFastPath = [^\n]*\|\| isRelayHookArgv\(process\.argv\);/);
    expect(INDEX).toMatch(/if \(!isStableContextFastPath && [^\n]*autoUpdateSettled = checkForUpdates\(\)/);
  });

  test("the three commands skip the daemon autostart and command log in the preAction hook", () => {
    const line = INDEX.split("\n").find((l) => l.includes("const internalCmds = ["))!;
    for (const verb of ["register", "unregister", "relay"]) expect(line).toContain(`'${verb}'`);
  });
});
