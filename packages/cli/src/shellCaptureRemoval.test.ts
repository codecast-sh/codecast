import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

test.each([false, true])("hook refresh removes shell capture without touching user hooks (previous install: %s)", (installed) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-retired-hook-"));
  homes.push(home);
  const configDir = path.join(home, ".codecast");
  const hooksDir = path.join(home, ".claude", "hooks");
  const settingsFile = path.join(home, ".claude", "settings.json");
  const retired = path.join(hooksDir, "codecast-shell-changes.sh");
  const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
  const userHook = { type: "command", command: "/custom/user-hook.sh", timeout: 3 };
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{}");
  fs.writeFileSync(settingsFile, JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: Object.fromEntries(events.map((event) => [event, [
      { matcher: "Bash", hooks: [userHook, ...(installed ? [{ type: "command", command: retired }] : [])] },
    ]])),
  }));
  if (installed) fs.writeFileSync(retired, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, CODECAST_DIR: configDir, CODECAST_NO_AUTO_UPDATE: "1" };
  for (let i = 0; i < 2; i++) {
    const output = execFileSync(process.execPath, [path.join(import.meta.dir, "index.ts"), "snippets-refresh"], {
      env, encoding: "utf8", timeout: 30_000,
    });
    expect(output).toContain("snippets refreshed");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    for (const event of events) {
      const hooks = settings.hooks[event].flatMap((group: any) => group.hooks);
      expect(hooks).toContainEqual(userHook);
      expect(hooks.some((hook: any) => hook.command?.includes("codecast-shell-changes.sh"))).toBe(false);
    }
  }
  expect(fs.readFileSync(retired, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  const output = execFileSync(retired, [], { env, encoding: "utf8", input: JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_retired", cwd: process.cwd(),
  }) });
  expect(output).toBe("");
  expect(fs.existsSync(path.join(configDir, "shell-changes"))).toBe(false);
}, 90_000);
