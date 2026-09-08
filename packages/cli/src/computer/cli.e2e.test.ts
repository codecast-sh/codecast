/**
 * `cast computer` end to end: the real argv, through the real `index.ts`
 * registration, in a real process.
 *
 * Two halves, and both matter.
 *
 * The **ungranted half always runs**, on any machine and any platform. It is
 * what proves the verb group is actually registered, that the lazy action
 * import resolves, and that a CLI carrying no helper says so in the error
 * envelope instead of hanging, crashing, or leaving a half-made directory
 * behind. This is also the exact shape of a Linux build, where the embedded
 * payload is empty by design.
 *
 * The **granted half is skipped** unless `CODECAST_COMPUTER_HELPER_APP` names a
 * built bundle (the Swift helper is another workstream, and it needs a macOS
 * machine with Accessibility granted to it):
 *
 *   CODECAST_COMPUTER_HELPER_APP="$HOME/.codecast/computer/codecast computer.app" \
 *     bun test src/computer/cli.e2e.test.ts
 *
 * Every run uses its own HOME and CODECAST_DIR, so it never touches the
 * machine's own grant, its instance file or its daemon.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

const ENTRY = path.join(import.meta.dir, "..", "index.ts");
const HELPER_APP = process.env.CODECAST_COMPUTER_HELPER_APP;
const withHelper = process.platform === "darwin" && !!HELPER_APP && fs.existsSync(HELPER_APP);

/**
 * Every test here spawns the CLI from source, and a cold module graph for
 * `index.ts` measured 5 to 11 seconds under load — against bun's 5 second
 * default, which failed most of this file for a reason that had nothing to do
 * with what it asserts. The spawn already carries its own 120 s budget, so the
 * tests run on that one.
 */
const CLI_SPAWN_TIMEOUT_MS = 120_000;
type TestBody = () => void | Promise<void>;
const cliTest = (name: string, body: TestBody) => test(name, body, CLI_SPAWN_TIMEOUT_MS);
const granted = withHelper ? cliTest : (name: string, body: TestBody) => test.skip(name, body);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  json: () => Record<string, unknown>;
}

/**
 * Run the CLI in a home of its own.
 *
 * An empty HOME means no auth token, which is what keeps the preAction hook
 * from starting a daemon on the machine running the tests — and it doubles as
 * proof of design 4.4: nothing on this path needs the daemon.
 */
function runCli(args: string[]): CliRun {
  // Rooted at /tmp rather than os.tmpdir(): macOS gives each user a temp
  // directory nested six levels deep, and the helper socket path under it
  // exceeds the 104-byte `sun_path` limit — the CLI then reports a socket path
  // that is too long, which is correct and not what these tests are asking.
  const home = fs.mkdtempSync(path.join("/tmp", "cast-computer-e2e-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const codecastDir = path.join(home, ".codecast");
  fs.mkdirSync(codecastDir, { recursive: true, mode: 0o700 });
  if (withHelper) {
    fs.mkdirSync(path.join(codecastDir, "computer"), { recursive: true, mode: 0o700 });
    fs.cpSync(HELPER_APP!, path.join(codecastDir, "computer", "codecast computer.app"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  // The run's own TMPDIR, so its sockets and screenshots land inside the home
  // this test cleans up. It has to exist before the spawn: mkdtemp does not
  // create the parent, and the CLI mints its socket directory there.
  const tmpdir = path.join(home, "tmp");
  fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
  const result = spawnSync("bun", [ENTRY, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: home, CODECAST_DIR: codecastDir, TMPDIR: tmpdir, NO_COLOR: "1" },
  });
  const stdout = result.stdout ?? "";
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? "",
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  };
}

beforeAll(() => {
  if (!withHelper) {
    console.log("computer cli e2e: helper half skipped — set CODECAST_COMPUTER_HELPER_APP to a built `codecast computer.app`");
  }
});

describe("the verb group is registered and answers without a helper", () => {
  cliTest("`cast computer --help` lists every verb the design names", () => {
    const run = runCli(["computer", "--help"]);
    expect(run.status).toBe(0);
    const help = `${run.stdout}${run.stderr}`;
    for (const verb of [
      "capabilities", "permissions", "list-apps", "list-windows", "get-app-state", "click",
      "perform-secondary-action", "scroll", "type-text", "press-key", "hotkey", "paste-text", "set-value",
    ]) {
      expect(help).toContain(verb);
    }
    // v1 ships no drag verb: it cannot be verified, and Orca's delivery does
    // nothing in many apps while reporting success.
    expect(help).not.toContain("cast computer drag");
  });

  cliTest("an invented verb fails instead of printing help to stdout", () => {
    const run = runCli(["computer", "bogus"]);
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe("");
    expect(run.stderr).toContain("unknown command 'computer bogus'");
  });

  cliTest("a flag error is refused in-process, with the code and the recovery", () => {
    const run = runCli(["computer", "press-key", "--app", "com.apple.Finder", "--key", "Cmd+A", "--json"]);
    expect(run.status).toBe(1);
    expect(run.json()).toMatchObject({ ok: false, code: "invalid_argument" });
    expect(String(run.json().message)).toContain("press-key accepts one key only");
  });

  cliTest("a build with no embedded helper says so rather than hanging or crashing", () => {
    // From source, `helper.tar` is empty, which is exactly the state of every
    // Linux and Windows build. The verb must report the feature unavailable.
    //
    // WHICH unavailability is the platform's answer, not the test's. On macOS
    // the machine could run a helper and this build carries none, so the
    // obstacle is the missing helper. Off macOS there is no such feature to
    // carry, and `unsupported_capability` is the honest code — asserting the
    // macOS one there tests the runner, not the CLI (ct-49945).
    if (withHelper) return;
    const run = runCli(["computer", "get-app-state", "--app", "com.apple.Finder", "--json"]);
    expect(run.status).toBe(1);
    const envelope = run.json();
    expect(Object.keys(envelope)[0]).toBe("ok");
    expect(envelope.ok).toBe(false);
    if (process.platform === "darwin") {
      expect(envelope.code).toBe("accessibility_error");
      expect(String(envelope.message)).toContain("not built into this CLI");
    } else {
      expect(envelope.code).toBe("unsupported_capability");
      expect(String(envelope.message)).toContain("macOS");
    }
    expect((envelope.recovery as string[]).length).toBeGreaterThan(0);
  });

  cliTest("permissions reports the missing helper instead of claiming a grant", () => {
    if (withHelper) return;
    const run = runCli(["computer", "permissions", "--json"]);
    if (process.platform !== "darwin") {
      // Off macOS the feature is unsupported, and saying so is the whole answer.
      expect(run.json()).toMatchObject({ ok: true });
      return;
    }
    // A status read reports; it does not fail and it does not raise (ct-49667).
    // The report has to name the helper as the obstacle rather than send the
    // agent to grant Accessibility to an app that is not on the machine.
    expect(run.status).toBe(0);
    const report = run.json() as any;
    expect(report.launchedHelper).toBe(false);
    expect(String(report.helperUnavailableReason)).toMatch(/not built into this CLI|was not found/);
    expect(String(report.nextStep)).toContain("No grant can be read yet");
    expect((report.permissions as { status: string }[]).every((p) => p.status === "not-granted")).toBe(true);
  });

  cliTest("--open-settings on a build with no helper fails loudly instead of half-raising", () => {
    if (withHelper) return;
    if (process.platform !== "darwin") return;
    const run = runCli(["computer", "permissions", "--open-settings", "--json"]);
    expect(run.status).toBe(1);
    expect(run.json()).toMatchObject({ ok: false, code: "accessibility_error" });
  });

  cliTest("--id only accepts the two grants that exist", () => {
    const run = runCli(["computer", "permissions", "--id", "everything", "--json"]);
    expect(run.status).toBe(1);
    expect(run.json()).toMatchObject({ ok: false, code: "invalid_argument" });
  });
});

describe("against the built helper", () => {
  granted("capabilities reports protocol 1, no drag and no focus verb", () => {
    const run = runCli(["computer", "capabilities", "--json"]);
    expect(run.status).toBe(0);
    const caps = run.json() as any;
    expect(caps.ok).toBe(true);
    expect(caps.protocolVersion).toBe(1);
    expect(caps.supports.actions.drag).toBe(false);
    expect(caps.supports.windows.focus).toBe(false);
  });

  granted("list-apps names real apps with bundle ids", () => {
    const run = runCli(["computer", "list-apps", "--json"]);
    expect(run.status).toBe(0);
    const apps = (run.json() as any).apps as { bundleId: string | null; pid: number }[];
    expect(apps.length).toBeGreaterThan(0);
    expect(apps.some((app) => typeof app.bundleId === "string" && app.pid > 0)).toBe(true);
  });

  granted("a snapshot writes its screenshot to a 0600 path and never inlines base64", () => {
    const permissions = runCli(["computer", "permissions", "--json"]).json() as any;
    const accessibility = (permissions.permissions ?? []).find((p: { id: string }) => p.id === "accessibility");
    if (accessibility?.status !== "granted") {
      console.log("computer cli e2e: Accessibility not granted to the helper — grant it and rerun for the tree half");
      return;
    }
    const run = runCli(["computer", "get-app-state", "--app", "com.apple.Finder", "--json"]);
    expect(run.status).toBe(0);
    const result = run.json() as any;
    expect(result.snapshot.treeText.length).toBeGreaterThan(0);
    expect(result.screenshot?.data).toBeUndefined();
    if (result.screenshot?.path) {
      expect(fs.statSync(result.screenshot.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(result.screenshot.path)).mode & 0o777).toBe(0o700);
    }
  });
});
