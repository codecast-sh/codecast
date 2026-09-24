import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HARNESS_HOOKS } from "@codecast/shared/contracts";
import { CODECAST_HOOK_SCRIPTS, STATUSLINE_HOOK_SCRIPT } from "./codecastOwned.js";
import { installHarnessHooks, removeHarnessHooks, syncHarnessHooks } from "./harnessHooksInstall.js";
import { readHarnessChanges, withHarnessCause } from "./harness.js";

let home: string;
let prevHome: string | undefined;
let prevDir: string | undefined;

const settingsFile = () => path.join(home, ".claude", "settings.json");
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf-8"));
const commandsFor = (s: any, event: string): string[] =>
  (s.hooks?.[event] ?? []).flatMap((m: any) => (m.hooks ?? []).map((h: any) => h.command));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-hooks-"));
  prevHome = process.env.HOME;
  prevDir = process.env.CODECAST_DIR;
  process.env.HOME = home;
  process.env.CODECAST_DIR = path.join(home, ".codecast");
});

afterEach(() => {
  process.env.HOME = prevHome;
  if (prevDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = prevDir;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("HARNESS_HOOKS", () => {
  test("names only files codecast owns", () => {
    const owned = new Set<string>([...CODECAST_HOOK_SCRIPTS, STATUSLINE_HOOK_SCRIPT]);
    for (const h of HARNESS_HOOKS) expect(owned.has(h.file)).toBe(true);
  });
});

describe("installHarnessHooks", () => {
  test("registers every hook, and a second run writes nothing", () => {
    installHarnessHooks();
    const s = readSettings();
    for (const h of HARNESS_HOOKS) {
      for (const e of h.events) expect(commandsFor(s, e)).toContain(path.join(home, ".claude", "hooks", h.file));
    }
    expect(s.statusLine?.command).toBe(path.join(home, ".claude", "hooks", STATUSLINE_HOOK_SCRIPT));

    const before = readHarnessChanges(1000).length;
    const bytes = fs.readFileSync(settingsFile(), "utf-8");
    installHarnessHooks();
    expect(readHarnessChanges(1000).length).toBe(before);
    expect(fs.readFileSync(settingsFile(), "utf-8")).toBe(bytes);
  });

  test("records why each write happened", () => {
    withHarnessCause({ why: "automatic update to v9.9.9", automatic: true }, () => installHarnessHooks());
    const changes = readHarnessChanges(1000);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.why === "automatic update to v9.9.9" && c.automatic)).toBe(true);
    expect(changes.some((c) => c.file === "~/.claude/settings.json" && c.what === "hooks")).toBe(true);
  });
});

describe("removeHarnessHooks", () => {
  test("removes hooks an older installer wrote, and keeps the user's own", () => {
    // What the pre-ledger installer left: our entries in the blanket matcher,
    // no ownership ledger, indent 4, next to a hook the user wrote.
    const dir = path.join(home, ".claude", "hooks");
    fs.mkdirSync(dir, { recursive: true });
    const status = path.join(dir, "codecast-status.sh");
    const register = path.join(dir, "session-register.sh");
    fs.writeFileSync(status, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(register, "#!/bin/sh\n", { mode: 0o755 });
    const legacy = {
      model: "opus",
      hooks: {
        SessionStart: [{ matcher: "", hooks: [
          { type: "command", command: register, timeout: 10 },
          { type: "command", command: "/usr/local/bin/my-own-hook", timeout: 5 },
          { type: "command", command: status, timeout: 10 },
        ] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: status, timeout: 10 }] }],
      },
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(legacy, null, 4));

    removeHarnessHooks();

    const s = readSettings();
    expect(commandsFor(s, "SessionStart")).toEqual(["/usr/local/bin/my-own-hook"]);
    expect(s.hooks?.Stop).toBeUndefined();
    expect(s.model).toBe("opus");
    expect(fs.existsSync(status)).toBe(false);
    expect(fs.existsSync(register)).toBe(false);
  });

  test("syncHarnessHooks follows the switch", () => {
    syncHarnessHooks({});
    expect(commandsFor(readSettings(), "Stop").length).toBeGreaterThan(0);
    syncHarnessHooks({ hooks_enabled: false });
    const s = readSettings();
    expect(s.hooks).toBeUndefined();
    expect(s.statusLine).toBeUndefined();
  });
});
