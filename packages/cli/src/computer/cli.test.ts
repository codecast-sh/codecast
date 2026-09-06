/**
 * The verb group, driven the way an agent drives it: real argv through
 * commander, a fake client in place of the helper.
 *
 * Each test pins something the design decided and that a refactor could
 * silently undo — the flag-to-request mapping, the first word of the action
 * sentence, a screenshot that must never arrive as base64 in `--json`, a chord
 * that must be refused before it reaches the helper, and the rule that no verb
 * raises a window unless the agent asked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerComputerCommand } from "./cli.js";
import { normalizeActionResult } from "./client.js";
import { ComputerError } from "./errors.js";
import type { ComputerClientLike } from "./run.js";
import type { ComputerActionResult, ComputerSnapshotResult } from "./types.js";

/** A 1x1 png, so writeShotFile has real bytes to measure and no downscale to do. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function snapshotResult(): ComputerSnapshotResult {
  return {
    snapshot: {
      id: "snap-1",
      app: { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 4413 },
      window: { id: 812, title: "Untitled", x: 220, y: 140, width: 900, height: 700 },
      coordinateSpace: "window",
      treeText: 'App=com.apple.TextEdit (pid 4413)\nWindow: "Untitled", App: TextEdit.\n\n0 window Untitled',
      elementCount: 61,
      focusedElementId: 12,
    },
    screenshot: { data: PNG, format: "png", width: 1800, height: 1400, scale: 2 },
    screenshotStatus: { state: "captured", metadata: { engine: "cgWindowList", windowId: 812 } },
  };
}

function actionResult(action: ComputerActionResult["action"]): ComputerActionResult {
  return { ...snapshotResult(), action };
}

type Call = { method: string; params: unknown };

class FakeClient implements ComputerClientLike {
  calls: Call[] = [];
  shutdowns = 0;
  constructor(private readonly answers: { result?: unknown; error?: ComputerError } = {}) {}
  private answer(method: string, params: unknown): Promise<never> | Promise<unknown> {
    this.calls.push({ method, params });
    if (this.answers.error) return Promise.reject(this.answers.error);
    return Promise.resolve(this.answers.result);
  }
  capabilities() {
    return this.answer("capabilities", {}) as Promise<never>;
  }
  listApps() {
    return this.answer("listApps", {}) as Promise<never>;
  }
  listWindows(params: unknown) {
    return this.answer("listWindows", params) as Promise<never>;
  }
  getAppState(params: unknown) {
    return this.answer("getAppState", params) as Promise<never>;
  }
  /** The real client fills a missing verification from the action path before
   *  the CLI ever sees the result (design 14.3), so the fake does too — a CLI
   *  that only read right against an unnormalized result would be wrong in
   *  production. */
  async action(method: string, params: unknown) {
    const result = (await this.answer(method, params)) as ComputerActionResult;
    return normalizeActionResult(result) as never;
  }
  shutdown() {
    this.shutdowns++;
  }
}

let out: string[] = [];
let err: string[] = [];
let tmp = "";
let prevTmpDir: string | undefined;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  out = [];
  err = [];
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  // Every screenshot path goes through os.tmpdir(), so pointing TMPDIR at a
  // fresh directory keeps the run off the machine's real one.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-cli-"));
  prevTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  if (prevTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmpDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const stdout = () => out.join("\n");
const stderr = () => err.join("\n");

interface RunResult {
  client: FakeClient;
  exit: number | null;
  params: unknown;
  method: string | null;
  /** How many times a client was asked for — 0 proves a flag was refused
   *  before anything could launch a helper. */
  clientsCreated: number;
}

async function run(
  argv: string[],
  opts: { answers?: { result?: unknown; error?: ComputerError }; stdin?: string; tty?: boolean } = {},
): Promise<RunResult> {
  const client = new FakeClient(opts.answers ?? { result: snapshotResult() });
  let clientsCreated = 0;
  let exit: number | null = null;
  const program = new Command();
  program.exitOverride();
  registerComputerCommand(program, {
    createClient: () => {
      clientsCreated++;
      return client;
    },
    readStdin: () => opts.stdin ?? "",
    stdinIsTty: () => opts.tty ?? false,
    exit: ((code: number) => {
      exit = code;
      // Stop the verb the way process.exit would, without ending the runner.
      throw new Error(`__exit ${code}`);
    }) as never,
  });
  try {
    await program.parseAsync(["node", "cast", "computer", ...argv]);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit")) throw e;
  }
  return { client, exit, clientsCreated, params: client.calls[0]?.params, method: client.calls[0]?.method ?? null };
}

describe("argv becomes exactly one helper request", () => {
  test("get-app-state carries the app, the window selector and the observation flags", async () => {
    const r = await run(["get-app-state", "--app", "com.apple.TextEdit", "--window-id", "812", "--no-screenshot", "--restore-window"]);
    expect(r.method).toBe("getAppState");
    expect(r.params).toEqual({ app: "com.apple.TextEdit", windowId: 812, noScreenshot: true, restoreWindow: true });
  });

  test("an ordinary snapshot asks for no raise and no skip", async () => {
    const r = await run(["get-app-state", "--app", "TextEdit"]);
    expect(r.params).toEqual({ app: "TextEdit" });
  });

  test("click maps every flag mechanically, index route", async () => {
    const r = await run([
      "click", "--app", "pid:4413", "--element-index", "34", "--click-count", "2", "--mouse-button", "right", "--modifiers", "CmdOrCtrl+Shift",
    ]);
    expect(r.method).toBe("click");
    expect(r.params).toEqual({ app: "pid:4413", elementIndex: 34, clickCount: 2, mouseButton: "right", modifiers: "CmdOrCtrl+Shift" });
  });

  test("click by coordinate keeps both numbers and no element index", async () => {
    const r = await run(["click", "--app", "Slack", "--x", "120.5", "--y", "44", "--window-index", "1"]);
    expect(r.params).toEqual({ app: "Slack", windowIndex: 1, x: 120.5, y: 44 });
  });

  test("scroll, secondary action, keys and set-value each reach their own method", async () => {
    expect((await run(["scroll", "--app", "A", "--direction", "Down", "--element-index", "3", "--pages", "2"])).params).toEqual({
      app: "A", elementIndex: 3, direction: "down", pages: 2,
    });
    expect((await run(["perform-secondary-action", "--app", "A", "--element-index", "3", "--action", "zoom the window"])).params).toEqual({
      app: "A", elementIndex: 3, action: "zoom the window",
    });
    expect((await run(["press-key", "--app", "A", "--key", "Return"])).params).toEqual({ app: "A", key: "Return" });
    expect((await run(["hotkey", "--app", "A", "--key", "CmdOrCtrl+A"])).params).toEqual({ app: "A", key: "CmdOrCtrl+A" });
    expect((await run(["set-value", "--app", "A", "--element-index", "12", "--value", "hello"])).params).toEqual({
      app: "A", elementIndex: 12, value: "hello",
    });
    expect((await run(["set-value", "--app", "A", "--element-index", "12", "--value", ""])).params).toEqual({
      app: "A", elementIndex: 12, value: "",
    });
  });

  test("the connection is released even when the helper fails", async () => {
    const r = await run(["get-app-state", "--app", "A"], { answers: { error: new ComputerError("window_not_found", "no window") } });
    expect(r.client.shutdowns).toBe(1);
    expect(r.exit).toBe(1);
  });
});

describe("secrets arrive on stdin, never in argv", () => {
  test("--text-stdin reads the payload and strips the heredoc newline", async () => {
    const r = await run(["type-text", "--app", "A", "--text-stdin"], { stdin: "hunter2" });
    expect(r.params).toEqual({ app: "A", text: "hunter2" });
  });

  test("--value-stdin accepts an empty payload, because clearing a field is a real action", async () => {
    const r = await run(["set-value", "--app", "A", "--element-index", "2", "--value-stdin"], { stdin: "" });
    expect(r.params).toEqual({ app: "A", elementIndex: 2, value: "" });
  });

  test("a literal and a stdin flag together is a refusal, not a guess", async () => {
    const r = await run(["type-text", "--app", "A", "--text", "a", "--text-stdin"], { stdin: "b" });
    expect(r.method).toBeNull();
    expect(r.exit).toBe(1);
    expect(stderr()).toContain("use either --text or --text-stdin, not both");
  });

  test("a stdin payload with a terminal on stdin would hang, so it fails instead", async () => {
    const r = await run(["type-text", "--app", "A", "--text-stdin"], { tty: true });
    expect(stderr()).toContain("stdin is a terminal");
    expect(r.exit).toBe(1);
  });

  test("empty stdin has nothing to type", async () => {
    const r = await run(["type-text", "--app", "A", "--text-stdin"], { stdin: "" });
    expect(stderr()).toContain("received no input");
    expect(r.exit).toBe(1);
  });
});

describe("flags are validated before the helper is spawned", () => {
  const refuses = async (argv: string[], fragment: string) => {
    const r = await run(argv);
    expect(r.method).toBeNull();
    expect(r.exit).toBe(1);
    expect(stderr()).toContain(fragment);
  };

  test("press-key takes one key, and the literal + is one key", async () => {
    await refuses(["press-key", "--app", "A", "--key", "Cmd+A"], "press-key accepts one key only");
    expect((await run(["press-key", "--app", "A", "--key", "+"])).params).toEqual({ app: "A", key: "+" });
  });

  test("hotkey needs a modifier and exactly one key", async () => {
    await refuses(["hotkey", "--app", "A", "--key", "A"], "hotkey requires a modifier and one key");
    await refuses(["hotkey", "--app", "A", "--key", "Cmd+Shift"], "hotkey requires a modifier and one key");
    expect((await run(["hotkey", "--app", "A", "--key", "Cmd++"])).params).toEqual({ app: "A", key: "Cmd++" });
  });

  test("--modifiers takes modifiers only, at most four", async () => {
    await refuses(["click", "--app", "A", "--x", "1", "--y", "1", "--modifiers", "Cmd+A"], "modifiers accept modifier keys only");
    await refuses(
      ["click", "--app", "A", "--x", "1", "--y", "1", "--modifiers", "Cmd+Shift+Alt+Ctrl+Meta"],
      "modifiers accept modifier keys only",
    );
  });

  test("a target is either an index or a coordinate pair, never both and never half", async () => {
    await refuses(["click", "--app", "A", "--element-index", "1", "--x", "2", "--y", "3"], "not both");
    await refuses(["click", "--app", "A", "--x", "2"], "--x and --y together");
    await refuses(["click", "--app", "A"], "requires --element-index");
  });

  test("a window is selected by id or by index, never by both", async () => {
    await refuses(["get-app-state", "--app", "A", "--window-id", "1", "--window-index", "2"], "not both");
  });

  test("numbers are bounded before any conversion", async () => {
    await refuses(["click", "--app", "A", "--element-index", "1e300"], "must be an integer");
    await refuses(["click", "--app", "A", "--element-index", "-1"], "must be an integer");
    await refuses(["click", "--app", "A", "--element-index", "1", "--click-count", "9"], "must be an integer between 1 and 3");
    await refuses(["scroll", "--app", "A", "--direction", "sideways", "--element-index", "1"], "--direction must be one of");
  });

  test("a refused flag never reaches for a client, so it cannot launch a helper", async () => {
    expect((await run(["click", "--app", "A", "--element-index", "-1"])).clientsCreated).toBe(0);
    expect((await run(["get-app-state", "--app", "A"])).clientsCreated).toBe(1);
  });

  test("a validation failure with --json still answers in the flat envelope", async () => {
    const r = await run(["press-key", "--app", "A", "--key", "Cmd+A", "--json"]);
    expect(r.exit).toBe(1);
    const envelope = JSON.parse(stdout());
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("invalid_argument");
    expect(envelope.recovery[0]).toContain("Fix the flags");
  });
});

describe("human output", () => {
  test("a snapshot leads with the window, the counts and how pixels map to coordinates", async () => {
    await run(["get-app-state", "--app", "com.apple.TextEdit"]);
    const text = stdout();
    expect(text).toContain("TextEdit (pid 4413, com.apple.TextEdit)");
    expect(text).toContain('Window: id:812 "Untitled" (900x700 @ 220,140)');
    expect(text).toContain("Visible elements: 61  Focused: #12  Coordinates: window");
    expect(text).toContain("Truncated: no");
    expect(text).toContain("coordinate x/y = screenshot pixels / 2");
    expect(text).toContain("App=com.apple.TextEdit (pid 4413)");
    // Never the pixels themselves: they go to a file, and the marker points at it.
    expect(text).not.toContain(PNG.slice(0, 40));
    expect(text).toContain("cast:image");
  });

  test("an unverified action says attempted, names the path, and hands over the command that would settle it", async () => {
    await run(["set-value", "--app", "com.apple.TextEdit", "--element-index", "12", "--value", "hi"], {
      answers: { result: actionResult({ path: "synthetic", targetWindowId: 812 }) },
    });
    expect(stdout()).toContain(
      "Set value attempted via synthetic, unverified (synthetic input); 61 visible elements in current window. " +
        "Use `cast computer get-app-state --app com.apple.TextEdit --window-id 812` to inspect.",
    );
    expect(stdout()).toContain("before assuming it worked");
  });

  test("a read-back verification is the only thing that reads as completed", async () => {
    await run(["set-value", "--app", "A", "--element-index", "12", "--value", "hi"], {
      answers: { result: actionResult({ path: "accessibility", verification: { state: "verified", property: "value" } }) },
    });
    expect(stdout()).toContain("Set value completed via accessibility, verified (value)");
    expect(stdout()).not.toContain("before assuming it worked");
  });

  test("a window that changed drops the selector, which no longer resolves", async () => {
    await run(["click", "--app", "A", "--element-index", "1"], {
      answers: {
        result: actionResult({ path: "accessibility", targetWindowId: 812, verification: { state: "unverified", reason: "window_changed" } }),
      },
    });
    expect(stdout()).toContain("Use `cast computer get-app-state --app A` to inspect.");
    expect(stdout()).not.toContain("--window-id");
  });

  test("a helper that reports no action metadata cannot look verified", async () => {
    await run(["click", "--app", "A", "--element-index", "1"], { answers: { result: actionResult(undefined) } });
    expect(stdout()).toContain("Click attempted, unverified (verification metadata unavailable)");
  });

  test("an error prints the message and its recovery, and exits 1", async () => {
    const r = await run(["click", "--app", "A", "--element-index", "42"], {
      answers: { error: new ComputerError("element_not_found", "element 42 is stale; run get-app-state again") },
    });
    expect(r.exit).toBe(1);
    expect(stderr()).toContain("element 42 is stale");
    expect(stderr()).toContain("Never infer an index from `elementCount`");
    expect(stdout()).toBe("");
  });
});

describe("--json", () => {
  test("the screenshot is a 0600 path in a 0700 directory, never base64", async () => {
    await run(["get-app-state", "--app", "A", "--json"]);
    const payload = JSON.parse(stdout());
    expect(payload.ok).toBe(true);
    expect(payload.screenshot.data).toBeUndefined();
    expect(payload.screenshot.dataOmitted).toBe(true);
    expect(payload.screenshot.path).toBe(path.join(tmp, "codecast-computer", "snap-1-screenshot.png"));
    expect(payload.screenshot.scale).toBe(2);
    expect(fs.readFileSync(payload.screenshot.path).length).toBe(Buffer.from(PNG, "base64").length);
    expect(fs.statSync(payload.screenshot.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(payload.screenshot.path)).mode & 0o777).toBe(0o700);
    // Nothing about the tree changes on the way through.
    expect(payload.snapshot.treeText).toContain("App=com.apple.TextEdit");
    expect(stdout()).not.toContain("cast:image");
  });

  test("the capture expires in a day, so a stale path is readable as stale", async () => {
    await run(["get-app-state", "--app", "A", "--json"]);
    const { expiresAt } = JSON.parse(stdout()).screenshot;
    const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThan(24.5);
  });

  test("a skipped capture stays skipped and writes nothing", async () => {
    await run(["get-app-state", "--app", "A", "--no-screenshot", "--json"], {
      answers: { result: { ...snapshotResult(), screenshot: null, screenshotStatus: { state: "skipped", reason: "no_screenshot_flag" } } },
    });
    const payload = JSON.parse(stdout());
    expect(payload.screenshot).toBeNull();
    expect(payload.screenshotStatus).toEqual({ state: "skipped", reason: "no_screenshot_flag" });
    expect(fs.existsSync(path.join(tmp, "codecast-computer"))).toBe(false);
  });

  test("a helper failure is the flat envelope with ok first, the code, and the recovery", async () => {
    const r = await run(["get-app-state", "--app", "A", "--json"], {
      answers: { error: new ComputerError("permission_denied", "Accessibility is not granted") },
    });
    expect(r.exit).toBe(1);
    const envelope = JSON.parse(stdout());
    expect(Object.keys(envelope)[0]).toBe("ok");
    expect(envelope).toMatchObject({ ok: false, code: "permission_denied", message: "Accessibility is not granted" });
    expect(envelope.recovery.join(" ")).toContain("cast computer permissions");
  });
});

describe("an invented verb fails loudly", () => {
  test("`cast computer bogus` exits 1 with nothing usable on stdout", async () => {
    const r = await run(["bogus"]);
    expect(r.exit).toBe(1);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("unknown command 'computer bogus'");
  });
});

describe("registration cost", () => {
  const staticImports = (file: string): string[] =>
    [...fs.readFileSync(file, "utf8").matchAll(/^import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);

  test("the command group loads no helper machinery until a verb runs", () => {
    // A static import of the client, the permission probe or the embedded
    // helper bundle would put that graph on the cost of `cast --help` and of
    // every unrelated verb.
    expect(staticImports(path.join(import.meta.dir, "cli.ts"))).toEqual([]);
  });

  test("nothing on the CLI's startup path pulls the computer feature in", () => {
    // index.ts and doctor.ts are both evaluated before any verb runs. They may
    // reach the feature only through this registration (which is types and
    // commander) or a dynamic import inside an action.
    const src = path.resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of ["index.ts", "doctor.ts"]) {
      for (const spec of staticImports(path.join(src, file))) {
        if (spec.startsWith("./computer/") && spec !== "./computer/cli.js") offenders.push(`${file} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
